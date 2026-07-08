// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Deux usages :
//
// 1) Autocomplétion : /api/search-games?q=the
//    Renvoie { suggestions: [{name, year}, ...] } triés par date de sortie
//    croissante (Steam + RAWG), DLC exclus.
//
// 2) Résolution d'indice année : /api/search-games?resolve=1&name=Fallout
//    Renvoyé { name, year } pour la meilleure correspondance trouvée —
//    utilisé pour l'indice "avant/après" quand le joueur a tapé sa réponse
//    à la main (sans passer par une suggestion, qui porte déjà son année).
//
// Interroge Steam (storesearch) + RAWG (si clé dispo) côté serveur, pour
// éviter les soucis CORS d'un appel direct depuis le navigateur.
// Debug : ajoute &debug=1 à n'importe quelle requête ci-dessus.
//
// Optimisations vitesse :
//  - Steam et RAWG interrogés EN PARALLÈLE (avant : l'un après l'autre).
//  - Les années Steam sont d'abord héritées des résultats RAWG (même nom
//    normalisé) : zéro appel réseau supplémentaire dans la majorité des cas.
//  - Les rares appels "appdetails" restants sont plafonnés, parallèles,
//    et coupés au bout de 1,2 s (un appel lent ne bloque plus la réponse).
// Exclusion des DLC (3 filets complémentaires) :
//  - RAWG : paramètre exclude_additions (exclut les fiches DLC à la source).
//  - Steam : champ "type" de storesearch quand présent, et type "dlc"
//    renvoyé par appdetails pour les jeux qu'on enrichit.
//  - Motif de nom (dlc, season pass, expansion, soundtrack…) en dernier filet.
// ==========================================================

const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '') || null;
const RAWG_BASE = 'https://api.rawg.io/api';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter)\b/i;

// Filet de nom anti-DLC. Le mot "pack" seul est très évocateur de DLC
// ("Mechromancer Pack", "Ultimate Vault Hunter Upgrade Pack"...), avec une
// exception pour les vrais jeux type "The Jackbox Party Pack".
function isDlcName(name) {
    if (DLC_NAME_PATTERN.test(name)) return true;
    if (/\bpack\b/i.test(name) && !/party pack/i.test(name)) return true;
    return false;
}

function yearFromDateStr(str) {
    if (!str) return null;
    const m = String(str).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
}

// Normalisation de nom pour apparier Steam <-> RAWG ("Half-Life 2™" == "half life 2")
function normalizeName(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ───────────────────────── IGDB (repli quand Steam + RAWG n'ont rien) ─────────────────────────
// Utilisé en dernier recours pour l'année, uniquement quand Steam et RAWG n'ont
// rien donné. Cas typique : titres indés confidentiels — moins de 10 ajouts
// RAWG (filtre anti-troll) et/ou appdetails Steam trop lent (timeout 1,2 s).
// Correspondance PRUDENTE (même logique que generate-daily.js) : mieux vaut
// aucune année qu'une année associée au mauvais jeu.
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim() || null;
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim() || null;
const IGDB_BASE = 'https://api.igdb.com/v4';
let igdbTokenCache = { token: null, expiresAt: 0 };

async function getIgdbToken() {
    if (igdbTokenCache.token && Date.now() < igdbTokenCache.expiresAt - 60000) return igdbTokenCache.token;
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`Twitch token: ${res.status}`);
    const data = await res.json();
    igdbTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return igdbTokenCache.token;
}

async function igdbQuery(endpoint, body, timeoutMs) {
    const token = await getIgdbToken();
    const res = await fetch(`${IGDB_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'text/plain'
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`IGDB a répondu ${res.status}`);
    return res.json();
}

// Levenshtein minimal (copie locale volontaire : ce fichier ne dépend d'aucun
// autre module pour rester autonome).
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Renvoie une année (nombre) ou null. `timeoutMs` volontairement court côté
// autocomplétion (ne doit pas ralentir la frappe) et plus large côté résolution
// manuelle (un seul appel, pas à chaque lettre tapée).
async function igdbYearForName(name, timeoutMs) {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
    const clean = String(name || '').replace(/[™®©"]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    try {
        const rows = await igdbQuery('games', `search "${clean}"; fields name,first_release_date; limit 8;`, timeoutMs);
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const target = normalizeName(clean);
        let best = rows.find(r => normalizeName(r.name || '') === target);
        if (!best) best = rows.find(r => {
            const n = normalizeName(r.name || '');
            return n && Math.abs(n.length - target.length) <= 3 && levenshtein(n, target) <= 2;
        });
        if (!best || !best.first_release_date) return null;
        return new Date(best.first_release_date * 1000).getUTCFullYear();
    } catch (e) {
        return null; // best-effort : timeout/erreur -> simplement pas d'année, comme Steam/RAWG
    }
}

// fetch avec délai maximum : au-delà, on abandonne cet appel (sans faire
// échouer les autres) pour que la réponse globale reste rapide.
function fetchWithTimeout(url, ms) {
    return fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(ms) });
}

// Cache mémoire (survit tant que l'instance serverless reste "chaude").
// Stocke { year, type } par appid pour éviter de rappeler Steam à chaque frappe.
const steamAppInfoCache = new Map();

async function fetchSteamAppInfo(appid, timeoutMs = 1200) {
    if (steamAppInfoCache.has(appid)) return steamAppInfoCache.get(appid);
    try {
        const res = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&filters=basic`, timeoutMs);
        if (!res.ok) { steamAppInfoCache.set(appid, null); return null; }
        const json = await res.json();
        const entry = json[appid];
        if (!entry || !entry.success || !entry.data) { steamAppInfoCache.set(appid, null); return null; }
        const info = {
            year: yearFromDateStr(entry.data.release_date && entry.data.release_date.date),
            type: entry.data.type || null // "game" | "dlc" | "music" | ...
        };
        steamAppInfoCache.set(appid, info);
        return info;
    } catch (e) {
        return null; // timeout ou échec réseau : pas de cache, on retentera au prochain appel
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

    const debugInfo = {};

    // Steam et RAWG en parallèle : le temps de réponse = le plus lent des deux,
    // au lieu de la somme des deux.
    const steamPromise = (async () => {
        try {
            const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`;
            const r = await fetchWithTimeout(url, 3000);
            debugInfo.steamStatus = r.status;
            if (!r.ok) { debugInfo.steamBody = (await r.text()).slice(0, 200); return []; }
            const data = await r.json();
            debugInfo.steamCount = (data.items || []).length;
            // "type" vaut "game" pour un vrai jeu ; on exclut explicitement les DLC.
            // Les entrées sans "type" sont gardées ici, re-filtrées plus bas via appdetails.
            return (data.items || []).filter(i => i && i.name && i.type !== 'dlc');
        } catch (e) {
            debugInfo.steamError = e.message;
            return [];
        }
    })();

    const rawgPromise = (async () => {
        if (!RAWG_API_KEY) { debugInfo.rawgSkipped = 'RAWG_API_KEY absente'; return []; }
        try {
            // exclude_additions=true : demande à RAWG d'exclure les fiches DLC.
            // ⚠️ En pratique RAWG ignore ce paramètre quand "search" est utilisé
            // (confirmé sur le terrain) : on le garde par principe, mais le vrai
            // filtrage des fiches DLC RAWG se fait plus bas (croisement avec les
            // types Steam + motif de nom).
            const url = `${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(q)}&search_precise=true&page_size=20&exclude_additions=true`;
            const r = await fetchWithTimeout(url, 3000);
            debugInfo.rawgStatus = r.status;
            if (!r.ok) { debugInfo.rawgBody = (await r.text()).slice(0, 200); return []; }
            const data = await r.json();
            debugInfo.rawgCount = (data.results || []).length;
            // RAWG fonctionne comme un wiki : n'importe qui peut soumettre une fiche.
            // Le champ "added" (nb d'utilisateurs qui ont ajouté le jeu à une liste)
            // sert de filet anti-troll léger.
            const MIN_RAWG_ADDED = 10;
            const filtered = (data.results || []).filter(g => g && g.name && (g.added || 0) >= MIN_RAWG_ADDED);
            debugInfo.rawgFilteredOut = (data.results || []).length - filtered.length;
            return filtered;
        } catch (e) {
            debugInfo.rawgError = e.message;
            return [];
        }
    })();

    const [steamItems, rawgResults] = await Promise.all([steamPromise, rawgPromise]);

    // Vérification de type pour TOUS les résultats Steam affichables (pas
    // seulement ceux sans année) : la recherche Steam ne marque presque jamais
    // les DLC ("Dead by Daylight - Ghost Face" arrive en type "app"), seule la
    // fiche appdetails est fiable. Les appels sont parallèles, mis en cache
    // (mémoire chaude + les mêmes appids reviennent à chaque frappe) et coupés
    // à 1,2 s — un timeout garde le jeu dans la liste (in dubio pro reo) mais
    // sans année. Bonus : appdetails fournit aussi l'année, plus fiable que
    // l'héritage RAWG. On garde l'héritage RAWG en secours après timeout.
    const rawgYearByName = new Map();
    rawgResults.forEach(g => {
        const y = yearFromDateStr(g.released);
        if (y) rawgYearByName.set(normalizeName(g.name), y);
    });

    const MAX_STEAM_LOOKUPS = 12;
    const steamEnriched = steamItems.slice(0, MAX_STEAM_LOOKUPS).map(i => ({
        name: i.name,
        id: i.id,
        year: null,
        dlc: false
    }));
    debugInfo.steamAppdetailsCalls = steamEnriched.length;
    await Promise.all(steamEnriched.map(async i => {
        const info = await fetchSteamAppInfo(i.id);
        if (!info) { // timeout/échec : on garde le jeu, année RAWG en secours
            i.year = rawgYearByName.get(normalizeName(i.name)) || null;
            return;
        }
        i.year = info.year || rawgYearByName.get(normalizeName(i.name)) || null;
        if (info.type && info.type !== 'game') i.dlc = true; // dlc, music, demo…
    }));

    // Les DLC confirmés côté Steam servent aussi à écarter leurs fiches jumelles
    // côté RAWG (mêmes noms) : RAWG ignore exclude_additions quand "search" est
    // utilisé, ses fiches DLC reviennent donc dans les résultats de recherche.
    const steamDlcNames = new Set(
        steamEnriched.filter(i => i.dlc).map(i => normalizeName(i.name))
    );

    // Fusion + déduplication + filets anti-DLC (nom + croisement Steam).
    const seen = new Set();
    const results = [];
    const push = (name, year) => {
        if (isDlcName(name)) return;
        const key = normalizeName(name);
        if (!key || seen.has(key)) return;
        if (steamDlcNames.has(key)) return; // fiche RAWG jumelle d'un DLC Steam confirmé
        seen.add(key);
        results.push({ name, year: year || null });
    };

    steamEnriched.forEach(i => { if (!i.dlc) push(i.name, i.year); });
    steamItems.slice(MAX_STEAM_LOOKUPS).forEach(i => push(i.name, rawgYearByName.get(normalizeName(i.name)) || null));
    rawgResults.forEach(g => push(g.name, yearFromDateStr(g.released)));

    // Repli IGDB : pour les quelques suggestions encore sans année après Steam/RAWG
    // (typiquement des titres confidentiels, peu ajoutés sur RAWG). Plafonné en
    // nombre et lancé en parallèle avec un timeout court : ne doit jamais faire
    // traîner la frappe. Un échec/timeout laisse simplement l'entrée sans année.
    const MAX_IGDB_LOOKUPS = 4;
    const stillYearless = results.filter(r => !r.year).slice(0, MAX_IGDB_LOOKUPS);
    debugInfo.igdbLookups = stillYearless.length;
    if (stillYearless.length > 0) {
        await Promise.all(stillYearless.map(async r => {
            const y = await igdbYearForName(r.name, 900);
            if (y) r.year = y;
        }));
    }

    // Tri par date de sortie croissante ; les jeux sans date connue passent après,
    // triés alphabétiquement entre eux pour rester stables/prévisibles.
    results.sort((a, b) => {
        if (a.year && b.year) return a.year - b.year;
        if (a.year && !b.year) return -1;
        if (!a.year && b.year) return 1;
        return a.name.localeCompare(b.name);
    });

    const merged = results.slice(0, 15);

    // Cache CDN Vercel : la même saisie ("borderlands") faite par n'importe qui
    // dans les 5 minutes est servie instantanément depuis le cache, sans toucher
    // Steam/RAWG. Gros gain ressenti sur les préfixes courants.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(debug ? { suggestions: merged, debug: debugInfo } : { suggestions: merged });
}

// ───────────────────────── Résolution année (pour l'indice avant/après) ─────────────────────────
// N'est plus appelée que pour les réponses tapées à la main sans passer par une
// suggestion (les suggestions portent déjà leur année, transmise par le client).

async function handleResolve(req, res, debug) {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(200).json({ year: null });

    const debugInfo = {};
    // Même réponse pour le même nom pendant 24h : les dates de sortie ne bougent pas.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

    // 1) RAWG d'abord (exclude_additions pour ne pas résoudre sur une fiche DLC).
    // On récupère plusieurs résultats et on garde le premier qui a réellement une année.
    if (RAWG_API_KEY) {
        try {
            const r = await fetchWithTimeout(`${RAWG_BASE}/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(name)}&search_precise=true&page_size=5&exclude_additions=true`, 3000);
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

    // 2) Repli Steam : on teste les 3 premiers résultats EN PARALLÈLE et on garde
    // le premier (dans l'ordre de pertinence) qui a une date — avant, les appels
    // appdetails étaient séquentiels, jusqu'à 3 allers-retours d'affilée.
    try {
        const sr = await fetchWithTimeout(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=us`, 3000);
        debugInfo.steamSearchStatus = sr.status;
        if (sr.ok) {
            const sd = await sr.json();
            const topCandidates = (sd.items || []).filter(i => i && i.id).slice(0, 3);
            debugInfo.steamCandidateCount = topCandidates.length;
            const infos = await Promise.all(topCandidates.map(i => fetchSteamAppInfo(i.id)));
            for (let k = 0; k < topCandidates.length; k++) {
                const info = infos[k];
                if (info && info.year) {
                    return res.status(200).json(debug ? { name: topCandidates[k].name, year: info.year, debug: debugInfo } : { name: topCandidates[k].name, year: info.year });
                }
            }
        }
    } catch (e) {
        debugInfo.steamError = e.message;
    }

    // 3) Dernier repli : IGDB. Un seul appel ici (pas à chaque frappe comme dans
    // l'autocomplétion), donc un timeout plus large est acceptable. C'est souvent
    // la seule source qui connaît vraiment les titres confidentiels que Steam/RAWG
    // traitent mal (peu d'ajouts RAWG, appdetails Steam capricieux).
    const igdbYear = await igdbYearForName(name, 2500);
    if (igdbYear) {
        debugInfo.igdbUsed = true;
        return res.status(200).json(debug ? { name, year: igdbYear, debug: debugInfo } : { name, year: igdbYear });
    }

    return res.status(200).json(debug ? { year: null, debug: debugInfo } : { year: null });
}
