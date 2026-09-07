// Formatting utilities. Persian number/count/time formatting lives in
// persianUtils.js; this module re-exports everything under one roof so
// components can import from a single place.

export {
    toPersianDigits,
    formatViewCount,
    formatDuration,
    formatTimeAgo,
    formatSubscriberCount,
    getPersianSearchSuggestions
} from './persianUtils.js';
