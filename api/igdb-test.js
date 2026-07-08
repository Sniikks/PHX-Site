// ==========================================================
// /api/igdb-test.js — Route de TEST temporaire (à supprimer une fois le
// débogage terminé — elle ne sert à rien pour le site en production).
//
// But : tester des requêtes IGDB brutes directement depuis le navigateur,
// sans toucher à search-games.js. IGDB exige du POST avec des en-têtes
// (Client-ID + jeton), donc impossible à taper tel quel dans une URL —
// cette route fait le relais : GET (facile à tester) -> POST IGDB.
//
// Usage :
//   /api/igdb-test?key=TON_ADMIN_KEY&q=<requête apicalypse encodée>
//
// Exemple (recherche "contient" sur "unchar") :
//   /api/igdb-test?key=TON_ADMIN_KEY&q=fields%20name%2Cfirst_release_date%3B%20where%20name%20~%20*%22unchar%22*%20%26%20category%20%3D%200%3B%20sort%20total_rating_count%20desc%3B%20limit%2020%3B
//
// Protégée par ADMIN_KEY (la même variable d'environnement que
// /api/generate-daily.js) pour éviter que n'importe qui puisse taper
// dans ton quota IGDB.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const ADMIN_KEY = process.env.ADMIN_KEY || null;

export default async function handler(req, res) {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
        return res.status(401).json({ error: 'Non autorisé (clé admin manquante ou incorrecte).' });
    }
    if (!isIgdbConfigured()) {
        return res.status(500).json({ error: 'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET absents.' });
    }

    const q = req.query.q;
    if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'Paramètre "q" manquant : la requête IGDB brute (apicalypse) à tester.' });
    }
    // endpoint optionnel, "games" par défaut (celui qu'on utilise partout ailleurs).
    const endpoint = (req.query.endpoint && /^[a-z_]+$/.test(String(req.query.endpoint)))
        ? String(req.query.endpoint)
        : 'games';

    try {
        const rows = await igdbQuery(endpoint, q, 5000);
        return res.status(200).json({ ok: true, query: q, endpoint, count: Array.isArray(rows) ? rows.length : null, rows });
    } catch (e) {
        return res.status(200).json({ ok: false, query: q, endpoint, error: e.message });
    }
}
