// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Proxy de recherche de jeux pour l'autocomplétion côté client.
// Interroge Steam (storesearch) + RAWG (si clé dispo) côté serveur,
// pour éviter les soucis CORS d'un appel direct depuis le navigateur.
//
// Usage : /api/search-games?q=the
// Debug : /api/search-games?q=the&debug=1  (renvoie les codes de statut
//         bruts des appels Steam/RAWG, pratique pour diagnostiquer)
// ==========================================================

const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '') || null;

// Steam bloque parfois les requêtes serveur-à-serveur sans en-tête User-Agent
// "de navigateur" (renvoie une page vide ou une erreur au lieu du JSON attendu).
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

export default async function handler(req, res) {
    const q = (req.query.q || '').trim();
    const debug = req.query.debug === '1';

    if (q.length < 2) {
        return res.status(200).json({ suggestions: [] });
    }

    let steamNames = [];
    let rawgResults = [];
    const debugInfo = {};

    try {
        const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`;
        const steamRes = await fetch(steamUrl, { headers: BROWSER_HEADERS });
        debugInfo.steamStatus = steamRes.status;
        if (steamRes.ok) {
            const data = await steamRes.json();
            debugInfo.steamCount = (data.items || []).length;
            steamNames = (data.items || []).map(i => i.name).filter(Boolean);
        } else {
            debugInfo.steamBody = (await steamRes.text()).slice(0, 200);
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    if (RAWG_API_KEY) {
        try {
            const rawgUrl = `https://api.rawg.io/api/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(q)}&search_precise=true&page_size=8`;
            const rawgRes = await fetch(rawgUrl, { headers: BROWSER_HEADERS });
            debugInfo.rawgStatus = rawgRes.status;
            if (rawgRes.ok) {
                const data = await rawgRes.json();
                debugInfo.rawgCount = (data.results || []).length;
                rawgResults = (data.results || []).filter(g => g && g.name);
            } else {
                debugInfo.rawgBody = (await rawgRes.text()).slice(0, 200);
            }
        } catch (e) {
            debugInfo.rawgError = e.message;
        }
    } else {
        debugInfo.rawgSkipped = 'RAWG_API_KEY absente';
    }

    // Fusionne : Steam d'abord (catalogue le plus large côté PC), puis RAWG (consoles/rétro).
    // Priorise les noms qui COMMENCENT par la recherche (comme demandé), puis le reste.
    const qNorm = q.toLowerCase();
    const seen = new Set();
    const starts = [];
    const contains = [];

    const pushName = name => {
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        (key.startsWith(qNorm) ? starts : contains).push(name);
    };

    steamNames.forEach(pushName);
    rawgResults.forEach(g => pushName(g.name));

    const merged = [...starts, ...contains].slice(0, 10);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    if (debug) {
        return res.status(200).json({ suggestions: merged, debug: debugInfo });
    }
    return res.status(200).json({ suggestions: merged });
}
