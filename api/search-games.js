// ==========================================================
// /api/search-games.js — Vercel Serverless Function
// Deux usages :
//
// 1) Autocomplétion : /api/search-games?q=the
//    Renvoie { suggestions: [{name, year}, ...] } triés par date de sortie
//    croissante (IGDB + Steam), DLC exclus.
//
// 2) Résolution d'indice année : /api/search-games?resolve=1&name=Fallout
//    Renvoyé { name, year } pour la meilleure correspondance trouvée —
//    utilisé pour l'indice "avant/après" quand le joueur a tapé sa réponse
//    à la main (sans passer par une suggestion, qui porte déjà son année).
//
// Interroge IGDB (source principale, gratuite via Twitch) + Steam
// (storesearch, en complément) côté serveur, pour éviter les soucis CORS
// d'un appel direct depuis le navigateur.
// Debug : ajoute &debug=1 à n'importe quelle requête ci-dessus.
//
// RAWG a été retiré (remplacé par IGDB, qui a une couverture bien plus large
// et renvoie déjà la date de sortie ET le type "jeu principal" en UNE seule
// requête — avant, on devait rappeler Steam "appdetails" jeu par jeu pour
// avoir une année fiable, ce qui ralentissait beaucoup l'autocomplétion).
//
// Recherche IGDB : "search" + "fields" SEULS (confirmé fonctionnel en usage réel).
// Deux pièges rencontrés et évités :
//  1) "search" combiné à un "where" (ex. category = 0) renvoie 0 résultat,
//     silencieusement (bug constaté sur le terrain).
//  2) "search" classe par pertinence interne à IGDB, ce qui peut reléguer un
//     titre très connu (ex. "Uncharted 4") derrière des titres obscurs sur une
//     saisie partielle ("Unchar") — limitation constatée et non résolue pour
//     l'instant (une tentative de filtre "contient" a cassé la recherche et a
//     été retirée, faute de pouvoir tester la syntaxe IGDB en conditions réelles
//     depuis cet environnement).
//
// Optimisations vitesse :
//  - IGDB et Steam interrogés EN PARALLÈLE (le temps de réponse = le plus
//    lent des deux, pas la somme).
//  - Plus AUCUN appel "appdetails" par jeu : IGDB fournit déjà l'année et
//    le filtre anti-DLC (category = 0) en un seul aller-retour. Les
//    résultats Steam sans correspondance IGDB héritent de l'année IGDB
//    par nom normalisé quand elle existe, sinon restent sans année (plutôt
//    que de ralentir la recherche pour l'obtenir).
// Exclusion des DLC (2 filets complémentaires) :
//  - IGDB : filtre "category = 0" (jeu principal), qui exclut nativement
//    DLC/extensions/éditions/remasters/remakes/ports…
//  - Steam : champ "type" de storesearch quand présent, + motif de nom
//    (dlc, season pass, expansion, soundtrack…) en dernier filet, pour les
//    deux sources.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

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

function yearFromUnixSeconds(ts) {
    if (!ts) return null;
    return new Date(ts * 1000).getUTCFullYear();
}

// Normalisation de nom pour apparier Steam <-> IGDB ("Half-Life 2™" == "half life 2")
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

// fetch avec délai maximum : au-delà, on abandonne cet appel (sans faire
// échouer les autres) pour que la réponse globale reste rapide.
function fetchWithTimeout(url, ms) {
    return fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(ms) });
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

    // IGDB et Steam en parallèle : le temps de réponse = le plus lent des deux,
    // au lieu de la somme des deux. Ni l'un ni l'autre ne fait plus d'appel
    // "détails" supplémentaire par jeu (c'était ça, le principal facteur de lenteur).
    const igdbPromise = (async () => {
        if (!isIgdbConfigured()) { debugInfo.igdbSkipped = 'TWITCH_CLIENT_ID/SECRET absents'; return []; }
        try {
            const clean = q.replace(/["\\]/g, '');
            // "search" + "fields" SEULS (confirmé fonctionnel). Un filtre "where" combiné
            // à "search" renvoie 0 résultat silencieusement (déjà constaté) ; une tentative
            // de filtre "contient" (~ *"texte"*) a aussi cassé la recherche — probablement
            // une syntaxe incorrecte de ma part, retirée faute de pouvoir la tester en direct.
            const rows = await igdbQuery('games',
                `search "${clean}"; fields name,first_release_date; limit 50;`,
                2500
            );
            debugInfo.igdbCount = Array.isArray(rows) ? rows.length : 0;
            return Array.isArray(rows) ? rows : [];
        } catch (e) {
            debugInfo.igdbError = e.message;
            return [];
        }
    })();

    const steamPromise = (async () => {
        try {
            const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`;
            const r = await fetchWithTimeout(url, 2500);
            debugInfo.steamStatus = r.status;
            if (!r.ok) { debugInfo.steamBody = (await r.text()).slice(0, 200); return []; }
            const data = await r.json();
            debugInfo.steamCount = (data.items || []).length;
            // "type" vaut "game" pour un vrai jeu ; on exclut explicitement les DLC.
            // Les entrées sans "type" sont gardées, filtrées par le motif de nom plus bas.
            return (data.items || []).filter(i => i && i.name && i.type !== 'dlc');
        } catch (e) {
            debugInfo.steamError = e.message;
            return [];
        }
    })();

    const [igdbResults, steamItems] = await Promise.all([igdbPromise, steamPromise]);

    // Année IGDB par nom normalisé, pour que les résultats Steam sans
    // correspondance IGDB directe (rare) héritent quand même d'une année
    // sans appel réseau supplémentaire.
    const igdbYearByName = new Map();
    igdbResults.forEach(g => {
        const y = yearFromUnixSeconds(g.first_release_date);
        if (y) igdbYearByName.set(normalizeName(g.name), y);
    });

    // Fusion + déduplication + filets anti-DLC (nom).
    const seen = new Set();
    const results = [];
    const push = (name, year) => {
        if (isDlcName(name)) return;
        const key = normalizeName(name);
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push({ name, year: year || null });
    };

    igdbResults.forEach(g => push(g.name, yearFromUnixSeconds(g.first_release_date)));
    steamItems.forEach(i => push(i.name, igdbYearByName.get(normalizeName(i.name)) || null));

    // Tri par date de sortie croissante ; les jeux sans date connue passent après,
    // triés alphabétiquement entre eux pour rester stables/prévisibles.
    results.sort((a, b) => {
        if (a.year && b.year) return a.year - b.year;
        if (a.year && !b.year) return -1;
        if (!a.year && b.year) return 1;
        return a.name.localeCompare(b.name);
    });

    const merged = results.slice(0, 20);

    // Cache CDN Vercel : la même saisie ("borderlands") faite par n'importe qui
    // dans les 5 minutes est servie instantanément depuis le cache, sans toucher
    // IGDB/Steam. Gros gain ressenti sur les préfixes courants.
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

    // IGDB et Steam en parallèle (avant : IGDB d'abord, PUIS Steam en repli —
    // donc jusqu'à deux allers-retours l'un après l'autre à chaque essai sans
    // année. C'était une des causes du "toujours aussi long" après validation
    // d'un essai, /api/guess.js appelant cette route en interne).

    const igdbPromise = (async () => {
        if (!isIgdbConfigured()) return null;
        try {
            const clean = name.replace(/["\\]/g, '');
            const rows = await igdbQuery('games',
                `search "${clean}"; fields name,first_release_date; limit 5;`,
                2000
            );
            debugInfo.igdbCount = Array.isArray(rows) ? rows.length : 0;
            const withYear = (rows || []).find(g => g && !isDlcName(g.name || '') && yearFromUnixSeconds(g.first_release_date));
            return withYear ? { name: withYear.name, year: yearFromUnixSeconds(withYear.first_release_date) } : null;
        } catch (e) {
            debugInfo.igdbError = e.message;
            return null;
        }
    })();

    const steamPromise = (async () => {
        try {
            const sr = await fetchWithTimeout(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=us`, 2000);
            debugInfo.steamSearchStatus = sr.status;
            if (!sr.ok) return null;
            const sd = await sr.json();
            const topCandidates = (sd.items || []).filter(i => i && i.id && !isDlcName(i.name || '')).slice(0, 3);
            debugInfo.steamCandidateCount = topCandidates.length;
            const infos = await Promise.all(topCandidates.map(async i => {
                try {
                    const dr = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${i.id}&l=english&filters=basic`, 1000);
                    if (!dr.ok) return null;
                    const dj = await dr.json();
                    const entry = dj[i.id];
                    if (!entry || !entry.success || !entry.data) return null;
                    return yearFromDateStr(entry.data.release_date && entry.data.release_date.date);
                } catch (e) {
                    return null;
                }
            }));
            for (let k = 0; k < topCandidates.length; k++) {
                if (infos[k]) return { name: topCandidates[k].name, year: infos[k] };
            }
            return null;
        } catch (e) {
            debugInfo.steamError = e.message;
            return null;
        }
    })();

    const [igdbResult, steamResult] = await Promise.all([igdbPromise, steamPromise]);
    // IGDB prioritaire (dates plus fiables), Steam en repli.
    const best = igdbResult || steamResult;
    if (best) {
        return res.status(200).json(debug ? { ...best, debug: debugInfo } : best);
    }

    return res.status(200).json(debug ? { year: null, debug: debugInfo } : { year: null });
}
