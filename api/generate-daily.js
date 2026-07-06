// ==========================================================
// /api/generate-daily.js — Vercel Serverless Function
// Génère automatiquement le puzzle "ZoomJeu" du jour et le stocke
// dans Supabase (table app_data, clé "zoomjeu_YYYY-MM-DD").
//
// Une seule ligne par jour : les infos du puzzle (jeu, image, zoom)
// ET la session de jeu partagée (essais) sont fusionnées dans le
// même objet JSON, sous "session".
//
// Déclenché chaque jour par Vercel Cron (voir vercel.json).
// Peut aussi être déclenché manuellement : /api/generate-daily?key=TON_ADMIN_KEY
// Ajoute &force=true pour régénérer même si un puzzle existe déjà pour le jour.
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '') || null;
const CRON_SECRET = process.env.CRON_SECRET || null;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const STEAM_STORE_BASE = 'https://store.steampowered.com/api/appdetails';
const RAWG_BASE = 'https://api.rawg.io/api';

const LAUNCH_DATE = '2026-01-01';

const RAWG_PLATFORM_GROUPS = {
    retro: [
        'playstation', 'playstation 2', 'playstation 3', 'psp',
        'wii', 'wii u', 'gamecube', 'nintendo 64',
        'nintendo ds', 'nintendo 3ds',
        'game boy', 'game boy advance', 'xbox', 'xbox 360'
    ],
    current: [
        'pc', 'playstation 4', 'playstation 5',
        'xbox one', 'xbox series s/x',
        'nintendo switch', 'nintendo switch 2'
    ]
};

const RAWG_GENRE_SLUGS = [
    'action', 'adventure', 'role-playing-games-rpg', 'shooter',
    'strategy', 'simulation', 'indie', 'racing', 'sports', 'massively-multiplayer'
];

const STEAMSPY_GENRES = [
    'Action', 'Adventure', 'RPG', 'Strategy', 'Simulation',
    'Indie', 'Casual', 'Massively Multiplayer'
];

const MIN_OWNERS = 20000;

// ───────────────────────── Utils texte ─────────────────────────

const NON_LATIN_SCRIPT_REGEX = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF\u0E00-\u0E7F\u0400-\u04FF]/;

// Exclut les rééditions (remaster, definitive edition, etc.) : ce sont souvent des fiches
// à part avec leur propre date de sortie, très différente de celle du jeu d'origine que les
// joueurs ont en tête — ça rend les indices de date (avant/après) trompeurs ou incohérents.
const RE_RELEASE_PATTERN = /\b(remaster(?:ed)?|definitive edition|game of the year edition|goty edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition|hd remaster)\b/i;

function hasNonLatinScript(name) {
    return typeof name === 'string' && NON_LATIN_SCRIPT_REGEX.test(name);
}

function isReRelease(name) {
    return typeof name === 'string' && RE_RELEASE_PATTERN.test(name);
}

function normalize(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseOwnersLowerBound(ownersStr) {
    if (!ownersStr) return null;
    const match = ownersStr.match(/[\d,]+/);
    if (!match) return null;
    const n = parseInt(match[0].replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
}

// ───────────────────────── Steam / SteamSpy ─────────────────────────

async function fetchSteamSpyGames(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SteamSpy a répondu ${res.status}`);
    const data = await res.json();

    let games = Object.values(data || {})
        .filter(g => g && g.appid && g.name && !hasNonLatinScript(g.name))
        .map(g => ({ source: 'steam', id: g.appid, name: g.name, owners: parseOwnersLowerBound(g.owners) }));

    games = games.filter(g => g.owners === null || g.owners >= MIN_OWNERS);

    if (games.length === 0) {
        const fallbackRes = await fetch(`${STEAMSPY_BASE}?request=top100forever`);
        if (!fallbackRes.ok) throw new Error(`SteamSpy a répondu ${fallbackRes.status}`);
        const fallbackData = await fallbackRes.json();
        games = Object.values(fallbackData || {})
            .filter(g => g && g.appid && g.name && !hasNonLatinScript(g.name))
            .map(g => ({ source: 'steam', id: g.appid, name: g.name }));
    }

    return games;
}

async function fetchSteamBigPool() {
    const sourceRoll = Math.random();
    let url;
    if (sourceRoll < 0.35) {
        url = `${STEAMSPY_BASE}?request=top100forever`;
    } else if (sourceRoll < 0.6) {
        url = `${STEAMSPY_BASE}?request=top100in2weeks`;
    } else {
        const page = Math.floor(Math.random() * 5);
        url = `${STEAMSPY_BASE}?request=all&page=${page}`;
    }
    return fetchSteamSpyGames(url);
}

async function fetchSteamRandomPool() {
    const sourceRoll = Math.random();
    let url;
    if (sourceRoll < 0.5) {
        const page = 5 + Math.floor(Math.random() * 35);
        url = `${STEAMSPY_BASE}?request=all&page=${page}`;
    } else {
        const genre = STEAMSPY_GENRES[Math.floor(Math.random() * STEAMSPY_GENRES.length)];
        url = `${STEAMSPY_BASE}?request=genre&genre=${encodeURIComponent(genre)}`;
    }
    return fetchSteamSpyGames(url);
}

async function fetchAppDetails(appid) {
    const url = `${STEAM_STORE_BASE}?appids=${appid}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json[appid];
    if (!entry || !entry.success || !entry.data) return null;

    const data = entry.data;
    if (data.type !== 'game') return null;
    if (!Array.isArray(data.screenshots) || data.screenshots.length === 0) return null;

    return {
        name: data.name,
        screenshots: data.screenshots.map(s => s.path_full).filter(Boolean),
        cover: data.header_image || null,
        released: data.release_date && !data.release_date.coming_soon ? data.release_date.date : null
    };
}

// ───────────────────────── RAWG (jeux consoles / rétro) ─────────────────────────

let rawgPlatformCache = null;

async function getRawgPlatformIds() {
    if (rawgPlatformCache) return rawgPlatformCache;
    const map = new Map();
    let url = `${RAWG_BASE}/platforms?key=${RAWG_API_KEY}&page_size=50`;
    while (url) {
        const res = await fetch(url);
        if (!res.ok) break;
        const data = await res.json();
        for (const p of data.results || []) {
            if (p && p.name) map.set(p.name.toLowerCase(), p.id);
        }
        url = data.next || null;
    }
    rawgPlatformCache = map;
    return map;
}

async function fetchRawgGamePool(retroWeight = 0.7) {
    if (!RAWG_API_KEY) return [];
    const platformMap = await getRawgPlatformIds();

    const group = Math.random() < retroWeight ? 'retro' : 'current';
    const platformNames = group === 'retro'
        ? [RAWG_PLATFORM_GROUPS.retro[Math.floor(Math.random() * RAWG_PLATFORM_GROUPS.retro.length)]]
        : RAWG_PLATFORM_GROUPS.current;

    const platformIds = platformNames.map(name => platformMap.get(name)).filter(Boolean);
    if (platformIds.length === 0) return [];

    const maxPage = group === 'retro' ? 8 : 20;
    const page = 1 + Math.floor(Math.random() * maxPage);
    const baseUrl = `${RAWG_BASE}/games?key=${RAWG_API_KEY}&platforms=${platformIds.join(',')}&ordering=-added&page_size=40`;

    let themeParam = '';
    if (Math.random() < 0.3) {
        const genre = RAWG_GENRE_SLUGS[Math.floor(Math.random() * RAWG_GENRE_SLUGS.length)];
        themeParam = `&genres=${encodeURIComponent(genre)}`;
    }

    const attemptsUrls = [
        `${baseUrl}${themeParam}&page=${page}`,
        `${baseUrl}${themeParam}&page=1`,
        `${baseUrl}&page=1`
    ];

    let data = null;
    for (const attemptUrl of attemptsUrls) {
        const res = await fetch(attemptUrl);
        if (res.ok) { data = await res.json(); break; }
        if (res.status !== 404) break;
    }
    if (!data) return [];

    return (data.results || [])
        .filter(g => g && g.id && g.name && !hasNonLatinScript(g.name))
        .map(g => ({ source: 'rawg', id: g.id, name: g.name }));
}

async function fetchRawgDetails(rawgId) {
    const screenshotsRes = await fetch(`${RAWG_BASE}/games/${rawgId}/screenshots?key=${RAWG_API_KEY}`);
    if (!screenshotsRes.ok) return null;
    const screenshotsData = await screenshotsRes.json();
    const screenshots = (screenshotsData.results || []).map(s => s.image).filter(Boolean);
    if (screenshots.length === 0) return null;

    const detailsRes = await fetch(`${RAWG_BASE}/games/${rawgId}?key=${RAWG_API_KEY}`);
    const details = detailsRes.ok ? await detailsRes.json() : null;

    return {
        name: details?.name || null,
        screenshots,
        cover: details?.background_image || null,
        released: details?.released || null
    };
}

// ───────────────────────── Sélection du jeu du jour ─────────────────────────

async function pickDailyGame(usedIds, usedNames) {
    const primaryMode = Math.random() < 0.65 ? 'big' : 'retro';

    // Plusieurs sources de pool, dans l'ordre de préférence. Si la première ne donne
    // rien d'exploitable (SteamSpy/RAWG en panne ou rate-limité, pool épuisé par les
    // jeux déjà utilisés...), on tente les suivantes avant d'abandonner. Avant, une
    // seule panne transitoire d'une API externe faisait échouer tout le puzzle du jour.
    const poolFetchers = primaryMode === 'big'
        ? [fetchSteamBigPool, fetchSteamRandomPool, () => fetchRawgGamePool(0.85)]
        : [
            () => (RAWG_API_KEY && Math.random() < 0.7 ? fetchRawgGamePool(0.85) : fetchSteamRandomPool()),
            fetchSteamBigPool,
            fetchSteamRandomPool
          ];

    let totalAttempts = 0;
    const MAX_TOTAL_ATTEMPTS = 30;

    for (const fetchPool of poolFetchers) {
        if (totalAttempts >= MAX_TOTAL_ATTEMPTS) break;

        let pool;
        try {
            pool = await fetchPool();
        } catch (e) {
            console.error('Source de pool indisponible, on passe à la suivante :', e.message);
            continue;
        }
        if (!pool || pool.length === 0) continue;

        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        for (const candidate of pool) {
            if (totalAttempts >= MAX_TOTAL_ATTEMPTS) break;
            const key = `${candidate.source}:${candidate.id}`;
            if (usedIds.has(key)) continue;
            if (usedNames.has(normalize(candidate.name))) continue;
            if (isReRelease(candidate.name)) continue;

            totalAttempts++;
            let details;
            try {
                details = candidate.source === 'rawg'
                    ? await fetchRawgDetails(candidate.id)
                    : await fetchAppDetails(candidate.id);
            } catch (e) {
                continue;
            }
            if (!details) continue;

            const finalName = details.name || candidate.name;
            if (hasNonLatinScript(finalName)) continue;
            if (isReRelease(finalName)) continue;

            return {
                source: candidate.source,
                id: candidate.id,
                name: finalName,
                screenshot: details.screenshots[Math.floor(Math.random() * details.screenshots.length)],
                cover: details.cover,
                released: details.released
            };
        }
    }
    return null;
}

// ───────────────────────── Dates / numéro de puzzle ─────────────────────────

function getParisDateString(offsetDays = 0) {
    const now = new Date(Date.now() + offsetDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function puzzleNumber(dateStr) {
    const d1 = new Date(`${LAUNCH_DATE}T00:00:00Z`);
    const d2 = new Date(`${dateStr}T00:00:00Z`);
    return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
}

// ───────────────────────── Handler ─────────────────────────

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'] || '';
    const isCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    const isAdmin = ADMIN_KEY && req.query.key === ADMIN_KEY;

    if (!isCron && !isAdmin) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    try {
        // Génération normale : date du jour (+ décalage éventuel). Génération rétroactive
        // (backfill) : date explicite fournie en paramètre, réservée aux appels admin/cron
        // déjà authentifiés plus haut. Format attendu : YYYY-MM-DD.
        const explicitDate = req.query.date;
        const isValidDate = typeof explicitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate);
        const dayOffset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
        const dateStr = isValidDate ? explicitDate : getParisDateString(dayOffset);
        const puzzleId = `zoomjeu_${dateStr}`;

        const { data: existing } = await supabase.from('app_data').select('data').eq('id', puzzleId).maybeSingle();
        // On considère qu'un puzzle valide existe déjà seulement s'il a un jeu et une image.
        // Une ligne vidée manuellement ({}) est donc traitée comme "à générer", sans besoin de &force=true.
        const hasValidPuzzle = !!(existing?.data && existing.data.answer && existing.data.image);
        if (hasValidPuzzle && !req.query.force) {
            return res.status(200).json({ ok: true, skipped: true, message: 'Puzzle déjà généré pour ' + dateStr });
        }

        const { data: usedRow } = await supabase.from('app_data').select('data').eq('id', 'zoomjeu_used').maybeSingle();
        const usedIds = new Set(usedRow?.data?.ids || []);
        const usedNames = new Set(usedRow?.data?.names || []);

        const game = await pickDailyGame(usedIds, usedNames);
        if (!game) {
            return res.status(500).json({ error: 'Aucun jeu trouvé après plusieurs tentatives.' });
        }

        const focus = { x: Math.round(20 + Math.random() * 60), y: Math.round(20 + Math.random() * 60) };

        // Une seule ligne par jour : infos du puzzle + session de jeu partagée fusionnées.
        const puzzle = {
            date: dateStr,
            number: puzzleNumber(dateStr),
            answer: game.name,
            image: game.screenshot,
            cover: game.cover,
            released: game.released,
            source: game.source,
            refId: game.id,
            focus,
            session: { guesses: [], solved: false, gaveUp: false }
        };

        await supabase.from('app_data').upsert({ id: puzzleId, data: puzzle, updated_at: new Date().toISOString() });

        usedIds.add(`${game.source}:${game.id}`);
        usedNames.add(normalize(game.name));
        await supabase.from('app_data').upsert({
            id: 'zoomjeu_used',
            data: { ids: [...usedIds], names: [...usedNames] },
            updated_at: new Date().toISOString()
        });

        return res.status(200).json({ ok: true, puzzle: { date: dateStr, number: puzzle.number, answer: game.name } });
    } catch (e) {
        console.error('❌ generate-daily error:', e);
        return res.status(500).json({ error: e.message });
    }
}
