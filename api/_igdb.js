// ==========================================================
// /api/_igdb.js — Helper partagé pour l'API IGDB (Twitch)
// Utilisé par generate-daily.js (puzzle du jour) ET search-games.js
// (autocomplétion des essais) : un seul endroit pour l'auth et les
// requêtes IGDB, pour éviter la duplication entre les deux fichiers.
// Doc : https://api-docs.igdb.com
// ==========================================================

export const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim() || null;
export const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim() || null;

const IGDB_BASE = 'https://api.igdb.com/v4';
let igdbTokenCache = { token: null, expiresAt: 0 };

export async function getIgdbToken() {
    if (igdbTokenCache.token && Date.now() < igdbTokenCache.expiresAt - 60000) {
        return igdbTokenCache.token;
    }
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`Twitch OAuth a répondu ${res.status}`);
    const data = await res.json();
    igdbTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return igdbTokenCache.token;
}

export async function igdbQuery(endpoint, body, timeoutMs = 3000) {
    const token = await getIgdbToken();
    const res = await fetch(`${IGDB_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`IGDB a répondu ${res.status}`);
    return res.json();
}

export function isIgdbConfigured() {
    return !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
}
