// ==========================================================
// /api/_franchise.js — Vérification de licence réelle via IGDB.
//
// Pourquoi ce fichier : isCloseGuess (_gamematch.js) ne compare que des MOTS
// du titre — un seul mot en commun (ex. "dead" dans "Dead Island"/"Dead
// Space") ne prouve rien, ces deux jeux n'ont aucun rapport. Mais un seul mot
// en commun EST parfois suffisant (ex. "Amnesia", "Arma", "TrackMania") quand
// il s'agit réellement du même mot de licence. Impossible de trancher ça de
// façon fiable avec du texte seul : ce module interroge IGDB (champs
// "franchises" et "collection", les vraies métadonnées de regroupement par
// licence/série) pour les deux noms et compare leurs identifiants réels.
//
// Utilisé uniquement en repli, quand sharesLeadingToken(...) (_gamematch.js)
// est vrai mais que isCloseGuess(...) ne l'est pas déjà via les mots seuls —
// donc seulement à la soumission d'un essai (jamais pendant la frappe), pour
// rester compatible avec la latence de l'autocomplétion.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

// Cache mémoire (survit tant que l'instance serverless reste "chaude") : deux
// essais successifs sur la même licence ne refont pas l'aller-retour IGDB.
const franchiseInfoCache = new Map();

async function fetchFranchiseInfo(name) {
    const clean = String(name || '').replace(/[®™©"\\*]/g, '').trim();
    if (!clean) return null;
    const cacheKey = clean.toLowerCase();
    if (franchiseInfoCache.has(cacheKey)) return franchiseInfoCache.get(cacheKey);

    try {
        const rows = await igdbQuery('games',
            `fields name,franchises,collection,total_rating_count; ` +
            `where name ~ *"${clean}"* & version_parent = null; ` +
            `sort total_rating_count desc; limit 5;`,
            2000
        );
        // Le résultat le plus populaire est pris comme correspondance la plus
        // probable pour ce nom (même logique que le reste de l'autocomplétion).
        const best = Array.isArray(rows) && rows.length ? rows[0] : null;
        franchiseInfoCache.set(cacheKey, best);
        return best;
    } catch (e) {
        franchiseInfoCache.set(cacheKey, null);
        return null;
    }
}

// Renvoie true si l'essai et la réponse partagent la même licence/série IGDB
// réelle (champ "collection", ex. la série "Amnesia") ou une franchise IGDB en
// commun (champ "franchises", regroupement plus large qu'IGDB maintient pour
// certaines séries). Renvoie false si IGDB n'est pas configuré, si l'un des
// deux jeux n'est pas trouvé, ou si aucune métadonnée de licence n'est
// disponible — repli volontairement STRICT (jamais "proche" par défaut en cas
// de doute, seulement sur confirmation réelle).
export async function isSameFranchiseIgdb(guessName, answerName) {
    if (!isIgdbConfigured()) return false;
    const [g, a] = await Promise.all([fetchFranchiseInfo(guessName), fetchFranchiseInfo(answerName)]);
    if (!g || !a) return false;

    if (g.collection && a.collection && g.collection === a.collection) return true;

    const guessFranchises = new Set(g.franchises || []);
    const answerFranchises = new Set(a.franchises || []);
    for (const id of guessFranchises) {
        if (answerFranchises.has(id)) return true;
    }
    return false;
}
