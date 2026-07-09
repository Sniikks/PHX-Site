// ==========================================================
// /api/plusoumoins.js — Vercel Serverless Function
// Jeu "Plus ou moins" (higher/lower) : compare deux jeux vidéo
// sur une statistique (date de sortie, note IGDB, popularité).
//
// Tous les jeux et leurs stats viennent d'IGDB (pas de fichier JSON
// local à embarquer — c'était la cause du 1er bug : Vercel ne bundle
// pas automatiquement un fs.readFileSync sur un fichier non importé
// statiquement, d'où le "A server error has occurred").
//
// Filtres appliqués à CHAQUE requête IGDB (pas seulement au champ de
// la catégorie tirée) :
//  - version_parent = null                 -> pas de rééditions/GOTY
//  - first_release_date != null & < "maintenant" -> jeux déjà sortis
//    uniquement (exclut les jeux annoncés pour 2027/2028 etc.)
//  - filtre anti-DLC par nom en repli (le filtre IGDB "category = 0"
//    seul est cassé côté API, comme déjà documenté dans
//    generate-daily.js/search-games.js — donc filet de nom, testé).
//
// La valeur du "challenger" ne doit jamais être visible côté client
// avant que le joueur ait répondu (sinon triche triviale en F12),
// donc chaque round est stocké côté serveur (table app_data, même
// pattern que zoomjeu_secret_*) et vérifié ici.
//
// GET  /api/plusoumoins                                    -> nouveau round
// POST /api/plusoumoins  { roundId, guess:'higher'|'lower'} -> vérifie + round suivant
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COVER_URL = id => `https://images.igdb.com/igdb/image/upload/t_cover_big/${id}.jpg`;

// Timeout généreux : sur un "cold start" Vercel, le tout premier appel doit
// négocier le token Twitch OAuth ET interroger IGDB — 3s (valeur par défaut
// de igdbQuery) peut ne pas suffire pour les deux bouts à bout. On monte à
// 8s ici, et on retente une fois en cas d'échec/timeout.
const IGDB_TIMEOUT_MS = 8000;

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
// Catégories IGDB à exclure : 1=dlc_addon, 3=bundle, 5=mod, 6=episode, 7=season, 9=remaster, 13=pack, 14=update
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

function isUnwanted(game) {
  if (EXCLUDED_CATEGORIES.has(game.category)) return true;
  if (DLC_NAME_PATTERN.test(game.name || '')) return true;
  if (/\bpack\b/i.test(game.name || '') && !/party pack/i.test(game.name || '')) return true;
  return false;
}

const CATEGORIES = {
  release: { label: 'Date de sortie', field: 'first_release_date' },
  rating: { label: 'Note IGDB', field: 'total_rating' },
  popularity: { label: 'Popularité (follows IGDB)', field: 'follows' }
};

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function displayValue(category, value) {
  if (category === 'release') {
    return new Date(value * 1000).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (category === 'rating') return `${Math.round(value)} / 100`;
  if (category === 'popularity') return `${value} follows`;
  return String(value);
}

// Petite couche de retry autour d'igdbQuery : sur un cold start, un premier
// timeout/erreur réseau ne doit pas faire échouer tout le round direct.
async function igdbQueryWithRetry(endpoint, body, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await igdbQuery(endpoint, body, IGDB_TIMEOUT_MS); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, 400)); }
  }
  throw lastErr;
}

// Récupère un lot de jeux (déjà sortis, sans DLC/rééditions) avec jaquette +
// la stat demandée renseignée, en un seul appel IGDB.
async function fetchCandidatePool(category, excludeNames = new Set()) {
  const field = CATEGORIES[category].field;
  const nowUnix = Math.floor(Date.now() / 1000);
  const offset = Math.floor(Math.random() * 500);
  const body = `fields name, category, cover.image_id, ${field}; where version_parent = null & cover != null & ${field} != null & first_release_date != null & first_release_date < ${nowUnix}; sort follows desc; limit 100; offset ${offset};`;
  let results;
  try { results = await igdbQueryWithRetry('games', body); } catch (e) { return []; }
  if (!Array.isArray(results)) return [];
  return results
    .filter(g => g.name && g.cover?.image_id && g[field] !== undefined && g[field] !== null && !excludeNames.has(g.name) && !isUnwanted(g))
    .map(g => ({ name: g.name, src: COVER_URL(g.cover.image_id), value: g[field] }));
}

// Cherche la stat d'UN jeu précis dans une catégorie donnée (utilisé quand le
// challenger gagnant devient la nouvelle base et que la catégorie change).
async function fetchStatForGame(name, category) {
  const field = CATEGORIES[category].field;
  const cleanName = name.replace(/["\\]/g, '');
  const body = `search "${cleanName}"; fields name, category, ${field}; where version_parent = null; limit 5;`;
  let results;
  try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
  if (!Array.isArray(results) || !results.length) return null;
  const normalized = cleanName.trim().toLowerCase();
  const best = results.find(r => (r.name || '').trim().toLowerCase() === normalized) || results[0];
  const value = best[field];
  if (value === undefined || value === null) return null;
  return value;
}

async function pickPairForCategory(category, excludeNames = new Set()) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pool = await fetchCandidatePool(category, excludeNames);
    if (pool.length >= 2) {
      const base = pool[Math.floor(Math.random() * pool.length)];
      let challenger;
      do { challenger = pool[Math.floor(Math.random() * pool.length)]; } while (challenger.name === base.name);
      return { base, challenger };
    }
  }
  return null;
}

async function buildContinuation(category, previousBase) {
  const excludeNames = new Set([previousBase.name]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const pool = await fetchCandidatePool(category, excludeNames);
    if (pool.length) {
      const challenger = pool[Math.floor(Math.random() * pool.length)];
      return { base: previousBase, challenger };
    }
  }
  return null;
}

function roundKey(id) { return 'pom_round_' + id; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!isIgdbConfigured()) {
    return res.status(500).json({ error: "IGDB non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants)." });
  }

  try {
    if (req.method === 'GET') {
      const category = pickRandom(Object.keys(CATEGORIES));
      const pair = await pickPairForCategory(category);
      if (!pair) return res.status(503).json({ error: "Impossible de trouver deux jeux comparables pour l'instant, réessaie." });

      const roundId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await supabase.from('app_data').upsert({
        id: roundKey(roundId),
        data: { category, base: pair.base, challenger: pair.challenger },
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({
        roundId,
        category,
        categoryLabel: CATEGORIES[category].label,
        base: { name: pair.base.name, src: pair.base.src, displayValue: displayValue(category, pair.base.value) },
        challenger: { name: pair.challenger.name, src: pair.challenger.src }
      });
    }

    if (req.method === 'POST') {
      const { roundId, guess } = req.body || {};
      if (!roundId || !['higher', 'lower'].includes(guess)) {
        return res.status(400).json({ error: 'Requête invalide.' });
      }
      const { data: row } = await supabase.from('app_data').select('data').eq('id', roundKey(roundId)).maybeSingle();
      if (!row || !row.data) return res.status(404).json({ error: 'Round introuvable ou expiré.' });

      const { category, base, challenger } = row.data;
      const actualEqual = challenger.value === base.value;
      const actualHigher = challenger.value > base.value;
      const correct = actualEqual ? true : (guess === 'higher' ? actualHigher : !actualHigher);

      const reveal = {
        base: { name: base.name, displayValue: displayValue(category, base.value) },
        challenger: { name: challenger.name, displayValue: displayValue(category, challenger.value) }
      };

      if (!correct) {
        return res.status(200).json({ correct: false, reveal });
      }

      // Bonne réponse : le challenger devient la nouvelle base. Nouvelle catégorie tirée au hasard.
      const nextCategory = pickRandom(Object.keys(CATEGORIES));
      let nextBaseValue = challenger.value;
      let finalCategory = category;
      if (nextCategory !== category) {
        const stat = await fetchStatForGame(challenger.name, nextCategory);
        if (stat !== null) { nextBaseValue = stat; finalCategory = nextCategory; }
      }
      const nextBase = { name: challenger.name, src: challenger.src, value: nextBaseValue };

      const continuation = await buildContinuation(finalCategory, nextBase);
      if (!continuation) {
        return res.status(200).json({ correct: true, reveal, gameEnded: true });
      }

      const newRoundId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await supabase.from('app_data').upsert({
        id: roundKey(newRoundId),
        data: { category: finalCategory, base: continuation.base, challenger: continuation.challenger },
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({
        correct: true,
        reveal,
        next: {
          roundId: newRoundId,
          category: finalCategory,
          categoryLabel: CATEGORIES[finalCategory].label,
          base: { name: continuation.base.name, src: continuation.base.src, displayValue: displayValue(finalCategory, continuation.base.value) },
          challenger: { name: continuation.challenger.name, src: continuation.challenger.src }
        }
      });
    }

    return res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (e) {
    console.error('❌ plusoumoins error:', e);
    return res.status(500).json({ error: e.message });
  }
}
