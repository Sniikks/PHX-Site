// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Deux usages :
//
// 1) Autocomplétion : /api/search-games?q=the
//    Renvoie { suggestions: [{name, year}, ...] } triés par date de sortie
//    croissante (Steam + RAWG). "year" est null quand la date n'a pas pu être
//    récupérée (au-delà des 8 premiers résultats Steam, pour limiter le coût).
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

// Cache mémoire (survit tant que l'instance serverless reste "chaude" entre deux
// requêtes rapprochées — typiquement le cas pendant une saisie au clavier).
// Évite de refaire un appel Steam appdetails pour le même jeu à chaque frappe.
const steamYearCache = new Map();

async function fetchSteamReleaseYear(appid) {
    if (steamYearCache.has(appid)) return steamYearCache.get(appid);
    try {
        const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, { headers: BROWSER_HEADERS });
        if (!res.ok) { steamYearCache.set(appid, null); return null; }
        const json = await res.json();
        const entry = json[appid];
        const year = entry && entry.success && entry.data
            ? yearFromDateStr(entry.data.release_date && entry.data.release_date.date)
            : null;
        steamYearCache.set(appid, year);
        return year;
    } catch (e) {
        return null; // pas de cache sur échec réseau : on retentera au prochain appel
    }
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
            // "type" vaut "game" pour un vrai jeu ; on exclut explicitement les DLC.
            // Les entrées sans "type" (rare, mais arrive) sont gardées par sécurité.
            steamItems = (data.items || []).filter(i => i && i.name && i.type !== 'dlc');
        } else {
            debugInfo.steamBody = (await steamRes.text()).slice(0, 200);
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    if (RAWG_API_KEY) {
        try {
            // page_size augmenté (8 → 20) pour couvrir vraiment tous les jeux correspondants,
            // pas seulement la petite poignée la plus évidente.
            const rawgUrl = `${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(q)}&search_precise=true&page_size=20`;
            const rawgRes = await fetch(rawgUrl, { headers: BROWSER_HEADERS });
            debugInfo.rawgStatus = rawgRes.status;
            if (rawgRes.ok) {
                const data = await rawgRes.json();
                debugInfo.rawgCount = (data.results || []).length;
                // RAWG fonctionne comme un wiki : n'importe qui peut soumettre une fiche.
                // Ça inclut de vrais jeux obscurs, mais aussi des fiches troll/blague ou des
                // prototypes de game jam abandonnés. Le champ "added" (nb d'utilisateurs qui
                // ont ajouté le jeu à une liste) sert de filet anti-troll léger : un vrai jeu,
                // même obscur, a presque toujours au moins un peu d'activité.
                const MIN_RAWG_ADDED = 10;
                rawgResults = (data.results || []).filter(g => g && g.name && (g.added || 0) >= MIN_RAWG_ADDED);
                debugInfo.rawgFilteredOut = (data.results || []).length - rawgResults.length;
            } else {
                debugInfo.rawgBody = (await rawgRes.text()).slice(0, 200);
            }
        } catch (e) {
            debugInfo.rawgError = e.message;
        }
    } else {
        debugInfo.rawgSkipped = 'RAWG_API_KEY absente';
    }

    // Année Steam : pas fournie par storesearch, il faut un appel appdetails par jeu.
    // On les récupère pour tous les résultats Steam (pas seulement les plus populaires),
    // sinon des jeux moins connus (ex: petits jeux indés) restent sans date. Lancés en
    // parallèle + mis en cache pour limiter le coût réel côté temps de réponse.
    // Garde-fou : sur une recherche très large (terme générique), Steam peut renvoyer
    // 30-50 résultats — on plafonne à 20 appels appdetails en parallèle pour éviter
    // de se faire rate-limiter par Steam. Au-delà, pas de date (mieux que planter).
    const MAX_STEAM_DATE_LOOKUPS = 20;
    const steamForDates = steamItems.slice(0, MAX_STEAM_DATE_LOOKUPS);
    const steamYears = await Promise.all(steamForDates.map(i => fetchSteamReleaseYear(i.id)));

    // Fusionne : Steam (avec année) + RAWG (avec année).
    const seen = new Set();
    const results = [];

    // Filet de sécurité supplémentaire par le nom (RAWG n'a pas de champ "type" DLC,
    // et certaines entrées Steam n'ont parfois pas le champ "type" non plus).
    const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|skin pack|costume pack|weapon pack|outfit pack)\b/i;

    const push = (name, year) => {
        if (DLC_NAME_PATTERN.test(name)) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ name, year: year || null });
    };

    steamForDates.forEach((item, idx) => push(item.name, steamYears[idx]));
    steamItems.slice(MAX_STEAM_DATE_LOOKUPS).forEach(i => push(i.name, null)); // au-delà du plafond : pas de date, mais le jeu reste dans la liste
    rawgResults.forEach(g => push(g.name, yearFromDateStr(g.released)));

    // Tri par date de sortie croissante ; les jeux sans date connue passent après,
    // triés alphabétiquement entre eux pour rester stables/prévisibles.
    results.sort((a, b) => {
        if (a.year && b.year) return a.year - b.year;
        if (a.year && !b.year) return -1;
        if (!a.year && b.year) return 1;
        return a.name.localeCompare(b.name);
    });

    const merged = results.slice(0, 15);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(debug ? { suggestions: merged, debug: debugInfo } : { suggestions: merged });
}

// ───────────────────────── Résolution année (pour l'indice avant/après) ─────────────────────────

async function handleResolve(req, res, debug) {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(200).json({ year: null });

    const debugInfo = {};

    // 1) RAWG d'abord. On récupère plusieurs résultats (pas juste le 1er) et on garde le
    // premier qui a réellement une année : avant, un 1er résultat "pertinent" mais sans date
    // connue (jeu à venir, fiche incomplète...) faisait échouer l'indice alors qu'un résultat
    // juste derrière aurait suffi. search_precise=true (déjà utilisé pour l'autocomplétion)
    // resserre aussi la pertinence du matching sur le nom tapé.
    if (RAWG_API_KEY) {
        try {
            const r = await fetch(`${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(name)}&search_precise=true&page_size=5`, { headers: BROWSER_HEADERS });
            debugInfo.rawgStatus = r.status;
            if (r.ok) {
                const d = await r.json();
                debugInfo.rawgCount = (d.results || []).length;
                const withYear = (d.results || []).find(g => g && yearFromDateStr(g.released));
                if (withYear) {
                    const year = yearFromDateStr(withYear.released);
                    return res.status(200).json(debug ? { name: withYear.name, year, debug: debugInfo } : { name: withYear.name, year });
                }
            }
        } catch (e) {
            debugInfo.rawgError = e.message;
        }
    }

    // 2) Repli Steam : avant, on ne regardait que le tout premier résultat de recherche —
    // s'il n'avait pas de date exploitable (coming_soon, fiche incomplète), on abandonnait.
    // On teste maintenant les 3 premiers résultats et on garde le premier avec une date.
    try {
        const sr = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=us`, { headers: BROWSER_HEADERS });
        debugInfo.steamSearchStatus = sr.status;
        if (sr.ok) {
            const sd = await sr.json();
            const topCandidates = (sd.items || []).slice(0, 3);
            debugInfo.steamCandidateCount = topCandidates.length;
            for (const top of topCandidates) {
                if (!top || !top.id) continue;
                const ar = await fetch(`https://store.steampowered.com/api/appdetails?appids=${top.id}`, { headers: BROWSER_HEADERS });
                if (!ar.ok) continue;
                const aj = await ar.json();
                const entry = aj[top.id];
                const year = yearFromDateStr(entry?.data?.release_date?.date);
                if (year) {
                    return res.status(200).json(debug ? { name: top.name, year, debug: debugInfo } : { name: top.name, year });
                }
            }
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    return res.status(200).json(debug ? { year: null, debug: debugInfo } : { year: null });
}
