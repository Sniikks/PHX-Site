// ==========================================================
// /api/_pixelpool.js — Bibliothèque partagée (non exposée en HTTP,
// le préfixe "_" empêche Vercel d'en faire une route).
//
// Pioche un jeu CONNU (≥ 10 000 propriétaires estimés via SteamSpy),
// sans DLC/extension/réédition, et renvoie sa jaquette IGDB en base64.
// Utilisé par pixels-state.js (1re génération) et pixels-action.js
// (manche suivante / nouvelle partie).
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const COVER_URL = id => `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${id}.jpg`;
const MIN_OWNERS = 10000;
const IGDB_TIMEOUT_MS = 8000;

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
// 1=dlc_addon, 3=bundle, 5=mod, 6=episode, 7=season, 9=remaster, 13=pack, 14=update
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

function isUnwantedName(name) {
    if (!name) return true;
    if (DLC_NAME_PATTERN.test(name)) return true;
    if (/\bpack\b/i.test(name) && !/party pack/i.test(name)) return true;
    return false;
}
function isUnwantedIgdb(game) {
    if (EXCLUDED_CATEGORIES.has(game.category)) return true;
    return isUnwantedName(game.name);
}

function parseOwnersLowerBound(ownersStr) {
    if (!ownersStr) return null;
    const match = ownersStr.match(/[\d,]+/);
    if (!match) return null;
    const n = parseInt(match[0].replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
}

async function fetchSteamSpyPool(excludeNamesLower) {
    const roll = Math.random();
    let url;
    if (roll < 0.35) url = `${STEAMSPY_BASE}?request=top100forever`;
    else if (roll < 0.6) url = `${STEAMSPY_BASE}?request=top100in2weeks`;
    else url = `${STEAMSPY_BASE}?request=all&page=${Math.floor(Math.random() * 40)}`;

    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Object.values(data || {})
        .filter(g => g && g.name)
        .map(g => ({ name: g.name, owners: parseOwnersLowerBound(g.owners) }))
        .filter(g => g.owners !== null && g.owners >= MIN_OWNERS)
        .filter(g => !isUnwantedName(g.name))
        .filter(g => !excludeNamesLower.has(g.name.trim().toLowerCase()));
}

async function igdbQueryWithRetry(endpoint, body, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return await igdbQuery(endpoint, body, IGDB_TIMEOUT_MS); }
        catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, 400)); }
    }
    throw lastErr;
}

async function fetchIgdbCover(name) {
    const cleanName = name.replace(/["\\]/g, '');
    const body = `search "${cleanName}"; fields name, category, cover.image_id; where version_parent = null; limit 5;`;
    let results;
    try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
    if (!Array.isArray(results) || !results.length) return null;

    const normalized = cleanName.trim().toLowerCase();
    const candidates = results.filter(r => !isUnwantedIgdb(r) && r.cover?.image_id);
    const best = candidates.find(r => (r.name || '').trim().toLowerCase() === normalized) || candidates[0];
    return best ? { name: best.name, coverId: best.cover.image_id } : null;
}

// excludeNames : tableau de noms déjà vus dans la partie en cours (anti-doublon).
export async function pickGameWithCover(excludeNames = [], maxAttempts = 8) {
    if (!isIgdbConfigured()) return null;
    const excludeLower = new Set(excludeNames.map(n => n.trim().toLowerCase()));
    for (let i = 0; i < maxAttempts; i++) {
        const pool = await fetchSteamSpyPool(excludeLower);
        if (!pool.length) continue;
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        const found = await fetchIgdbCover(candidate.name);
        if (found && !excludeLower.has(found.name.trim().toLowerCase())) return found;
    }
    return null;
}

export async function fetchImageAsDataUri(coverId) {
    const res = await fetch(COVER_URL(coverId));
    if (!res.ok) throw new Error(`Image IGDB a répondu ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
}

// Comparaison floue essai <-> nom réel (mêmes règles que côté client).
export function normalize(str) {
    return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}
export function isCorrectGuess(guessRaw, name) {
    const guess = normalize(guessRaw);
    if (guess.length < 2) return false;
    const target = normalize(String(name || '').replace(/\s*\(\d{4}\)\s*$/, ''));
    if (guess === target) return true;
    const maxLen = Math.max(guess.length, target.length);
    const threshold = maxLen <= 8 ? 1 : (maxLen <= 14 ? 2 : 3);
    return levenshtein(guess, target) <= threshold;
}
