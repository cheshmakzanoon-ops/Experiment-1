// Persian language utilities

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/**
 * Convert English digits to Persian digits
 */
export function toPersianDigits(input) {
    if (typeof input !== 'string' && typeof input !== 'number') {
        return input;
    }
    
    const str = String(input);
    let result = '';
    
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char >= '0' && char <= '9') {
            result += PERSIAN_DIGITS[parseInt(char)];
        } else {
            result += char;
        }
    }
    
    return result;
}

/**
 * Format view count in Persian
 * 1000 -> ۱ هزار
 * 1000000 -> ۱ میلیون
 * 1000000000 -> ۱ میلیارد
 */
export function formatViewCount(count) {
    if (!count || count === 0) return '۰ بازدید';
    
    const persianCount = toPersianDigits(count);
    
    if (count >= 1000000000) {
        return `${toPersianDigits((count / 1000000000).toFixed(1))} میلیارد بازدید`;
    } else if (count >= 1000000) {
        return `${toPersianDigits((count / 1000000).toFixed(1))} میلیون بازدید`;
    } else if (count >= 1000) {
        return `${toPersianDigits((count / 1000).toFixed(0))} هزار بازدید`;
    } else {
        return `${persianCount} بازدید`;
    }
}

/**
 * Format duration in Persian
 * 125 -> ۲:۰۵
 * 3661 -> ۱:۰۱:۰۱
 */
export function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '۰:۰۰';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    let result = '';
    
    if (hours > 0) {
        result += `${toPersianDigits(hours)}:`;
    }
    
    result += `${toPersianDigits(String(minutes).padStart(2, '0'))}:`;
    result += toPersianDigits(String(secs).padStart(2, '0'));
    
    return result;
}

/**
 * Format time ago in Persian
 */
export function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    
    const now = new Date();
    const past = new Date(timestamp);
    const diffMs = now - past;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);
    const diffYear = Math.floor(diffDay / 365);
    
    if (diffSec < 60) {
        return 'همین حالا';
    } else if (diffMin < 60) {
        return `${toPersianDigits(diffMin)} دقیقه پیش`;
    } else if (diffHour < 24) {
        return `${toPersianDigits(diffHour)} ساعت پیش`;
    } else if (diffDay < 7) {
        return `${toPersianDigits(diffDay)} روز پیش`;
    } else if (diffWeek < 4) {
        return `${toPersianDigits(diffWeek)} هفته پیش`;
    } else if (diffMonth < 12) {
        return `${toPersianDigits(diffMonth)} ماه پیش`;
    } else {
        return `${toPersianDigits(diffYear)} سال پیش`;
    }
}

/**
 * Format subscriber count in Persian
 */
export function formatSubscriberCount(count) {
    if (!count || count === 0) return '۰ مشترک';
    
    if (count >= 1000000) {
        return `${toPersianDigits((count / 1000000).toFixed(1))} میلیون مشترک`;
    } else if (count >= 1000) {
        return `${toPersianDigits((count / 1000).toFixed(0))} هزار مشترک`;
    } else {
        return `${toPersianDigits(count)} مشترک`;
    }
}

/**
 * Search suggestions in Persian
 */
export function getPersianSearchSuggestions(query) {
    // This would typically call the API
    // For now, return some common Persian suggestions
    const commonSuggestions = [
        'آهنگ جدید',
        'آموزش',
        'فیلم کامل',
        'مستند',
        'آشپزی',
        'ورزش',
        'خبر',
        'موزیک ویدیو',
        'کلیپ طنز',
        'سریال'
    ];
    
    return commonSuggestions.filter(s => 
        s.includes(query.toLowerCase())
    );
}
