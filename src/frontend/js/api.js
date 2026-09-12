// api.js — the single frontend networking layer.
//
// Server access is protected by an HttpOnly same-origin session cookie.
// No secret ever reaches this JavaScript and no secret ever appears in a
// URL — <video> and <img> requests carry the cookie automatically.
//
// Behaviour (R5):
//   • every request goes through apiFetch(), which adds same-origin
//     credentials, an endpoint deadline and — for idempotent GETs only —
//     bounded retries with jittered, abort-aware delay,
//   • apiFetch returns the RAW Response (media diagnostics keep streaming
//     ownership); JSON consumers go through apiGetJson(), whose deadline
//     covers headers + a COUNTED body read (2 MiB cap) + decoding + parsing
//     — an idle/stalled body can never hang a caller forever,
//   • a 401 opens the Persian access-key gate (once); after a successful
//     login the failed request is retried ONCE on a FRESH controller (never
//     one that expired while the gate was open); a second 401 surfaces
//     explicitly instead of looping,
//   • Retry-After is honoured honestly: when the server asks for longer
//     than the interaction budget, the error is surfaced (countdown /
//     manual retry) instead of being silently shortened into a fast retry,
//   • failures are classified so callers can tell apart: offline/network,
//     timeout, not-authorized, rate-limited, server unavailable (5xx),
//     video-not-found (404), temporary YouTube block, oversized body,
//     malformed JSON and other 4xx.

const API_BASE = '/api';

// ---------------------------------------------------------------------------
// Error taxonomy (browser-visible, no backend internals)
// ---------------------------------------------------------------------------

export const ERROR_LABELS = {
    offline: 'اتصال اینترنت برقرار نیست',
    timeout: 'سرور دیر پاسخ داد — دوباره تلاش کنید',
    unauthorized: 'برای مشاهده این بخش باید وارد شوید',
    youtubeBlocked: 'یوتیوب موقتاً درخواست را رد کرد — کمی بعد تلاش کنید',
    notFound: 'این محتوا در دسترس نیست',
    rateLimited: 'سرور شلوغ است — کمی بعد دوباره تلاش کنید',
    serverUnavailable: 'سرور در دسترس نیست — کمی بعد تلاش کنید',
    permanent: 'خطا در دریافت اطلاعات',
    aborted: 'درخواست لغو شد',
    tooLarge: 'پاسخ سرور بیش از حد بزرگ بود',
    malformed: 'پاسخ سرور نامعتبر بود — دوباره تلاش کنید',
    // Offline-download taxonomy (technical codes stable, messages Persian):
    rangeUnsupported: 'سرور دانلود بخشی را پشتیبانی نمی‌کند',
    rangeInvalid: 'پاسخ دانلود نامعتبر بود',
    rangeTotalUnknown: 'اندازه فایل مشخص نیست — دانلود ممکن نیست',
    sourceChanged: 'نسخه ویدیو در سرور تغییر کرد',
    storage: 'فضای ذخیره‌سازی پر است یا در دسترس نیست',
    authStorage: 'ذخیره نشست در دسترس نیست — کمی بعد وارد شوید'
};

export class ApiError extends Error {
    constructor(kind, options = {}) {
        super(ERROR_LABELS[kind] || ERROR_LABELS.permanent);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = options.status || 0;
        this.retryAfterSeconds = options.retryAfterSeconds || 0;
        this.cause = options.cause;
    }
}

function classifyStatus(status, response) {
    const retryAfter = Number(response?.headers?.get('Retry-After')) || 0;
    if (status === 401) return new ApiError('unauthorized', { status });
    if (status === 403) return new ApiError('youtubeBlocked', { status });
    if (status === 404) return new ApiError('notFound', { status });
    if (status === 429) return new ApiError('rateLimited', { status, retryAfterSeconds: retryAfter });
    if (status >= 500) return new ApiError('serverUnavailable', { status });
    return new ApiError('permanent', { status });
}

function classifyNetworkError(error, timedOut) {
    if (timedOut) return new ApiError('timeout', { cause: error });
    return new ApiError('offline', { cause: error });
}

// ---------------------------------------------------------------------------
// Bounded JSON body reader (R5): headers + counted body + parse
// ---------------------------------------------------------------------------

/**
 * Default JSON body cap. A declared Content-Length above this is refused
 * BEFORE any byte is read; undeclared bodies are counted while streaming
 * and aborted at the cap. Explicit per-endpoint overrides must be justified.
 */
const JSON_BODY_CAP_BYTES = 2 * 1024 * 1024;
/** Idle deadline: no body bytes for this long → the read fails finitely. */
const BODY_IDLE_DEADLINE_MS = 15_000;

function monotonicNow() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * Consume `response` as JSON under a bounded operation:
 *   - rejects an oversized DECLARED body before reading,
 *   - counts every byte and aborts past `capBytes`,
 *   - fails finitely when the body stalls (idle deadline) or when the
 *     optional overall startup budget (`remainingBudgetMs`) expires,
 *   - malformed JSON becomes a typed NONRETRYABLE failure,
 *   - every timer/reader is cleaned up in `finally`.
 */
async function readJsonBounded(response, options = {}) {
    const capBytes = options.capBytes ?? JSON_BODY_CAP_BYTES;
    const idleMs = options.idleMs ?? BODY_IDLE_DEADLINE_MS;
    const overallAt = typeof options.remainingBudgetMs === 'number'
        ? monotonicNow() + options.remainingBudgetMs
        : null;

    const declared = Number(response?.headers?.get('Content-Length'));
    if (Number.isFinite(declared) && declared > capBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw new ApiError('tooLarge', { status: response.status });
    }
    if (!response?.body) {
        throw new ApiError('malformed', { status: response?.status });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let idleTimer = null;
    try {
        for (;;) {
            if (overallAt !== null && monotonicNow() > overallAt) {
                throw new ApiError('timeout', { status: response.status });
            }
            const chunkPromise = reader.read();
            const result = await (idleMs > 0
                ? Promise.race([
                    chunkPromise,
                    new Promise((_resolve, rejectIdle) => {
                        idleTimer = setTimeout(() => rejectIdle(new Error('body idle deadline')), idleMs);
                        idleTimer.unref?.();
                    })
                ])
                : chunkPromise);
            clearTimeout(idleTimer);
            idleTimer = null;

            if (result.done) break;
            received += result.value?.byteLength || 0;
            if (received > capBytes) {
                await reader.cancel('json body cap exceeded').catch(() => {});
                throw new ApiError('tooLarge', { status: response.status });
            }
            chunks.push(result.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof ApiError) throw error;
        // Idle deadline / stream error → finite typed failure (not offline).
        throw new ApiError('timeout', { status: response.status, cause: error });
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }

    const text = new TextDecoder().decode(concatChunks(chunks, received));
    try {
        return JSON.parse(text);
    } catch (error) {
        // Malformed JSON is NOT network success and never retried.
        throw new ApiError('malformed', { status: response.status, cause: error });
    }
}

function concatChunks(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Session state + gate
// ---------------------------------------------------------------------------

let authMode = 'unknown'; // 'session' | 'disabled'
let sessionStatePromise = null;

const SESSION_STATE_DEADLINE_MS = 5_000;

async function fetchSessionState() {
    if (!sessionStatePromise) {
        sessionStatePromise = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SESSION_STATE_DEADLINE_MS);
            timer.unref?.();
            try {
                const response = await fetch(`${API_BASE}/session`, {
                    credentials: 'same-origin',
                    signal: controller.signal
                });
                // Bounded body: the session check has a 5 s OVERALL budget,
                // not merely a headers deadline.
                const data = response.ok
                    ? await readJsonBounded(response, {
                        remainingBudgetMs: SESSION_STATE_DEADLINE_MS,
                        idleMs: 0
                    })
                    : { authenticated: false };
                if (data && data.authMode === 'disabled') authMode = 'disabled';
                else authMode = 'session';
                return data;
            } catch {
                return { authenticated: false };
            } finally {
                clearTimeout(timer);
                sessionStatePromise = null;
            }
        })();
    }
    return sessionStatePromise;
}

/** Server has session enforcement enabled. */
export function sessionEnforced() {
    return authMode !== 'disabled';
}

const LOGIN_DEADLINE_MS = 15_000;

/**
 * Attempt a household login with the provided access key. One bounded POST
 * (15 s overall, headers + body); POSTs are NEVER automatically retried.
 * A network failure is NOT reported as a wrong key.
 */
export async function loginWithKey(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGIN_DEADLINE_MS);
    timer.unref?.();
    let response;
    try {
        response = await fetch(`${API_BASE}/session`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timer);
        // Network failure ≠ wrong key: a typed, recoverable offline error.
        if (controller.signal.aborted && !error?.name?.includes('Abort')) {
            throw new ApiError('timeout', { cause: error });
        }
        if (error && error.name === 'AbortError') {
            throw new ApiError('timeout', { cause: error });
        }
        throw new ApiError('offline', { cause: error });
    }

    try {
        if (response.status === 401) {
            const error = new ApiError('unauthorized', { status: 401 });
            error.message = 'کلید دسترسی اشتباه است';
            throw error;
        }
        if (response.status === 429) {
            throw new ApiError('rateLimited', {
                status: 429,
                retryAfterSeconds: Number(response.headers.get('Retry-After')) || 30
            });
        }
        if (!response.ok) {
            const error = new ApiError('permanent', { status: response.status });
            error.message = 'ورود ممکن نشد';
            throw error;
        }
        await readJsonBounded(response, { remainingBudgetMs: LOGIN_DEADLINE_MS }).catch(() => ({}));
        authMode = 'session';
        document.dispatchEvent(new CustomEvent('auth:changed', { detail: { authenticated: true } }));
        return true;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Log out (server-side allowlist removal + cookie expiry). Checks the
 * DELETE response: server storage failure must surface instead of always
 * announcing a successful logout. Error-body parsing is bounded too.
 */
export async function logout() {
    let response = null;
    try {
        response = await fetch(`${API_BASE}/session`, { method: 'DELETE', credentials: 'same-origin' });
    } catch (error) {
        throw new ApiError('offline', { cause: error });
    }
    if (!response.ok) {
        let body = {};
        try {
            body = (await readJsonBounded(response, { idleMs: 5_000 })) || {};
        } catch {
            body = {};
        }
        if (response.status === 503 && body && body.code === 'AUTH_STORAGE_UNAVAILABLE') {
            const error = new ApiError('authStorage', { status: 503 });
            error.code = 'AUTH_STORAGE_UNAVAILABLE';
            throw error;
        }
        throw new ApiError(response.status === 401 ? 'unauthorized' : 'serverUnavailable', { status: response.status });
    }
    document.dispatchEvent(new CustomEvent('auth:changed', { detail: { authenticated: false } }));
}

// ---------------------------------------------------------------------------
// Access-key gate UI (Persian) — no secret is stored client-side
// ---------------------------------------------------------------------------

let gateShown = false;
const gateWaiters = [];

function resolveGateWaiters(ok) {
    while (gateWaiters.length > 0) gateWaiters.shift()(ok);
}

function buildGate() {
    const host = document.getElementById('authGate');
    if (!host) return;
    host.innerHTML = `
        <div class="auth-gate">
            <div class="auth-gate__card">
                <div class="auth-gate__logo"><span class="material-icons-round">home</span></div>
                <h1>برنامه خانواده</h1>
                <p>برای استفاده از این برنامه، کلید دسترسی خانواده را وارد کنید.</p>
                <input type="password" id="authGateKey" class="auth-gate__input"
                       placeholder="کلید دسترسی" autocomplete="off" dir="ltr" inputmode="text">
                <p class="auth-gate__error" id="authGateError" hidden></p>
                <button type="button" id="authGateSubmit" class="auth-gate__submit">ورود</button>
            </div>
        </div>
    `;
    const input = document.getElementById('authGateKey');
    const submit = document.getElementById('authGateSubmit');
    const errorEl = document.getElementById('authGateError');
    let submitting = false;

    const attempt = async () => {
        // Duplicate Enter/click submissions are blocked while one is in
        // flight; the submit button is re-enabled in `finally`.
        if (submitting) return;
        const key = (input.value || '').trim();
        if (!key) return;
        submitting = true;
        errorEl.hidden = true;
        submit.disabled = true;
        try {
            await loginWithKey(key);
            hideGate();
            resolveGateWaiters(true);
        } catch (error) {
            errorEl.hidden = false;
            errorEl.textContent = error instanceof ApiError ? error.message : 'ورود ممکن نشد';
            input.value = '';
            input.focus();
            gateShown = false; // allow re-prompt on a later attempt
        } finally {
            submitting = false;
            submit.disabled = false;
        }
    };
    submit.addEventListener('click', attempt);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') attempt();
    });
    input.focus();
}

function showGate() {
    if (gateShown || document.querySelector('.auth-gate')) return;
    gateShown = true;
    buildGate();
}

function hideGate() {
    const host = document.getElementById('authGate');
    if (host) host.innerHTML = '';
    gateShown = false;
}

function waitForAuth() {
    if (!document.querySelector('.auth-gate')) showGate();
    return new Promise((resolve) => gateWaiters.push(resolve));
}

/**
 * Boot helper: when the server enforces sessions and none exists yet, show
 * the gate immediately (before the first feed request avoids a 401 wall).
 */
export async function ensureSession() {
    const state = await fetchSessionState();
    if (authMode === 'disabled' || (state && state.authenticated)) return true;
    return waitForAuth();
}

// ---------------------------------------------------------------------------
// Resilient fetch core
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
/** Interaction budget: a server Retry-After longer than this is surfaced
 * (countdown / manual retry) instead of being silently shortened. */
const MAX_AUTO_RETRY_WAIT_MS = 8_000;

function jitteredDelay(baseMs, attempt) {
    const backoff = baseMs * Math.pow(2, attempt);
    return backoff / 2 + Math.random() * (backoff / 2);
}

/** Abort-aware sleep: caller cancellation during backoff settles promptly. */
function abortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Central fetch: retries idempotent GETs on transient failures, re-runs
 * once after a successful login (on a FRESH controller), throws classified
 * ApiError otherwise. Contract: the RAW Response is returned (or a typed
 * error) — body consumption belongs to the caller (apiGetJson owns the
 * bounded JSON operation).
 */
export async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const idempotent = method === 'GET' || method === 'HEAD';

    const rawFetch = (signal) => fetch(url, {
        method,
        headers: options.headers || {},
        body: options.body,
        credentials: 'same-origin',
        cache: options.cache || 'default',
        signal
    });

    let lastError = null;
    for (let attemptNumber = 0; attemptNumber <= MAX_RETRIES; attemptNumber++) {
        const controller = new AbortController();
        let timedOut = false;
        let timer = null;
        const onCallerAbort = () => controller.abort();
        if (options.signal) {
            if (options.signal.aborted) {
                // A pre-aborted signal prevents the request entirely.
                throw new ApiError('aborted', { status: 0 });
            }
            options.signal.addEventListener('abort', onCallerAbort, { once: true });
        }

        try {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs);
            timer.unref?.();

            let response = await rawFetch(controller.signal);

            if (response.status === 401 && authMode !== 'disabled') {
                await response.body?.cancel?.().catch(() => {});
                // First 401: resolve the session once (gate). While the gate
                // is open the attempt deadline may expire — the retry below
                // therefore runs on a FRESH controller, never the expired one.
                const ok = await ensureAuthenticatedOnce();
                if (!ok) throw new ApiError('unauthorized', { status: 401 });
                // One retry with the fresh session cookie, new controller.
                clearTimeout(timer);
                timedOut = false;
                const retryController = new AbortController();
                const onRetryCallerAbort = () => retryController.abort();
                if (options.signal) {
                    if (options.signal.aborted) throw new ApiError('aborted', { status: 0 });
                    options.signal.addEventListener('abort', onRetryCallerAbort, { once: true });
                }
                const retryTimer = setTimeout(() => retryController.abort(), timeoutMs);
                retryTimer.unref?.();
                try {
                    response = await rawFetch(retryController.signal);
                } finally {
                    clearTimeout(retryTimer);
                    if (options.signal) options.signal.removeEventListener('abort', onRetryCallerAbort);
                }
            }

            if (response.ok || response.status === 206) {
                return response;
            }

            const error = classifyStatus(response.status, response);
            const retryable = idempotent && RETRYABLE_STATUSES.has(response.status);
            // A server wait longer than the interaction budget is surfaced
            // (countdown/manual retry) — never silently shortened into an 8 s
            // auto-retry.
            const waitExceedsBudget = error.retryAfterSeconds * 1000 > MAX_AUTO_RETRY_WAIT_MS;
            if (retryable && attemptNumber < MAX_RETRIES && !waitExceedsBudget) {
                await response.body?.cancel?.().catch(() => {}); // discard failed body before retrying
                const wait = error.retryAfterSeconds
                    ? error.retryAfterSeconds * 1000
                    : jitteredDelay(800, attemptNumber);
                await sleep(wait, options.signal);
                lastError = error;
                continue;
            }
            await response.body?.cancel?.().catch(() => {});
            throw error;
        } catch (error) {
            if (error instanceof ApiError) {
                lastError = error;
                if (error.kind === 'aborted') throw error;
                if (!idempotent) throw error;
                const retryableKinds = error.kind === 'offline' || error.kind === 'timeout' ||
                    error.kind === 'serverUnavailable' || error.kind === 'rateLimited';
                const waitExceedsBudget = error.retryAfterSeconds * 1000 > MAX_AUTO_RETRY_WAIT_MS;
                if (retryableKinds && attemptNumber < MAX_RETRIES && !waitExceedsBudget) {
                    const wait = error.retryAfterSeconds
                        ? error.retryAfterSeconds * 1000
                        : jitteredDelay(800, attemptNumber);
                    try {
                        await sleep(wait, options.signal);
                        continue;
                    } catch (sleepError) {
                        throw new ApiError('aborted', { cause: sleepError });
                    }
                }
                throw error;
            }
            // Preserve AbortError identity: a CALLER abort is 'aborted',
            // never rebranded as offline.
            if (error && error.name === 'AbortError' && options.signal?.aborted) {
                throw new ApiError('aborted', { cause: error });
            }
            lastError = classifyNetworkError(error, timedOut);
            if (idempotent && attemptNumber < MAX_RETRIES) {
                try {
                    await sleep(jitteredDelay(800, attemptNumber), options.signal);
                    continue;
                } catch (sleepError) {
                    throw new ApiError('aborted', { cause: sleepError });
                }
            }
            throw lastError;
        } finally {
            if (timer) clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
        }
    }
    throw lastError || new ApiError('permanent');
}

/** 401 handler: resolve the session (gate) once; a single retry follows. */
let authenticating = null;
function ensureAuthenticatedOnce() {
    if (!authenticating) {
        authenticating = fetchSessionState()
            .then((state) => {
                if (authMode === 'disabled') return true;
                if (state && state.authenticated) return true;
                return waitForAuth();
            })
            .finally(() => {
                authenticating = null;
            });
    }
    return authenticating;
}

function gateAbortError() {
    const error = new Error('Log-in cancelled');
    error.name = 'AbortError';
    return error;
}

/**
 * Wait for the shared login gate as a CALLER-CANCELLABLE subscription to
 * the shared authentication promise (R5):
 *   - INITIATES authentication (shows the gate) instead of passively
 *     appending itself to the waiter list,
 *   - already-authenticated resolves immediately,
 *   - caller abort removes only ITS subscription — other waiters keep
 *     waiting and the shared login interaction is never cancelled,
 *   - no race where authentication finishes before registration: the
 *     shared promise settles this subscription even if it resolved earlier.
 */
export function waitForGateOrAbort(signal) {
    if (signal && signal.aborted) {
        return Promise.reject(gateAbortError());
    }
    const authPromise = ensureAuthenticatedOnce();
    return new Promise((resolve, reject) => {
        let done = false;
        const onAbort = () => {
            if (done) return;
            done = true;
            const index = gateWaiters.indexOf(waiter);
            if (index >= 0) gateWaiters.splice(index, 1);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(gateAbortError());
        };
        const waiter = (ok) => {
            if (done) return;
            done = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(ok);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        gateWaiters.push(waiter);
        // Shared-promise settlement (already authenticated, or another
        // caller's login completed before/while we registered).
        authPromise.then(
            (ok) => waiter(ok === true),
            () => waiter(false)
        );
    });
}

// ---------------------------------------------------------------------------
// Convenience helpers used by services
// ---------------------------------------------------------------------------

/**
 * GET/POST + parse JSON with a BOUNDED operation covering headers, a
 * counted body read (2 MiB default cap), decoding and parsing.
 *
 * Options:
 *   - `timeoutMs`       — per-attempt headers deadline (apiFetch default),
 *   - `remainingBudgetMs` — startup-specific overall budget (playback
 *     metadata passes the player's remaining startup budget here instead
 *     of the ordinary feed timeout),
 *   - `capBytes`, `idleMs` — explicit, justified overrides only.
 *
 * Malformed JSON and oversized bodies are typed NONRETRYABLE failures.
 */
export async function apiGetJson(path, options = {}) {
    const response = await apiFetch(path, options);
    try {
        return await readJsonBounded(response, {
            capBytes: options.capBytes,
            idleMs: options.idleMs,
            remainingBudgetMs: options.remainingBudgetMs
        });
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('malformed', { status: response.status, cause: error });
    }
}

/** The player's stream URL (same origin; the session cookie authenticates). */
export function getStreamUrl(videoId, quality = '240') {
    return `${API_BASE}/stream/${encodeURIComponent(videoId)}?quality=${quality}`;
}

/** Best-effort health check (never throws). */
export async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health/live`, { signal: AbortSignal.timeout(5000) });
        return response.ok;
    } catch {
        return false;
    }
}

export default {
    apiFetch,
    apiGetJson,
    getStreamUrl,
    ensureSession,
    loginWithKey,
    logout,
    ApiError,
    ERROR_LABELS,
    sessionEnforced
};
