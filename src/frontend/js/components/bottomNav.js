// Bottom navigation handling. The markup lives in index.html; this module
// exposes the page list and helpers so app.js / page modules stay in sync.
// (app.js currently inlines equivalent logic; this is the shared definition
// for the follow-up phases.)

export const NAV_PAGES = [
    { page: 'home', icon: 'home', label: 'آغاز' },
    { page: 'shorts', icon: 'shorts', label: 'Shorts' },
    { page: 'create', icon: 'add_circle', label: '', plus: true },
    { page: 'subscriptions', icon: 'subscriptions', label: 'اشتراک‌ها' },
    { page: 'library', icon: 'video_library', label: 'کتابخانه' }
];

/**
 * Highlight the nav item for `page`.
 * @param {string} page
 */
export function setActiveNav(page) {
    document.querySelectorAll('.nav-item').forEach((item) => {
        item.classList.toggle('nav-item--active', item.dataset.page === page);
    });
}

/**
 * Attach a click handler to the bottom navigation.
 * @param {(page: string) => void} onNavigate
 */
export function initBottomNav(onNavigate) {
    const nav = document.querySelector('.bottom-navigation');
    if (!nav) return;
    nav.addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item');
        if (item) onNavigate(item.dataset.page);
    });
}
