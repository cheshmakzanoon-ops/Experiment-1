// API communication layer — all requests to /api/* carry the API key.
//
// The key can reach the frontend three ways (first match wins):
//   1. window.APP_CONFIG.apiKey   — injected by the host/template at serve time
//   2. /api/config                — public bootstrap endpoint (auto-stored)
//   3. localStorage 'apiKey'      — typed into the Persian setup prompt
//
// When the server has no API_KEY configured (dev mode) authentication is
// disabled server-side, so these helpers simply send no key and everything
// keeps working.

const API_BASE = '/api';

const STORAGE_KEY = 'apiKey';

// --- API key management -----------------------------------------------------

export function getApiKey() {
    // Global config set by a server-rendered template / runtime injection.
    if (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.apiKey) {
        return window.APP_CONFIG.apiKey;
    }
    // Stored after the first-time setup prompt.
    try {
        return localStorage.getItem(STORAGE_KEY) || null;
    } catch {
        return null;
    }
}

function setApiKey(key) {
    try {
        localStorage.setItem(STORAGE_KEY, key);
    } catch {
        // storage unavailable — requests below simply go out without a key
    }
}

/** Headers carrying the API key (empty when no key is known). */
export function authHeaders() {
    const key = getApiKey();
    const headers = {};
    if (key) headers['X-API-Key'] = key;
    return headers;
}

/**
 * The key as a query-string fragment ('?key=...' / '&key=...' / '').
 * Needed for <video src="..."> and <img src="..."> requests, which cannot
 * send custom headers.
 * @param {string} url URL that may already contain a query string
 */
export function keyParam(url = '') {
    const key = getApiKey();
    if (!key) return '';
    return (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(key)}`;
}

/** Append the API key query param to an existing URL. */
export function appendKey(url) {
    const param = keyParam(url);
    return param ? `${url}${param}` : url;
}

/**
 * Make an authenticated fetch. On 401 the Persian setup prompt is shown
 * (once per session) and the error is rethrown for the caller to handle.
 */
export async function apiFetch(url, options = {}) {
    // On a keyed deployment the very first request can race the /api/config
    // bootstrap — wait for it once before giving up to a 401.
    if (!getApiKey() && configPromise) {
        try {
            await configPromise;
        } catch {
            // offline / unreachable — the request below will reveal the truth
        }
    }

    const headers = {
        ...authHeaders(),
        ...(options.headers || {})
    };

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        showApiKeyPrompt();
        const error = new Error('Unauthorized: check API key');
        error.status = 401;
        throw error;
    }

    return response;
}

// --- API functions ----------------------------------------------------------

/**
 * Search for videos.
 * @param {string} query
 * @param {number} maxResults
 */
export async function searchVideos(query, maxResults = 8) {
    const response = await apiFetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&max=${maxResults}`
    );
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.results || [];
}

/** Get video metadata. */
export async function getVideoInfo(videoId) {
    const response = await apiFetch(`${API_BASE}/video/${videoId}`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
}

/**
 * Get the playable stream URL for a video. The API key travels in the URL
 * because the <video> element cannot send request headers.
 * @param {string} videoId
 * @param {string} [quality]
 */
export function getStreamUrl(videoId, quality) {
    const params = quality ? `?quality=${quality}` : '';
    const url = `${API_BASE}/stream/${encodeURIComponent(videoId)}${params}`;
    return appendKey(url);
}

/** Check server health. */
export async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        return response.ok;
    } catch {
        return false;
    }
}

// --- API key setup UI (Persian) --------------------------------------------

export function showApiKeyPrompt() {
    // Only show once per session.
    if (document.querySelector('.api-key-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'api-key-modal';
    modal.innerHTML = `
        <div class="api-key-modal__content">
            <h2>کلید API مورد نیاز است</h2>
            <p>برای استفاده از این برنامه، کلید API را وارد کنید:</p>
            <input type="text" id="apiKeyInput" placeholder="کلید API" class="api-key-input" dir="ltr" autocomplete="off">
            <button id="apiKeySubmit" class="api-key-submit">تأیید</button>
            <p class="api-key-hint">کلید را از پشتیبان برنامه دریافت کنید</p>
        </div>
    `;

    document.body.appendChild(modal);

    const input = document.getElementById('apiKeyInput');
    const submit = document.getElementById('apiKeySubmit');

    const confirm = () => {
        const key = (input && input.value || '').trim();
        if (!key) return;
        setApiKey(key);
        window.location.reload();
    };

    if (submit) submit.addEventListener('click', confirm);
    if (input) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') confirm();
        });
        input.focus();
    }
}

/**
 * First-load bootstrap: if the server publishes the key via /api/config
 * (a keyed deployment), store it so the user never sees the prompt. In dev
 * mode the server answers CONFIG_MISSING and we stay quiet — the app works
 * without a key and the prompt only appears if a real 401 ever happens.
 *
 * Starts immediately on module load (not on DOMContentLoaded) so the very
 * first feed/search requests can await it (see apiFetch).
 */
let configPromise = null;

function bootstrapApiKey() {
    if (typeof window === 'undefined') return;
    if (getApiKey()) {
        configPromise = Promise.resolve();
        return;
    }
    configPromise = fetch(`${API_BASE}/config`)
        .then((response) => (response.ok ? response.json() : null))
        .then((config) => {
            if (config && config.apiKey) setApiKey(config.apiKey);
        })
        .catch(() => {
            // Offline or unreachable — never nag; a real 401 will prompt.
        });
}

bootstrapApiKey();
