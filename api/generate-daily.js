// ==========================================================
// /api/generate-daily.js — Vercel Serverless Function
// Génère automatiquement le puzzle "ZoomJeu" du jour et le stocke
// dans Supabase (table app_data).
//
// DEUX lignes par jour depuis la v2 :
//  - "zoomjeu_YYYY-MM-DD"        : ligne PUBLIQUE lue par le navigateur
//    (image proxifiée, indices, session partagée) — SANS la réponse.
//  - "zoomjeu_secret_YYYY-MM-DD" : ligne SECRÈTE (réponse, vraie URL
//    d'image, date de sortie) — illisible avec la clé anon une fois
//    la migration RLS appliquée (voir supabase-migration-zoomjeu.sql).
//    C'est /api/guess.js qui compare les essais côté serveur.
//
// Sources des jeux : SteamSpy/Steam pour les gros titres actuels, IGDB
// (API Twitch, gratuite) pour les jeux consoles / rétro ET pour l'enrichissement
// de TOUS les jeux (date de sortie fiable via first_release_date, indices
// progressifs : genres, plateformes, développeur). IGDB est prioritaire pour
// les dates et les images. IGDB ne sert JAMAIS de jaquette/artwork comme image
// de puzzle : uniquement des screenshots in-game.
//
// Cadrage intelligent (nouveau) : le point de zoom n'est plus tiré
// totalement au hasard — l'image est analysée avec "sharp" pour
// viser une zone riche en détails (et éviter ciel/zones noires).
//
// Déclenché chaque jour par le cron externe (cron-job.org).
// Peut aussi être déclenché manuellement : /api/generate-daily?key=TON_ADMIN_KEY
// Ajoute &force=true pour régénérer même si un puzzle existe déjà pour le jour.
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { normalize, levenshtein, extractYear } from './_gamematch.js';
import { igdbQuery, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from './_igdb.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
// service_role de préférence : nécessaire pour écrire les lignes secrètes
// une fois la migration RLS appliquée. Repli sur la clé anon sinon.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const CRON_SECRET = process.env.CRON_SECRET || null;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const STEAM_STORE_BASE = 'https://store.steampowered.com/api/appdetails';

const LAUNCH_DATE = '2026-01-01';

// IGDB (Twitch) est désormais LA source pour les jeux consoles / rétro.
// RAWG a été retiré : IGDB couvre toutes ces plateformes — PS1/PS2/PS3,
// PSP, Wii/Wii U, GameCube, N64, DS/3DS, Game Boy/Advance, Xbox/360 —
// avec dates de sortie fiables et des screenshots in-game.
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

// Genres IGDB (noms exacts de l'API, différents des slugs RAWG utilisés avant).
const IGDB_GENRE_NAMES = [
    'Shooter', 'Adventure', 'Role-playing (RPG)', 'Strategy',
    'Simulator', 'Indie', 'Racing', 'Sport', 'Platform', 'Fighting'
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

// Exclut les DLC/extensions. Steam est déjà filtré via son champ "type" (voir fetchAppDetails).
// Pour IGDB, le filtre "category = 0" s'est révélé cassé côté IGDB (voir fetchIgdbGamePool) ;
// ce filtre par nom est donc le rempart principal pour les deux sources.
const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|skin pack|costume pack|weapon pack|outfit pack)\b/i;

function hasNonLatinScript(name) {
    return typeof name === 'string' && NON_LATIN_SCRIPT_REGEX.test(name);
}

function isReRelease(name) {
    return typeof name === 'string' && RE_RELEASE_PATTERN.test(name);
}

function isDlc(name) {
    return typeof name === 'string' && DLC_NAME_PATTERN.test(name);
}

// normalize() vient désormais de ./_gamematch.js (partagé avec /api/guess.js)

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

// ───────────────────────── IGDB (jeux consoles / rétro) ─────────────────────────
// Remplace RAWG : IGDB (API Twitch, gratuite) sert désormais à la fois de
// source de pool pour les jeux rétro/consoles ET de source de détails
// (dates, screenshots, genres, plateformes, développeur) — le tout en une
// seule requête par jeu, alors que RAWG nécessitait deux appels.

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

// Champs communs renvoyés pour un jeu IGDB (pool ET détails) : tout ce dont
// on a besoin (nom, date, cover, screenshots, genres, plateformes, dev) en
// une seule requête.
const IGDB_GAME_FIELDS = 'name,first_release_date,cover.image_id,screenshots.image_id,' +
    'genres.name,platforms.name,platforms.abbreviation,' +
    'involved_companies.company.name,involved_companies.developer';

function mapIgdbRowToDetails(row) {
    if (!row) return null;
    const screenshots = (row.screenshots || [])
        .map(s => s.image_id ? `https://images.igdb.com/igdb/image/upload/t_1080p/${s.image_id}.jpg` : null)
        .filter(Boolean);
    if (screenshots.length === 0) return null;

    const released = row.first_release_date
        ? new Date(row.first_release_date * 1000).toISOString().slice(0, 10)
        : null;

    const genres = (row.genres || [])
        .map(g => IGDB_GENRE_FR[g.name] || g.name)
        .filter(Boolean)
        .slice(0, 3);

    const platforms = [...new Set((row.platforms || [])
        .map(p => p.abbreviation || p.name)
        .filter(Boolean))]
        .slice(0, 6);

    const developer = (row.involved_companies || [])
        .find(c => c.developer && c.company && c.company.name)?.company?.name || null;

    return {
        name: row.name || null,
        screenshots,
        cover: row.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_1080p/${row.cover.image_id}.jpg` : null,
        released,
        genres,
        platforms,
        developer
    };
}

async function fetchIgdbGamePool(retroWeight = 0.7) {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return [];
    const platformMap = await getIgdbPlatformIds();

    const group = Math.random() < retroWeight ? 'retro' : 'current';
    const platformNames = group === 'retro'
        ? [IGDB_PLATFORM_GROUPS.retro[Math.floor(Math.random() * IGDB_PLATFORM_GROUPS.retro.length)]]
        : IGDB_PLATFORM_GROUPS.current;

    const platformIds = platformNames.map(name => platformMap.get(name)).filter(Boolean);
    if (platformIds.length === 0) return [];

    let genreClause = '';
    if (Math.random() < 0.3) {
        const genre = IGDB_GENRE_NAMES[Math.floor(Math.random() * IGDB_GENRE_NAMES.length)];
        genreClause = ` & genres.name = "${genre}"`;
    }

    // category = 0 (jeu principal) semblait une bonne idée pour exclure DLC/remasters/
    // ports… mais s'est révélé CASSÉ à l'usage : ce filtre renvoie 0 résultat à lui seul,
    // quel que soit le contexte (confirmé par un test isolé via une route de debug). On
    // s'appuie donc uniquement sur version_parent = null (exclut la plupart des éditions)
    // + les filtres par motif de nom déjà appliqués plus bas (isReRelease, isDlc).
    const offset = Math.floor(Math.random() * 200);
    const query =
        `fields ${IGDB_GAME_FIELDS}; ` +
        `where platforms = (${platformIds.join(',')}) & version_parent = null ` +
        `& screenshots != null & first_release_date != null${genreClause}; ` +
        `sort total_rating_count desc; ` +
        `limit 40; offset ${offset};`;

    let rows;
    try {
        rows = await igdbQuery('games', query);
    } catch (e) {
        console.error('IGDB pool indisponible :', e.message);
        return [];
    }
    if (!Array.isArray(rows) || rows.length === 0) return [];

    return rows
        .filter(g => g && g.id && g.name && !hasNonLatinScript(g.name))
        .map(g => ({ source: 'igdb', id: g.id, name: g.name, details: mapIgdbRowToDetails(g) }));
}

async function fetchIgdbGameDetails(igdbId) {
    const rows = await igdbQuery('games',
        `fields ${IGDB_GAME_FIELDS}; where id = ${igdbId}; limit 1;`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return mapIgdbRowToDetails(rows[0]);
}

// ───────────────────────── Sélection du jeu du jour ─────────────────────────

async function pickDailyGame(usedIds, usedNames) {
    const primaryMode = Math.random() < 0.65 ? 'big' : 'retro';

    // Plusieurs sources de pool, dans l'ordre de préférence. Si la première ne donne
    // rien d'exploitable (SteamSpy/IGDB en panne ou rate-limité, pool épuisé par les
    // jeux déjà utilisés...), on tente les suivantes avant d'abandonner. Avant, une
    // seule panne transitoire d'une API externe faisait échouer tout le puzzle du jour.
    const igdbAvailable = !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
    const poolFetchers = primaryMode === 'big'
        ? [fetchSteamBigPool, fetchSteamRandomPool, () => fetchIgdbGamePool(0.85)]
        : [
            () => (igdbAvailable && Math.random() < 0.7 ? fetchIgdbGamePool(0.85) : fetchSteamRandomPool()),
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
            if (isDlc(candidate.name)) continue;

            totalAttempts++;
            let details;
            try {
                if (candidate.source === 'igdb') {
                    // Déjà récupérés en une requête lors du pool fetch — on ne
                    // refait un appel IGDB que si, exceptionnellement, absents.
                    details = candidate.details || await fetchIgdbGameDetails(candidate.id);
                } else {
                    details = await fetchAppDetails(candidate.id);
                }
            } catch (e) {
                continue;
            }
            if (!details) continue;

            const finalName = details.name || candidate.name;
            if (hasNonLatinScript(finalName)) continue;
            if (isReRelease(finalName)) continue;
            if (isDlc(finalName)) continue;

            return {
                source: candidate.source,
                id: candidate.id,
                name: finalName,
                screenshots: details.screenshots, // le choix final de l'image se fait dans le handler
                cover: details.cover,
                released: details.released,
                // Pour les jeux venus d'IGDB, on a déjà tout (genres, plateformes,
                // développeur) : pas besoin d'un second aller-retour d'enrichissement.
                igdbHints: candidate.source === 'igdb'
                    ? { released: details.released, year: extractYear(details.released), genres: details.genres, platforms: details.platforms, developer: details.developer, screenshots: details.screenshots }
                    : null
            };
        }
    }
    return null;
}

// ───────────────────────── IGDB (dates fiables + indices) ─────────────────────────
// API gratuite de Twitch : https://api-docs.igdb.com
// Auth "client credentials" : le token (valable ~2 mois) est mis en cache
// mémoire — les containers serverless chauds le réutilisent entre deux appels.

// getIgdbToken() et igdbQuery() viennent désormais de ./_igdb.js (partagé avec /api/search-games.js)

// Traduction FR des genres IGDB (les noms inconnus restent en anglais).
const IGDB_GENRE_FR = {
    'Adventure': 'Aventure', 'Arcade': 'Arcade', 'Card & Board Game': 'Cartes / plateau',
    'Fighting': 'Combat', "Hack and slash/Beat 'em up": "Hack'n'slash", 'Indie': 'Indé',
    'MOBA': 'MOBA', 'Music': 'Musique / rythme', 'Pinball': 'Flipper',
    'Platform': 'Plateforme', 'Point-and-click': 'Point & click', 'Puzzle': 'Réflexion',
    'Quiz/Trivia': 'Quiz', 'Racing': 'Course', 'Real Time Strategy (RTS)': 'Stratégie temps réel',
    'Role-playing (RPG)': 'RPG', 'Shooter': 'Tir', 'Simulator': 'Simulation',
    'Sport': 'Sport', 'Strategy': 'Stratégie', 'Tactical': 'Tactique',
    'Turn-based strategy (TBS)': 'Stratégie tour par tour', 'Visual Novel': 'Visual novel'
};

// Cherche le jeu sur IGDB et renvoie { released, year, genres, platforms,
// developer, screenshots } ou null. Correspondance PRUDENTE par nom normalisé
// (égalité, sinon Levenshtein <= 2) : mieux vaut aucun indice qu'un indice
// portant sur le mauvais jeu.
// ⚠️ "screenshots" = captures IN-GAME uniquement (endpoint screenshots d'IGDB).
// On n'utilise jamais covers/artworks : trop reconnaissables pour le puzzle.
async function fetchIgdbEnrichment(gameName) {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
    const clean = String(gameName || '').replace(/[™®©"]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    try {
        const rows = await igdbQuery('games',
            `search "${clean}"; ` +
            `fields name,first_release_date,genres.name,platforms.name,platforms.abbreviation,` +
            `involved_companies.company.name,involved_companies.developer,screenshots.image_id; ` +
            `limit 8;`
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;

        const target = normalize(clean);
        let best = rows.find(r => normalize(r.name || '') === target);
        if (!best) best = rows.find(r => {
            const n = normalize(r.name || '');
            return n && Math.abs(n.length - target.length) <= 3 && levenshtein(n, target) <= 2;
        });
        if (!best) return null;

        const released = best.first_release_date
            ? new Date(best.first_release_date * 1000).toISOString().slice(0, 10)
            : null;

        const genres = (best.genres || [])
            .map(g => IGDB_GENRE_FR[g.name] || g.name)
            .filter(Boolean)
            .slice(0, 3);

        const platforms = [...new Set((best.platforms || [])
            .map(p => p.abbreviation || p.name)
            .filter(Boolean))]
            .slice(0, 6);

        const developer = (best.involved_companies || [])
            .find(c => c.developer && c.company && c.company.name)?.company?.name || null;

        const screenshots = (best.screenshots || [])
            .map(s => s.image_id ? `https://images.igdb.com/igdb/image/upload/t_1080p/${s.image_id}.jpg` : null)
            .filter(Boolean);

        return { released, year: extractYear(released), genres, platforms, developer, screenshots };
    } catch (e) {
        console.error('IGDB indisponible (le puzzle sera généré sans indices) :', e.message);
        return null;
    }
}

// ───────────────────────── Cadrage intelligent du zoom ─────────────────────────
// Analyse le screenshot avec "sharp" pour choisir un point de zoom riche en
// détails : on découpe l'image en fenêtres candidates (dans la zone 22-78 %),
// on note chacune par son écart-type de luminosité (≈ quantité de détails),
// on pénalise les zones quasi noires/blanches (letterbox, ciel, HUD), puis on
// tire au hasard parmi les meilleures (pour garder de la variété jour à jour).
// Repli : ancien tirage aléatoire si sharp/le téléchargement échoue.

async function pickFocusPoint(imageUrl) {
    const fallback = () => ({ x: Math.round(20 + Math.random() * 60), y: Math.round(20 + Math.random() * 60) });

    let sharp;
    try {
        sharp = (await import('sharp')).default;
    } catch (e) {
        console.error('sharp indisponible, cadrage aléatoire :', e.message);
        return fallback();
    }

    try {
        const r = await fetch(imageUrl);
        if (!r.ok) return fallback();
        const buf = Buffer.from(await r.arrayBuffer());

        const { data, info } = await sharp(buf)
            .resize({ width: 128 })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const W = info.width, H = info.height;
        const px = (x, y) => data[y * W + x];

        const candidates = [];
        const radius = Math.round(W * 0.10); // fenêtre ≈ ±10 % de la largeur
        for (let fx = 22; fx <= 78; fx += 8) {
            for (let fy = 22; fy <= 78; fy += 8) {
                const cx = Math.round(fx / 100 * W);
                const cy = Math.round(fy / 100 * H);
                let sum = 0, sum2 = 0, n = 0;
                for (let y = Math.max(0, cy - radius); y < Math.min(H, cy + radius); y += 2) {
                    for (let x = Math.max(0, cx - radius); x < Math.min(W, cx + radius); x += 2) {
                        const v = px(x, y);
                        sum += v; sum2 += v * v; n++;
                    }
                }
                if (!n) continue;
                const mean = sum / n;
                const variance = Math.max(0, sum2 / n - mean * mean);
                const brightnessPenalty = (mean < 18 || mean > 237) ? 0.25 : 1;
                candidates.push({ x: fx, y: fy, score: Math.sqrt(variance) * brightnessPenalty });
            }
        }
        if (candidates.length === 0) return fallback();

        candidates.sort((a, b) => b.score - a.score);
        const top = candidates.slice(0, 5);
        const chosen = top[Math.floor(Math.random() * top.length)];
        const jitter = v => Math.max(18, Math.min(82, v + Math.round(Math.random() * 6) - 3));
        return { x: jitter(chosen.x), y: jitter(chosen.y) };
    } catch (e) {
        console.error('Analyse du cadrage échouée, cadrage aléatoire :', e.message);
        return fallback();
    }
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

    // Simple vérification de clé, sans génération (remplace l'ancienne
    // fonction /api/verify-admin.js, fusionnée ici pour rester sous la
    // limite de 12 fonctions serverless du plan Hobby de Vercel).
    // Appel : /api/generate-daily?verify=1&key=TON_ADMIN_KEY
    if (req.query.verify) {
        return res.status(isAdmin ? 200 : 401).json({ ok: !!isAdmin });
    }

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
        // v1 : la réponse était dans la ligne publique (data.answer). v2 : elle est dans la
        // ligne secrète, la ligne publique porte data.v = 2.
        // Une ligne vidée manuellement ({}) est donc traitée comme "à générer", sans besoin de &force=true.
        const hasValidPuzzle = !!(existing?.data && (existing.data.answer || existing.data.v >= 2) && existing.data.image);
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

        // ── Enrichissement IGDB : date fiable + indices (best-effort) ──
        // IGDB est désormais LA source prioritaire pour dates/images/indices,
        // quelle que soit l'origine du jeu (IGDB, Steam...). Pour un jeu déjà
        // venu d'IGDB, on réutilise les données obtenues au moment du choix du
        // jeu (igdbHints) — pas besoin d'une seconde requête de recherche.
        const igdb = game.igdbHints || await fetchIgdbEnrichment(game.name);

        // ── Choix du screenshot (toujours de l'in-game, jamais de jaquette) ──
        // IGDB en priorité (images 1080p, cohérentes avec la date/les indices).
        // Repli sur les screenshots de la source d'origine (Steam...) si IGDB
        // n'a pas assez de visuels pour ce jeu.
        let screenshotPool = igdb && Array.isArray(igdb.screenshots) && igdb.screenshots.length >= 3
            ? igdb.screenshots
            : (Array.isArray(game.screenshots) && game.screenshots.length ? game.screenshots : []);
        if (screenshotPool.length === 0) {
            return res.status(500).json({ error: 'Jeu choisi sans screenshot exploitable.' });
        }
        const chosenImage = screenshotPool[Math.floor(Math.random() * screenshotPool.length)];

        // Date de sortie : IGDB (first_release_date, la 1re sortie du jeu) en
        // priorité, sinon celle de la source d'origine (Steam...) comme repli.
        const released = igdb?.released || game.released || null;

        // ── Cadrage intelligent (repli aléatoire intégré) ──
        const focus = await pickFocusPoint(chosenImage);

        // ── Indices progressifs (affichés au fil des essais côté client) ──
        const hints = {};
        const hintYear = extractYear(released);
        if (hintYear) hints.year = hintYear;
        if (igdb?.genres?.length) hints.genres = igdb.genres;
        if (igdb?.platforms?.length) hints.platforms = igdb.platforms;
        if (igdb?.developer) hints.developer = igdb.developer;

        // ── Ligne SECRÈTE (réponse + vraie URL d'image) — écrite en premier
        // pour que /api/image fonctionne dès que la ligne publique apparaît. ──
        const secret = {
            date: dateStr,
            answer: game.name,
            image: chosenImage,
            cover: game.cover,
            released,
            source: game.source,
            refId: game.id
        };
        await supabase.from('app_data').upsert({ id: 'zoomjeu_secret_' + dateStr, data: secret, updated_at: new Date().toISOString() });

        // ── Ligne PUBLIQUE (lue par le navigateur) : PAS de réponse, image
        // proxifiée (&v= change à chaque génération pour invalider le CDN). ──
        const puzzle = {
            v: 2,
            date: dateStr,
            number: puzzleNumber(dateStr),
            image: `/api/image?d=${dateStr}&v=${Date.now().toString(36)}`,
            focus,
            hints,
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
