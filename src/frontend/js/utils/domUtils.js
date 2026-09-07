// Small DOM helpers used across components/pages.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Create an element with optional class and text.
 * @returns {HTMLElement}
 */
export function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** Remove all children of a node. */
export function clear(node) {
    if (node) node.innerHTML = '';
}

/** Create a material icon span. @returns {HTMLSpanElement} */
export function icon(name, className = '') {
    const span = document.createElement('span');
    span.className = `material-icons-round ${className}`.trim();
    span.textContent = name;
    return span;
}

/** Render the loading state (spinner + Persian label) into a container. */
export function showLoading(container, text = 'در حال بارگذاری...') {
    if (!container) return;
    container.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner"></div>
            <p>${text}</p>
        </div>
    `;
}

let toastTimer = null;

/**
 * Show a transient Persian toast at the bottom of the screen (YouTube style).
 * @param {string} message
 */
export function showToast(message) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    if (toastTimer) clearTimeout(toastTimer);

    const toast = el('div', 'toast', message);
    document.body.appendChild(toast);

    toastTimer = setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        toastTimer = null;
    }, 2500);
}

/** Render the error state into a container with a retry button. */
export function showError(container, message = 'خطا', onRetry = () => location.reload()) {
    if (!container) return;
    const errorBox = el('div', 'error-state');
    errorBox.appendChild(icon('error_outline'));
    errorBox.appendChild(el('p', '', message));
    const retry = el('button', '', 'تلاش مجدد');
    retry.addEventListener('click', onRetry);
    errorBox.appendChild(retry);
    container.innerHTML = '';
    container.appendChild(errorBox);
}
