// Quality selector (کیفیت ویدیو) — pick the stream quality used by the
// player. The choice is saved to localStorage so the next video opens at the
// same quality. Labels are Persian (۱۴۴p … ۴۸۰p); values are the ASCII ids
// the /api/stream proxy understands.

const QUALITIES = [
    { value: '144', label: '۱۴۴p', note: 'کمترین مصرف داده' },
    { value: '240', label: '۲۴۰p', note: 'پیشنهادی' },
    { value: '360', label: '۳۶۰p', note: 'کیفیت متوسط' },
    { value: '480', label: '۴۸۰p', note: 'بیشترین کیفیت' }
];

const STORAGE_KEY = 'preferredQuality';
const DEFAULT_QUALITY = '240';

export function getPreferredQuality() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && QUALITIES.some((q) => q.value === saved)) return saved;
    } catch {
        // storage unavailable — fall through to the default
    }
    return DEFAULT_QUALITY;
}

export function setPreferredQuality(quality) {
    if (!quality || !QUALITIES.some((q) => q.value === quality)) return;
    try {
        localStorage.setItem(STORAGE_KEY, quality);
    } catch {
        // non-critical
    }
}

/** Persian label for a quality value (e.g. '240' → '۲۴۰p'). */
export function qualityLabel(value) {
    const match = QUALITIES.find((q) => q.value === value);
    return match ? match.label : (value || DEFAULT_QUALITY) + 'p';
}

/**
 * Show a modal quality picker. `currentQuality` is the active value and
 * `onQualitySelected(value)` fires after the user picks one (or not at all
 * when they close the dialog).
 */
export function showQualitySelector(currentQuality, onQualitySelected) {
    if (document.querySelector('.quality-selector-overlay')) return;

    // Overlay + dialog
    const overlay = document.createElement('div');
    overlay.className = 'quality-selector-overlay';
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    const dialog = document.createElement('div');
    dialog.className = 'quality-selector';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'کیفیت ویدیو');

    const title = document.createElement('h3');
    title.textContent = 'کیفیت ویدیو';
    dialog.appendChild(title);

    QUALITIES.forEach((q) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `quality-option${q.value === currentQuality ? ' quality-option--active' : ''}`;
        option.setAttribute('aria-pressed', q.value === currentQuality ? 'true' : 'false');

        const label = document.createElement('span');
        label.className = 'quality-option__label';
        label.textContent = q.label;

        const note = document.createElement('span');
        note.className = 'quality-option__note';
        note.textContent = q.note;

        option.appendChild(label);
        option.appendChild(note);

        option.addEventListener('click', () => {
            setPreferredQuality(q.value);
            close();
            if (typeof onQualitySelected === 'function') onQualitySelected(q.value);
        });

        dialog.appendChild(option);
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'quality-close';
    closeButton.textContent = 'بستن';
    closeButton.addEventListener('click', close);
    dialog.appendChild(closeButton);

    function close() {
        overlay.remove();
        dialog.remove();
    }

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);
}
