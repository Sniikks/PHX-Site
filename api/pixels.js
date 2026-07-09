// ==========================================================
// /api/pixels.js — Vercel Serverless Function
// Jeu "Pixels" : pioche un jeu + un screenshot au hasard via IGDB
// (mêmes identifiants Twitch que generate-daily.js / search-games.js),
// et renvoie l'image encodée en base64 directement dans le JSON.
//
// Pourquoi en base64 et pas une URL directe vers images.igdb.com ?
// Le mini-jeu doit lire les pixels de l'image (canvas.getImageData)
// pour calculer une couleur moyenne par case de la grille. Ça exige
// une image "same-origin" côté canvas, sinon le navigateur bloque la
// lecture (SecurityError sur une image cross-origin sans CORS). En
// la renvoyant en base64 dans notre propre réponse JSON, l'image est
// techniquement embarquée depuis notre propre origine : zéro souci CORS.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const SCREENSHOT_URL = id => `https://images.igdb.com/igdb/image/upload/t_1080p/${id}.jpg`;

async function fetchCandidatePool() {
    const offset = Math.floor(Math.random() * 600);
    const body = `fields name, screenshots.image_id; where version_parent = null & screenshots != null & name != null; sort follows desc; limit 80; offset ${offset};`;
    const results = await igdbQuery('games', body);
    if (!Array.isArray(results)) return [];
    return results.filter(g => g.name && Array.isArray(g.screenshots) && g.screenshots.length > 0);
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
        let pool = [];
        for (let attempt = 0; attempt < 3 && pool.length === 0; attempt++) {
            pool = await fetchCandidatePool();
        }
        if (!pool.length) {
            return res.status(503).json({ error: "Aucun jeu exploitable trouvé, réessaie." });
        }

        const game = pool[Math.floor(Math.random() * pool.length)];
        const shot = game.screenshots[Math.floor(Math.random() * game.screenshots.length)];
        const image = await fetchImageAsDataUri(SCREENSHOT_URL(shot.image_id));

        return res.status(200).json({ name: game.name, image });
    } catch (e) {
        console.error('❌ pixels error:', e);
        return res.status(500).json({ error: e.message });
    }
}
