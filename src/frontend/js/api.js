// API communication layer

const API_BASE = '/api';

/**
 * Search for videos
 */
export async function searchVideos(query, maxResults = 8) {
    try {
        const response = await fetch(
            `${API_BASE}/search?q=${encodeURIComponent(query)}&max=${maxResults}`
        );
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data.results || [];
    } catch (error) {
        console.error('Search failed:', error);
        throw error;
    }
}

/**
 * Get video metadata
 */
export async function getVideoInfo(videoId) {
    try {
        const response = await fetch(`${API_BASE}/video/${videoId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('Failed to get video info:', error);
        throw error;
    }
}

/**
 * Get video stream URL
 */
export function getStreamUrl(videoId, quality) {
    const params = quality ? `?quality=${quality}` : '';
    return `${API_BASE}/stream/${videoId}${params}`;
}

/**
 * Check server health
 */
export async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        return response.ok;
    } catch (error) {
        return false;
    }
}
