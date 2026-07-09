// ==========================================================
// /api/pixels.js — Vercel Serverless Function
// Jeu "Pixels" : pioche un jeu CONNU (≥ 10 000 propriétaires estimés,
// toutes plateformes confondues via SteamSpy), sans DLC/extension/
// réédition, et renvoie sa JAQUETTE (cover art IGDB, pas un
// screenshot) encodée en base64.
//
// Pourquoi SteamSpy pour le seuil de popularité ? IGDB n'expose aucun
// "nombre de joueurs" comparable entre plateformes. SteamSpy, lui,
// donne une estimation directe du nombre de propriétaires par jeu —
// c'est exactement le même mécanisme déjà utilisé par
// generate-daily.js (ZoomJeu) pour ne piocher que des jeux connus
// (MIN_OWNERS). Ça restreint de fait le pool aux jeux disponibles sur
// Steam, mais en pratique ça couvre l'écrasante majorité des jeux
// "connus".
//
// Filtres anti-DLC/extension/réédition : motif de nom (repli commun
// à tout le site, voir generate-daily.js/search-games.js/
// plusoumoins.js) + catégorie IGDB (dlc_addon, bundle, mod, episode,
// season, remaster, pack, update exclus) + version_parent = null.
//
// Anti-doublons : le client envoie la liste des jeux déjà vus pendant
// la partie en cours (?exclude=Nom1|Nom2|...) ; on les exclut du
// tirage pour ne pas retomber sur le même jeu deux fois de suite.
//
// Pourquoi en base64 et pas une URL directe vers images.igdb.com ?
// Le mini-jeu doit lire les pixels de l'image (canvas.getImageData)
// pour calculer une couleur moyenne par case de la grille, ce qui
// exige une image "same-origin" côté canvas (sinon SecurityError).
// En la renvoyant en base64 dans notre propre réponse JSON, l'image
// est techniquement embarquée depuis notre propre origine : zéro
// souci CORS.
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

function parseExcludeList(req) {
    const raw = req.query?.exclude;
    if (!raw) return new Set();
    return new Set(String(raw).split('|').map(s => s.trim().toLowerCase()).filter(Boolean));
}

async function fetchSteamSpyPool(excludeNames) {
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
        .filter(g => !excludeNames.has(g.name.trim().toLowerCase()));
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

async function pickGameWithCover(excludeNames, maxAttempts = 8) {
    for (let i = 0; i < maxAttempts; i++) {
        const pool = await fetchSteamSpyPool(excludeNames);
        if (!pool.length) continue;
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        const found = await fetchIgdbCover(candidate.name);
        if (found && !excludeNames.has(found.name.trim().toLowerCase())) return found;
    }
    return null;
}

async function fetchImageAsDataUri(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image IGDB a répondu ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!isIgdbConfigured()) {
        return res.status(500).json({ error: "IGDB non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants)." });
    }

    try {
        const excludeNames = parseExcludeList(req);
        const picked = await pickGameWithCover(excludeNames);
        if (!picked) {
            return res.status(503).json({ error: "Aucun jeu connu exploitable trouvé, réessaie." });
        }
        const image = await fetchImageAsDataUri(COVER_URL(picked.coverId));
        return res.status(200).json({ name: picked.name, image });
    } catch (e) {
        console.error('❌ pixels error:', e);
        return res.status(500).json({ error: e.message });
    }
}
