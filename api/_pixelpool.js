// ==========================================================
// /api/_pixelpool.js — Bibliothèque partagée (non exposée en HTTP,
// le préfixe "_" empêche Vercel d'en faire une route).
//
// Même logique de pondération que ZoomJeu (api/generate-daily.js) :
//   - 80% du temps : un jeu Steam connu (50% top 500 approximé,
//     35% top 100 des 2 dernières semaines, 15% Steam plus obscur
//     mais ≥ 60 000 propriétaires estimés)
//   - 20% du temps : un jeu console/rétro via IGDB (55% de chances
//     d'être une plateforme vraiment rétro, 45% une plateforme
//     actuelle)
// Sans DLC/extension/réédition. Renvoie la jaquette IGDB en base64.
// Utilisé par pixels.js (état + action).
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';
import { isCorrectGuess as sharedIsCorrectGuess, normalize as sharedNormalize } from './_gamematch.js';

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const COVER_URL = id => `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${id}.jpg`;
const MIN_OWNERS = 60000;
const IGDB_TIMEOUT_MS = 8000;

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
// 1=dlc_addon, 3=bundle, 5=mod, 6=episode, 7=season, 9=remaster, 13=pack, 14=update
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

const NON_LATIN_SCRIPT_REGEX = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF\u0E00-\u0E7F\u0400-\u04FF]/;
function hasNonLatinScript(name) {
    return typeof name === 'string' && NON_LATIN_SCRIPT_REGEX.test(name);
}

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

// ───────────────────────── Pool Steam (jeux connus) ─────────────────────────

async function fetchSteamSpyGames(url, excludeNamesLower) {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Object.values(data || {})
        .filter(g => g && g.name && !hasNonLatinScript(g.name))
        .map(g => ({ name: g.name, owners: parseOwnersLowerBound(g.owners) }))
        .filter(g => g.owners !== null && g.owners >= MIN_OWNERS)
        .filter(g => !isUnwantedName(g.name))
        .filter(g => !excludeNamesLower.has(sharedNormalize(g.name)));
}

// SteamSpy n'expose pas d'endpoint "top 500" natif (seulement des tops figés
// à 100). On agrège plusieurs pages de "all" et on garde les 500 jeux avec
// le plus de propriétaires — mis en cache pour la durée de l'appel serverless.
let steamTop500Cache = null;
async function fetchSteamTop500(excludeNamesLower) {
    if (!steamTop500Cache) {
        let all = [];
        for (const page of [0, 1, 2]) {
            try {
                const res = await fetch(`${STEAMSPY_BASE}?request=all&page=${page}`);
                if (!res.ok) continue;
                const data = await res.json();
                const games = Object.values(data || {})
                    .filter(g => g && g.name && !hasNonLatinScript(g.name))
                    .map(g => ({ name: g.name, owners: parseOwnersLowerBound(g.owners) }));
                all = all.concat(games);
            } catch (e) { /* on continue avec les pages déjà récupérées */ }
        }
        all.sort((a, b) => (b.owners || 0) - (a.owners || 0));
        steamTop500Cache = all.slice(0, 500);
    }
    return steamTop500Cache
        .filter(g => !isUnwantedName(g.name))
        .filter(g => !excludeNamesLower.has(sharedNormalize(g.name)));
}

async function fetchSteamBigPool(excludeNamesLower) {
    const roll = Math.random();
    if (roll < 0.5) {
        return fetchSteamTop500(excludeNamesLower);
    } else if (roll < 0.85) {
        return fetchSteamSpyGames(`${STEAMSPY_BASE}?request=top100in2weeks`, excludeNamesLower);
    } else {
        const page = Math.floor(Math.random() * 5);
        return fetchSteamSpyGames(`${STEAMSPY_BASE}?request=all&page=${page}`, excludeNamesLower);
    }
}

// ───────────────────────── Pool IGDB (jeux consoles / rétro) ─────────────────────────

const IGDB_PLATFORM_GROUPS = {
    retro: [
        'PlayStation', 'PlayStation 2', 'PlayStation 3', 'PlayStation Portable',
        'Wii', 'Wii U', 'GameCube', 'Nintendo 64',
        'Nintendo DS', 'Nintendo 3DS',
        'Game Boy', 'Game Boy Advance', 'Xbox', 'Xbox 360'
    ],
    current: [
        'PC (Microsoft Windows)', 'PlayStation 4', 'PlayStation 5',
        'Xbox One', 'Xbox Series X|S', 'Nintendo Switch'
    ]
};

let igdbPlatformCache = null;
async function getIgdbPlatformIds() {
    if (igdbPlatformCache) return igdbPlatformCache;
    const map = new Map();
    const rows = await igdbQuery('platforms', 'fields name; limit 500;');
    for (const p of rows || []) {
        if (p && p.name) map.set(p.name, p.id);
    }
    igdbPlatformCache = map;
    return map;
}

async function fetchIgdbGamePool(excludeNamesLower, retroWeight = 0.55) {
    const platformMap = await getIgdbPlatformIds();
    const group = Math.random() < retroWeight ? 'retro' : 'current';
    const platformNames = group === 'retro'
        ? [IGDB_PLATFORM_GROUPS.retro[Math.floor(Math.random() * IGDB_PLATFORM_GROUPS.retro.length)]]
        : IGDB_PLATFORM_GROUPS.current;

    const platformIds = platformNames.map(name => platformMap.get(name)).filter(Boolean);
    if (platformIds.length === 0) return [];

    const offset = Math.floor(Math.random() * 200);
    const query =
        `fields name, category; ` +
        `where platforms = (${platformIds.join(',')}) & version_parent = null ` +
        `& cover != null & first_release_date != null; ` +
        `sort total_rating_count desc; ` +
        `limit 40; offset ${offset};`;

    let rows;
    try { rows = await igdbQuery('games', query, IGDB_TIMEOUT_MS); }
    catch (e) { return []; }
    if (!Array.isArray(rows) || rows.length === 0) return [];

    return rows
        .filter(g => g && g.name && !hasNonLatinScript(g.name) && !isUnwantedIgdb(g))
        .map(g => ({ name: g.name }))
        .filter(g => !excludeNamesLower.has(sharedNormalize(g.name)));
}

// ───────────────────────── Choix du candidat + jaquette ─────────────────────────

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
    const body = `search "${cleanName}"; fields name, category, cover.image_id, first_release_date; where version_parent = null; limit 5;`;
    let results;
    try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
    if (!Array.isArray(results) || !results.length) return null;

    const normalized = cleanName.trim().toLowerCase();
    // On exige une date de sortie connue (voir en tête de fichier) : un jeu
    // sans date sur IGDB est presque toujours une entrée obscure/mal
    // référencée, pas un vrai jeu à faire deviner.
    const candidates = results.filter(r => !isUnwantedIgdb(r) && r.cover?.image_id && r.first_release_date);
    const best = candidates.find(r => (r.name || '').trim().toLowerCase() === normalized) || candidates[0];
    return best ? { name: best.name, coverId: best.cover.image_id, released: best.first_release_date || null } : null;
}

async function pickCandidateName(excludeLower) {
    const primaryMode = Math.random() < 0.8 ? 'big' : 'retro';
    const fetchers = primaryMode === 'big'
        ? [() => fetchSteamBigPool(excludeLower), () => fetchIgdbGamePool(excludeLower, 0.55)]
        : [() => fetchIgdbGamePool(excludeLower, 0.55), () => fetchSteamBigPool(excludeLower)];

    for (const fetchPool of fetchers) {
        try {
            const pool = await fetchPool();
            if (pool && pool.length) return pool[Math.floor(Math.random() * pool.length)];
        } catch (e) { /* on tente la source suivante */ }
    }
    return null;
}

// excludeNames : tableau de noms déjà vus dans la partie en cours (anti-doublon).
export async function pickGameWithCover(excludeNames = [], maxAttempts = 8) {
    if (!isIgdbConfigured()) return null;
    const excludeLower = new Set(excludeNames.map(n => sharedNormalize(n)));
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = await pickCandidateName(excludeLower);
        if (!candidate) continue;
        const found = await fetchIgdbCover(candidate.name);
        if (found && !excludeLower.has(sharedNormalize(found.name))) return found;
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

// Comparaison floue essai <-> nom réel — réutilise la logique de _gamematch.js
// (celle du ZoomJeu) plutôt qu'une comparaison Levenshtein brute sur la
// chaîne entière (trop permissive sur les titres longs).
export const normalize = sharedNormalize;
export const isCorrectGuess = sharedIsCorrectGuess;
