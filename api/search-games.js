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
// Recherche IGDB : filtre "contient" (where name ~ *"texte"* & version_parent
// = null), testé et confirmé en conditions réelles — PAS le mode "search" flou
// d'IGDB. Trois pièges rencontrés et évités, tous testés via une route de debug
// temporaire (/api/igdb-test.js) plutôt qu'à l'aveugle :
//  1) "search" combiné à un "where" (ex. category = 0) renvoie 0 résultat.
//  2) "search" seul classe par pertinence interne à IGDB, ce qui reléguait des
//     titres très connus (ex. "Uncharted 4") derrière des titres obscurs sur une
//     saisie partielle ("Unchar").
//  3) le filtre "category = 0" renvoie 0 résultat À LUI SEUL, indépendamment de
//     tout le reste (confirmé par un test isolé) — on utilise donc uniquement
//     "version_parent = null" pour écarter les éditions (GOTY, Special Edition…),
//     complété par le filtre anti-DLC par motif de nom pour le reste.
// Le "contient" (et non un simple "commence par") est important : il trouve
// aussi les jeux où le mot cherché n'est pas en tout début de titre (ex. "Star
// Wolves", "MechWarrior 5: Clans - Wolves of Tukayyid" pour la recherche "wolves").
//
// Optimisations vitesse :
//  - IGDB et Steam interrogés EN PARALLÈLE (le temps de réponse = le plus
//    lent des deux, pas la somme).
//  - Plus de boucle "appdetails" systématique par jeu (c'était le principal
//    facteur de lenteur). IGDB fournit déjà l'année pour la grande majorité
//    des jeux en un seul aller-retour. Pour les rares jeux qu'IGDB n'a pas
//    datés, un filet de secours BORNÉ (8 appels Steam max, en parallèle,
//    délai court) comble le trou — impact quasi nul le reste du temps.
// Exclusion des DLC (2 filets complémentaires) :
//  - IGDB : "version_parent = null" exclut la plupart des éditions.
//  - Steam + IGDB : motif de nom (dlc, season pass, expansion, extra area,
//    soundtrack…) en dernier filet, pour les deux sources.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Durée de vie du cache DB avant de retenter IGDB/Steam pour cette même
// saisie (au-delà, la saisie est "rafraîchie" une fois puis re-cachée pour
// 24h de plus). 24h = compromis entre fraîcheur (un jeu qui sort aujourd'hui
// doit finir par apparaître) et vitesse (l'immense majorité des saisies ne
// changent pas de réponse d'un jour à l'autre).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|extra area)\b/i;

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

// ── Motifs IGDB insensibles aux séparateurs ("-", "_", ":") ──
// IGDB compare le filtre "~" au titre de façon littérale : taper "half life 2"
// (espaces) ne trouve PAS "Half-Life 2" (tiret), le caractère à cette position
// ne correspond pas. On découpe donc la saisie en mots (en traitant espace,
// tiret, underscore et deux-points comme des séparateurs équivalents), puis on
// enchaîne des segments littéraux séparés par "*" (le wildcard IGDB déjà
// utilisé et testé ailleurs dans ce fichier) : "*" entre deux mots veut dire
// "n'importe quoi ici", ce qui couvre aussi bien un tiret, un espace, ou rien
// du tout entre les deux. Une saisie d'un seul mot (le cas le plus courant,
// ex. "spi") redonne exactement l'ancien motif — aucun changement pour elle.
function splitQueryWords(clean) {
    return clean.split(/[\s\-_:]+/).filter(Boolean);
}
function buildContainsPattern(clean) {
    const words = splitQueryWords(clean);
    if (words.length <= 1) return `*"${clean}"*`;
    return '*' + words.map(w => `"${w}"`).join('*') + '*';
}
function buildPrefixPattern(clean) {
    const words = splitQueryWords(clean);
    if (words.length <= 1) return `"${clean}"*`;
    return `"${words[0]}"` + words.slice(1).map(w => `*"${w}"`).join('') + '*';
}

// Cache mémoire (survit tant que l'instance serverless reste "chaude") pour le
// filet de secours ci-dessous : évite de rappeler Steam pour le même jeu à
// chaque frappe suivante.
const steamYearCache = new Map();

// Filet de secours BORNÉ : IGDB n'a pas de date pour tous les jeux (base pas
// complète à 100 %). Pour les rares cas où un résultat n'a toujours aucune
// année après IGDB, on tente un dernier appel Steam "appdetails" — mais
// seulement pour un petit nombre de jeux à la fois et avec un délai court,
// pour ne pas retomber dans la lenteur de l'ancienne boucle (jusqu'à 12
// appels par frappe, supprimée précédemment).
async function fetchSteamYear(appid, timeoutMs = 700) {
    if (steamYearCache.has(appid)) return steamYearCache.get(appid);
    try {
        const res = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&filters=basic`, timeoutMs);
        if (!res.ok) { steamYearCache.set(appid, null); return null; }
        const json = await res.json();
        const entry = json[appid];
        if (!entry || !entry.success || !entry.data) { steamYearCache.set(appid, null); return null; }
        const comingSoon = !!(entry.data.release_date && entry.data.release_date.coming_soon);
        const year = comingSoon ? null : yearFromDateStr(entry.data.release_date && entry.data.release_date.date);
        const result = { year, comingSoon };
        steamYearCache.set(appid, result);
        return result;
    } catch (e) {
        return null;
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
    // Le préfixe de version fait partie de la clé de cache : à chaque changement
    // de la logique de filtrage (DLC, éditions...), on l'incrémente pour que les
    // entrées mises en cache AVANT le correctif ne soient plus jamais servies
    // telles quelles — sans ça, une requête déjà en cache (ex. tapée pendant un
    // test) continue de renvoyer l'ancienne liste non filtrée pendant 24h,
    // même après un correctif déployé.
    // v3 : bump lié au correctif "préfixe garanti" ci-dessous — les entrées
    // mises en cache avant (résultats "commence par" parfois noyés/absents)
    // ne doivent plus être resservies telles quelles.
    const cacheId = 'v3:' + q.toLowerCase();

    // ── Cache écrit au fil de l'eau (table games_cache) ──
    // La toute première fois que quelqu'un tape cette saisie (tous joueurs/
    // jours confondus), on interroge IGDB/Steam normalement. Toutes les
    // fois suivantes, tant que le cache n'a pas expiré (24h), la réponse
    // vient directement de Supabase — SANS toucher IGDB/Steam, exprès : ça
    // évite de gaspiller leur quota (limité) sur des saisies déjà connues.
    // On garde donc cette vérification AVANT de lancer les appels externes
    // (les lancer en parallèle avec le cache économiserait ~100ms sur un
    // cache-miss, mais déclencherait IGDB/Steam même sur un cache-hit — et
    // sur Vercel, l'exécution peut être coupée juste après la réponse, donc
    // ces appels seraient de toute façon perdus. Le vrai gain de vitesse est
    // ailleurs : voir l'écriture de cache non bloquante plus bas).
    try {
        const { data: cached } = await supabase
            .from('games_cache').select('data, updated_at').eq('id', cacheId).maybeSingle();
        if (cached && (Date.now() - new Date(cached.updated_at).getTime()) < CACHE_TTL_MS) {
            debugInfo.cacheHit = true;
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
            return res.status(200).json(debug ? { suggestions: cached.data, debug: debugInfo } : { suggestions: cached.data });
        }
    } catch (e) {
        debugInfo.cacheReadError = e.message; // le cache est un bonus, jamais bloquant
    }

    const clean = q.replace(/["\\*]/g, '');
    const nowUnix = Math.floor(Date.now() / 1000);

    // IGDB, Steam et known_games en parallèle : le temps de réponse = le plus
    // lent des trois, au lieu de la somme. Aucun appel "détails" supplémentaire
    // par jeu (c'était ça, le principal facteur de lenteur, réglé précédemment).
    //
    // IGDB est maintenant interrogé en DEUX requêtes séparées plutôt qu'une
    // seule "contient" :
    //  - igdbPrefixPromise : "commence par" (name ~ "texte"*), avec sa PROPRE
    //    limite — garantit que les vrais jeux commençant par la saisie sont
    //    toujours dans le lot, quelle que soit leur popularité.
    //  - igdbContainsPromise : "contient" (name ~ *"texte"*), pour les jeux
    //    ayant le mot ailleurs dans le titre (ex. "Star Wolves" pour "wolves").
    // Avant, une seule requête "contient" triée par popularité + limit 50
    // pouvait faire disparaître des jeux "commence par" peu connus si trop
    // de jeux "contient" plus populaires remplissaient déjà les 50 places —
    // exactement le bug signalé ("spi" ne remontait que des jeux commençant
    // par Spi alors que des jeux avec Spi dedans existent aussi, et parfois
    // l'inverse pouvait arriver). Les deux pools sont ensuite fusionnés et
    // re-triés par pertinence (commence par > mot entier > sous-chaîne) plus
    // bas, donc "commence par" reste bien affiché AVANT "contient".
    const igdbPrefixPromise = (async () => {
        if (!isIgdbConfigured()) { debugInfo.igdbSkipped = 'TWITCH_CLIENT_ID/SECRET absents'; return []; }
        try {
            const rows = await igdbQuery('games',
                `fields name,first_release_date,total_rating_count,category; ` +
                `where name ~ ${buildPrefixPattern(clean)} & version_parent = null & parent_game = null & first_release_date < ${nowUnix}; ` +
                `sort total_rating_count desc; limit 30;`,
                1400
            );
            debugInfo.igdbPrefixCount = Array.isArray(rows) ? rows.length : 0;
            return Array.isArray(rows) ? rows : [];
        } catch (e) {
            debugInfo.igdbPrefixError = e.message;
            return [];
        }
    })();

    const igdbContainsPromise = (async () => {
        if (!isIgdbConfigured()) return [];
        try {
            // "first_release_date < maintenant" écarte les jeux pas encore sortis (et,
            // en prime, ceux sans date du tout côté IGDB — auquel cas ils peuvent
            // toujours remonter via Steam + le filet de secours plus bas).
            // "category" est demandé comme CHAMP renvoyé (pas comme filtre "where" —
            // c'est justement la combinaison "category = 0 dans where" qui est cassée).
            // Ça permet d'exclure ensuite en JS, de façon fiable, les catégories IGDB
            // qui ne sont jamais le jeu de base : 1=dlc_addon, 2=expansion, 3=bundle,
            // 5=mod, 6=episode, 7=season, 13=pack.
            const rows = await igdbQuery('games',
                `fields name,first_release_date,total_rating_count,category; ` +
                `where name ~ ${buildContainsPattern(clean)} & version_parent = null & parent_game = null & first_release_date < ${nowUnix}; ` +
                `sort total_rating_count desc; limit 50;`,
                1400
            );
            debugInfo.igdbContainsCount = Array.isArray(rows) ? rows.length : 0;
            return Array.isArray(rows) ? rows : [];
        } catch (e) {
            debugInfo.igdbContainsError = e.message;
            return [];
        }
    })();

    const steamPromise = (async () => {
        try {
            const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`;
            const r = await fetchWithTimeout(url, 1400);
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

    const knownGamesPromise = (async () => {
        try {
            // Avant : ILIKE '%q%' sur le nom brut — même souci que IGDB, "half
            // life 2" ne trouvait pas "Half-Life 2" (le tiret ne correspond pas
            // à l'espace tapé). Table minuscule (un jeu par puzzle conclu), donc
            // on récupère tout et on filtre en JS avec normalizeName (déjà
            // utilisé pour la déduplication plus bas), qui ignore ponctuation/
            // accents/casse des deux côtés — insensible aux séparateurs dans
            // les deux sens, contrairement à un ILIKE littéral.
            const { data, error } = await supabase.from('known_games').select('name, year').limit(1000);
            if (error) throw error;
            const normQ = normalizeName(q);
            const filtered = (Array.isArray(data) ? data : [])
                .filter(g => g && g.name && normalizeName(g.name).includes(normQ))
                .slice(0, 20);
            debugInfo.knownGamesCount = filtered.length;
            return filtered;
        } catch (e) {
            debugInfo.knownGamesError = e.message;
            return [];
        }
    })();

    const [igdbPrefixResults, igdbContainsResults, steamItems, knownGames] = await Promise.all([igdbPrefixPromise, igdbContainsPromise, steamPromise, knownGamesPromise]);
    const igdbResults = [...igdbPrefixResults, ...igdbContainsResults];

    // Année + popularité (total_rating_count) IGDB par nom normalisé : sert à
    // (1) donner une année aux résultats Steam sans correspondance IGDB directe,
    // (2) décider si un jeu SANS date connue est "vraiment connu" (voir plus bas).
    // Catégories IGDB qui ne sont jamais le jeu de base : 1=dlc_addon, 2=expansion,
    // 3=bundle, 4=standalone_expansion (manquait ici — catégorie confirmée via la
    // doc IGDB : c'est le cas de nombreux chapitres payants type Dead by Daylight,
    // qui passaient encore le filtre), 5=mod, 6=episode, 7=season, 13=pack. On les
    // écarte ici (pas dans le "where" IGDB, qui casse tout si on y ajoute
    // "category = ...", voir plus haut), et on retient leur nom pour aussi écarter
    // le même contenu côté Steam (qui, lui, ne les étiquette pas toujours
    // correctement en "dlc"). Le filtre "where parent_game = null" ajouté plus haut
    // couvre maintenant aussi ces mêmes chapitres de façon plus fiable (le champ
    // IGDB dédié à ce lien DLC → jeu de base, indépendant de "category").
    const DLC_CATEGORIES = new Set([1, 2, 3, 4, 5, 6, 7, 13]);
    const igdbDlcNames = new Set();
    const igdbResultsFiltered = igdbResults.filter(g => {
        if (DLC_CATEGORIES.has(g.category)) { igdbDlcNames.add(normalizeName(g.name)); return false; }
        return true;
    });

    const igdbYearByName = new Map();
    const igdbPopularityByName = new Map();
    igdbResultsFiltered.forEach(g => {
        const key = normalizeName(g.name);
        const y = yearFromUnixSeconds(g.first_release_date);
        if (y) igdbYearByName.set(key, y);
        igdbPopularityByName.set(key, g.total_rating_count || 0);
    });

    // Fusion + déduplication + filets anti-DLC (nom + catégorie IGDB).
    const seen = new Set();
    const results = [];
    const push = (name, year, popularity) => {
        if (isDlcName(name)) return;
        const key = normalizeName(name);
        if (igdbDlcNames.has(key)) return;
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push({ name, year: year || null, popularity: popularity || 0 });
    };

    igdbResultsFiltered.forEach(g => push(g.name, yearFromUnixSeconds(g.first_release_date), g.total_rating_count));
    steamItems.forEach(i => {
        const key = normalizeName(i.name);
        push(i.name, igdbYearByName.get(key) || null, igdbPopularityByName.get(key) || 0);
    });
    // known_games : n'ajoute rien si IGDB/Steam ont déjà trouvé ce jeu (push()
    // ignore les doublons) — ne comble que les trous. Popularité forcée très
    // haute : ce sont d'anciennes réponses de puzzles, donc par définition des
    // jeux réels et pertinents — ils ne doivent jamais être exclus par la
    // troncature à cause d'un "score" de popularité inconnu (0 par défaut).
    knownGames.forEach(g => push(g.name, g.year, 999999));

    // Filet de secours borné : pour les résultats encore sans année après IGDB
    // (base pas complète à 100 %), on tente Steam en dernier recours — mais
    // seulement pour un petit nombre d'entre eux (celles présentes sur Steam),
    // en parallèle, avec un délai court. Impact quasi nul quand IGDB a déjà
    // tout donné (le cas courant), léger sinon.
    const steamIdByName = new Map();
    steamItems.forEach(i => {
        const key = normalizeName(i.name);
        if (!steamIdByName.has(key)) steamIdByName.set(key, i.id);
    });
    const MAX_FALLBACK_LOOKUPS = 8;
    const needsYear = results
        .filter(r => !r.year && steamIdByName.has(normalizeName(r.name)))
        .slice(0, MAX_FALLBACK_LOOKUPS);
    const comingSoonNames = new Set();
    if (needsYear.length) {
        debugInfo.steamYearFallbackCalls = needsYear.length;
        await Promise.all(needsYear.map(async r => {
            const appid = steamIdByName.get(normalizeName(r.name));
            const info = await fetchSteamYear(appid);
            if (!info) return;
            if (info.comingSoon) { comingSoonNames.add(normalizeName(r.name)); return; }
            if (info.year) r.year = info.year;
        }));
    }
    // On écarte ici les jeux détectés "pas encore sortis" au passage (IGDB les a
    // déjà filtrés à la source ; ceux-ci ne viennent que du filet de secours Steam).
    const withoutComingSoon = comingSoonNames.size
        ? results.filter(r => !comingSoonNames.has(normalizeName(r.name)))
        : results;

    // Un jeu SANS date de sortie connue (ni sur IGDB, ni via le filet de secours
    // Steam ci-dessus) est le plus souvent une entrée obscure/mal référencée
    // (asset flip, outil, faux jeu...) plutôt qu'un vrai jeu à proposer — on
    // l'exclut de l'autocomplétion, SAUF s'il est "vraiment connu" (beaucoup de
    // notes/avis sur IGDB malgré la date manquante, cas rare mais réel).
    const KNOWN_WITHOUT_DATE_THRESHOLD = 15;
    const filteredResults = withoutComingSoon.filter(r => r.year || r.popularity >= KNOWN_WITHOUT_DATE_THRESHOLD);

    // Pertinence du nom par rapport à la saisie — CRITÈRE PRINCIPAL DE TRI,
    // avant l'année. Sans ça, une recherche "raft" faisait remonter
    // "Warcraft"/"StarCraft" (qui CONTIENNENT "raft" au milieu d'un mot,
    // via le filtre "contient" d'IGDB) devant le vrai jeu "Raft" — plus
    // anciens, ils passaient devant lui dans le tri par année, et avec la
    // limite de résultats, "Raft" pouvait carrément disparaître de la liste.
    // Paliers, du plus pertinent au moins pertinent :
    //  0 = nom strictement identique à la saisie
    //  1 = le nom commence par la saisie ("Raft" pour "raft", "Raft Wars" aussi)
    //  2 = la saisie correspond à un mot entier dans le nom ("Beyond the Raft")
    //  3 = la saisie n'est qu'une sous-chaîne à l'intérieur d'un mot (Warcraft)
    const normQuery = normalizeName(q);
    function relevanceTier(name) {
        const n = normalizeName(name);
        if (!normQuery) return 3;
        if (n === normQuery) return 0;
        if (n.startsWith(normQuery)) return 1;
        if (new RegExp(`\\b${normQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n)) return 2;
        return 3;
    }

    // Tri : pertinence du nom d'abord ; à pertinence égale, POPULARITÉ
    // décroissante (et non l'année) — sinon un franchise avec beaucoup
    // d'éditions/portages anciens (ex. Call of Duty : Finest Hour, Big Red
    // One, Roads to Victory...) peut à lui seul remplir toute la limite de
    // résultats et faire disparaître un épisode plus récent mais bien plus
    // connu et recherché (ex. Modern Warfare 2, 2009) — vécu en vrai avec
    // "call of duty" qui ne remontait pas MW2, noyé derrière des portages
    // mobiles/PSP bien moins pertinents pour un joueur. L'année ne sert
    // plus qu'en dernier recours (popularité égale, ou toutes deux nulles).
    filteredResults.sort((a, b) => {
        const ra = relevanceTier(a.name), rb = relevanceTier(b.name);
        if (ra !== rb) return ra - rb;
        if (a.popularity !== b.popularity) return b.popularity - a.popularity;
        if (a.year && b.year) return a.year - b.year;
        if (a.year && !b.year) return -1;
        if (!a.year && b.year) return 1;
        return a.name.localeCompare(b.name);
    });


    const merged = filteredResults.slice(0, 60);

    // Écriture dans le cache DB (best-effort, ne bloque jamais la réponse au
    // joueur). Volontairement PAS attendue (pas de "await") : avant, cet
    // aller-retour Supabase retardait la réponse à chaque cache-miss (donc
    // à quasiment chaque frappe) — le principal gain de vitesse de ce
    // correctif. Le joueur reçoit sa réponse dès que les résultats sont prêts ;
    // l'écriture se termine en arrière-plan, erreur ou pas.
    supabase.from('games_cache').upsert({ id: cacheId, data: merged, updated_at: new Date().toISOString() })
        .then(({ error }) => { if (error) debugInfo.cacheWriteError = error.message; })
        .catch(e => { debugInfo.cacheWriteError = e.message; });

    // Cache CDN Vercel : la même saisie ("borderlands") faite par n'importe qui
    // dans les 24h est servie instantanément depuis le cache, sans même toucher
    // Supabase. Allongé de 5 min à 24h (aligné sur le TTL du cache DB) : les
    // suggestions ne changent quasiment jamais d'un jour à l'autre.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
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
            const clean = name.replace(/["\\*]/g, '');
            const nowUnix = Math.floor(Date.now() / 1000);
            const rows = await igdbQuery('games',
                `fields name,first_release_date; ` +
                `where name ~ ${buildContainsPattern(clean)} & version_parent = null & parent_game = null & first_release_date < ${nowUnix}; ` +
                `sort total_rating_count desc; limit 5;`,
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
