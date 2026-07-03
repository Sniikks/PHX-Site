// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Deux usages :
//
// 1) Autocomplétion : /api/search-games?q=the
//    Renvoie { suggestions: [{name, year}, ...] } — year est null quand
//    l'info n'est pas dispo à faible coût (cas des résultats Steam).
//
// 2) Résolution d'indice année : /api/search-games?resolve=1&name=Fallout
//    Renvoie { name, year } pour la meilleure correspondance trouvée —
//    utilisé pour donner un indice "avant/après" sur une réponse fausse.
//    Un peu plus lent (peut faire un appel Steam appdetails en plus), donc
//    réservé au moment où le joueur valide une réponse, pas à chaque frappe.
//
// Interroge Steam (storesearch) + RAWG (si clé dispo) côté serveur, pour
// éviter les soucis CORS d'un appel direct depuis le navigateur.
// Debug : ajoute &debug=1 à n'importe quelle requête ci-dessus.
// ==========================================================

const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '') || null;
const RAWG_BASE = 'https://api.rawg.io/api';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

function yearFromDateStr(str) {
    if (!str) return null;
    const m = String(str).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
}

export default async function handler(req, res) {
    const debug = req.query.debug === '1';

    if (req.query.resolve === '1') {
        return handleResolve(req, res, debug);
    }
    return handleAutocomplete(req, res, debug);
}

// ───────────────────────── Autocomplétion (liste de suggestions) ─────────────────────────

async function handleAutocomplete(req, res, debug) {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(200).json({ suggestions: [] });

    let steamItems = [];
    let rawgResults = [];
    const debugInfo = {};

    try {
        const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`;
        const steamRes = await fetch(steamUrl, { headers: BROWSER_HEADERS });
        debugInfo.steamStatus = steamRes.status;
        if (steamRes.ok) {
            const data = await steamRes.json();
            debugInfo.steamCount = (data.items || []).length;
            steamItems = (data.items || []).filter(i => i && i.name);
        } else {
            debugInfo.steamBody = (await steamRes.text()).slice(0, 200);
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    if (RAWG_API_KEY) {
        try {
            const rawgUrl = `${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(q)}&search_precise=true&page_size=8`;
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

    // Fusionne : Steam d'abord, puis RAWG. Priorise les noms qui COMMENCENT par la recherche.
    const qNorm = q.toLowerCase();
    const seen = new Set();
    const starts = [];
    const contains = [];

    const push = (name, year) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        (key.startsWith(qNorm) ? starts : contains).push({ name, year: year || null });
    };

    steamItems.forEach(i => push(i.name, null)); // pas d'année Steam ici (coût trop élevé pour l'autocomplete)
    rawgResults.forEach(g => push(g.name, yearFromDateStr(g.released)));

    const merged = [...starts, ...contains].slice(0, 10);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(debug ? { suggestions: merged, debug: debugInfo } : { suggestions: merged });
}

// ───────────────────────── Résolution année (pour l'indice avant/après) ─────────────────────────

async function handleResolve(req, res, debug) {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(200).json({ year: null });

    const debugInfo = {};

    // 1) RAWG d'abord : une seule requête suffit à avoir l'année.
    if (RAWG_API_KEY) {
        try {
            const r = await fetch(`${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(name)}&page_size=1`, { headers: BROWSER_HEADERS });
            debugInfo.rawgStatus = r.status;
            if (r.ok) {
                const d = await r.json();
                const g = (d.results || [])[0];
                const year = g ? yearFromDateStr(g.released) : null;
                if (year) {
                    return res.status(200).json(debug ? { name: g.name, year, debug: debugInfo } : { name: g.name, year });
                }
            }
        } catch (e) {
            debugInfo.rawgError = e.message;
        }
    }

    // 2) Repli Steam : recherche + appdetails sur le premier résultat seulement
    //    (un appel de plus, mais on ne le fait qu'une fois par réponse validée, pas à chaque frappe).
    try {
        const sr = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=us`, { headers: BROWSER_HEADERS });
        debugInfo.steamSearchStatus = sr.status;
        if (sr.ok) {
            const sd = await sr.json();
            const top = (sd.items || [])[0];
            if (top && top.id) {
                const ar = await fetch(`https://store.steampowered.com/api/appdetails?appids=${top.id}`, { headers: BROWSER_HEADERS });
                debugInfo.steamDetailsStatus = ar.status;
                if (ar.ok) {
                    const aj = await ar.json();
                    const entry = aj[top.id];
                    const year = yearFromDateStr(entry?.data?.release_date?.date);
                    if (year) {
                        return res.status(200).json(debug ? { name: top.name, year, debug: debugInfo } : { name: top.name, year });
                    }
                }
            }
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    return res.status(200).json(debug ? { year: null, debug: debugInfo } : { year: null });
}
