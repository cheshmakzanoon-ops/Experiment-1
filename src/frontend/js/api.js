// api.js — the single frontend networking layer.
//
// Server access is protected by an HttpOnly same-origin session cookie.
// No secret ever reaches this JavaScript and no secret ever appears in a
// URL — <video> and <img> requests carry the cookie automatically.
//
// Behaviour:
//   • every request goes through apiFetch(), which adds same-origin
//     credentials, an endpoint timeout and — for idempotent GETs only —
//     bounded retries with jittered delay,
//   • a 401 opens the Persian access-key gate (once); after a successful
//     login the failed request is retried a single time,
//   • failures are classified so callers can tell apart: offline/network,
//     timeout, not-authorized, rate-limited, server unavailable (5xx),
//     video-not-found (404), temporary YouTube block and other 4xx,
//   • Retry-After is honoured when the server tells us to wait.
//
// Retry policy: no retry storms — auth failures and invalid requests are
// never retried; only network errors/timeouts and 429/502/503/504 for
// idempotent GETs, with a small budget.

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
    aborted: 'درخواست لغو شد'
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
// Session state + gate
// ---------------------------------------------------------------------------

let authMode = 'unknown'; // 'session' | 'disabled'
let sessionStatePromise = null;

async function fetchSessionState() {
    if (!sessionStatePromise) {
        sessionStatePromise = fetch(`${API_BASE}/session`, { credentials: 'same-origin' })
            .then((response) => (response.ok ? response.json() : { authenticated: false }))
            .catch(() => ({ authenticated: false }))
            .then((data) => {
                if (data && data.authMode === 'disabled') authMode = 'disabled';
                else authMode = 'session';
                return data;
            })
            .finally(() => {
                sessionStatePromise = null;
            });
    }
    return sessionStatePromise;
}

/** Server has session enforcement enabled. */
export function sessionEnforced() {
    return authMode !== 'disabled';
}

/** Attempt a household login with the provided access key. */
export async function loginWithKey(key) {
    const response = await fetch(`${API_BASE}/session`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
    });
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
    authMode = 'session';
    document.dispatchEvent(new CustomEvent('auth:changed', { detail: { authenticated: true } }));
    return true;
}

/** Log out (expires the cookie server-side). */
export async function logout() {
    try {
        await fetch(`${API_BASE}/session`, { method: 'DELETE', credentials: 'same-origin' });
    } catch {
        // offline — nothing else to do
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

    const attempt = async () => {
        const key = (input.value || '').trim();
        if (!key) return;
        errorEl.hidden = true;
        submit.disabled = true;
        try {
            await loginWithKey(key);
            hideGate();
            resolveGateWaiters(true);
        } catch (error) {
            submit.disabled = false;
            errorEl.hidden = false;
            errorEl.textContent = error instanceof ApiError ? error.message : 'ورود ممکن نشد';
            input.value = '';
            input.focus();
            gateShown = false; // allow re-prompt on a later attempt
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

function jitteredDelay(baseMs, attempt) {
    const backoff = baseMs * Math.pow(2, attempt);
    return backoff / 2 + Math.random() * (backoff / 2);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Central fetch: retries idempotent GETs on transient failures, re-runs
 * once after a successful login, throws classified ApiError otherwise.
 */
export async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const idempotent = method === 'GET' || method === 'HEAD';

    const doFetch = async (signal) => {
        const response = await fetch(url, {
            method,
            headers: options.headers || {},
            body: options.body,
            credentials: 'same-origin',
            cache: options.cache || 'default',
            signal
        });

        if (response.status === 401 && authMode !== 'disabled') {
            await response.body?.cancel?.().catch(() => {});
            const ok = await ensureAuthenticatedOnce();
            if (!ok) throw new ApiError('unauthorized', { status: 401 });
            // One retry with the fresh session cookie.
            const retried = await fetch(url, {
                method,
                headers: options.headers || {},
                body: options.body,
                credentials: 'same-origin',
                cache: options.cache || 'default',
                signal
            });
            return retried;
        }
        return response;
    };

    let lastError = null;
    for (let attemptNumber = 0; attemptNumber <= MAX_RETRIES; attemptNumber++) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const onCallerAbort = () => controller.abort();
        if (options.signal) {
            if (options.signal.aborted) {
                clearTimeout(timer);
                throw new ApiError('aborted', { status: 0 });
            }
            options.signal.addEventListener('abort', onCallerAbort, { once: true });
        }

        try {
            const response = await doFetch(controller.signal);
            if (response.ok || response.status === 206) return response;

            const error = classifyStatus(response.status, response);
            const retryable = idempotent && RETRYABLE_STATUSES.has(response.status);
            if (retryable && attemptNumber < MAX_RETRIES) {
                const wait = error.retryAfterSeconds
                    ? Math.min(error.retryAfterSeconds * 1000, 8000)
                    : jitteredDelay(800, attemptNumber);
                await sleep(wait);
                lastError = error;
                continue;
            }
            throw error;
        } catch (error) {
            if (error instanceof ApiError) {
                lastError = error;
                if (error.kind === 'aborted' || !idempotent) throw error;
                if ((error.kind === 'offline' || error.kind === 'timeout' || error.kind === 'serverUnavailable' || error.kind === 'rateLimited') &&
                    attemptNumber < MAX_RETRIES) {
                    const wait = error.retryAfterSeconds
                        ? Math.min(error.retryAfterSeconds * 1000, 8000)
                        : jitteredDelay(800, attemptNumber);
                    await sleep(wait);
                    continue;
                }
                throw error;
            }
            lastError = classifyNetworkError(error, timedOut);
            if (idempotent && attemptNumber < MAX_RETRIES) {
                await sleep(jitteredDelay(800, attemptNumber));
                continue;
            }
            throw lastError;
        } finally {
            clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
        }
    }
    throw lastError || new ApiError('permanent');
}

/** 401 handler: resolve the session (gate) once; single retry follows. */
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

// ---------------------------------------------------------------------------
// Convenience helpers used by services
// ---------------------------------------------------------------------------

/** GET + parse JSON body (throws classified ApiError). */
export async function apiGetJson(path, options = {}) {
    const response = await apiFetch(path, options);
    return response.json();
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
