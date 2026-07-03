// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Proxy de recherche de jeux pour l'autocomplétion côté client.
// Interroge Steam (storesearch) + RAWG (si clé dispo) côté serveur,
// pour éviter les soucis CORS d'un appel direct depuis le navigateur.
//
// Usage : /api/search-games?q=the
// ==========================================================

const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '') || null;

export default async function handler(req, res) {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
        return res.status(200).json({ suggestions: [] });
    }

    let steamNames = [];
    let rawgNames = [];

    try {
        const steamRes = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=french&cc=fr`);
        if (steamRes.ok) {
            const data = await steamRes.json();
            steamNames = (data.items || []).map(i => i.name).filter(Boolean);
        }
    } catch (e) {
        console.error('search-games: erreur Steam', e.message);
    }

    if (RAWG_API_KEY) {
        try {
            const rawgRes = await fetch(`https://api.rawg.io/api/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(q)}&page_size=8`);
            if (rawgRes.ok) {
                const data = await rawgRes.json();
                rawgNames = (data.results || []).map(g => g.name).filter(Boolean);
            }
        } catch (e) {
            console.error('search-games: erreur RAWG', e.message);
        }
    }

    // Fusionne en gardant l'ordre (Steam en premier, généralement plus pertinent), dédoublonne, limite à 8
    const seen = new Set();
    const merged = [];
    for (const name of [...steamNames, ...rawgNames]) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(name);
        }
        if (merged.length >= 8) break;
    }

    // Petit cache navigateur (5 min) pour limiter les appels si quelqu'un retape la même chose
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({ suggestions: merged });
}
