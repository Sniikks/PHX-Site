// ==========================================================
// /api/pixels.js — Vercel Serverless Function
// Jeu "Pixels" : pioche un jeu CONNU (≥ 10 000 propriétaires estimés,
// toutes plateformes confondues via SteamSpy) et renvoie sa JAQUETTE
// (cover art IGDB, pas un screenshot) encodée en base64.
//
// Pourquoi SteamSpy pour le seuil de popularité ? IGDB n'expose aucun
// "nombre de joueurs" comparable entre plateformes. SteamSpy, lui,
// donne une estimation directe du nombre de propriétaires par jeu —
// c'est exactement le même mécanisme déjà utilisé par
// generate-daily.js (ZoomJeu) pour ne piocher que des jeux connus
// (MIN_OWNERS). On reprend cette convention ici avec un seuil de 10 000.
// Ça restreint de fait le pool aux jeux disponibles sur Steam, mais en
// pratique ça couvre l'écrasante majorité des jeux "connus".
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

function parseOwnersLowerBound(ownersStr) {
    if (!ownersStr) return null;
    const match = ownersStr.match(/[\d,]+/);
    if (!match) return null;
    const n = parseInt(match[0].replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
}

async function fetchSteamSpyPool() {
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
        .filter(g => g.owners !== null && g.owners >= MIN_OWNERS);
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
    const body = `search "${cleanName}"; fields name, cover.image_id; where version_parent = null; limit 5;`;
    let results;
    try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
    if (!Array.isArray(results) || !results.length) return null;
    const normalized = cleanName.trim().toLowerCase();
    const best = results.find(r => (r.name || '').trim().toLowerCase() === normalized) || results[0];
    return best.cover?.image_id || null;
}

async function pickGameWithCover(maxAttempts = 8) {
    for (let i = 0; i < maxAttempts; i++) {
        const pool = await fetchSteamSpyPool();
        if (!pool.length) continue;
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        const coverId = await fetchIgdbCover(candidate.name);
        if (coverId) return { name: candidate.name, coverId };
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
        const picked = await pickGameWithCover();
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
