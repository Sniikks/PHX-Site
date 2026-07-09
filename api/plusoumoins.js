// ==========================================================
// /api/plusoumoins.js — Vercel Serverless Function
// Jeu "Plus ou moins" (higher/lower) : compare deux jeux vidéo
// sur une statistique (date de sortie, note IGDB, popularité).
//
// Tous les jeux et leurs stats viennent d'IGDB (pas de fichier JSON
// local à embarquer dans la fonction — c'était la cause du bug
// "A server error has occurred" : Vercel ne bundle pas automatiquement
// un fs.readFileSync sur un fichier non importé statiquement).
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

// Récupère un lot de jeux avec jaquette + la stat demandée renseignée,
// en un seul appel IGDB (évite les allers-retours multiples par jeu).
async function fetchCandidatePool(category, excludeNames = new Set()) {
  const field = CATEGORIES[category].field;
  const offset = Math.floor(Math.random() * 500);
  const body = `fields name, cover.image_id, ${field}; where version_parent = null & cover != null & ${field} != null; sort follows desc; limit 80; offset ${offset};`;
  let results;
  try { results = await igdbQuery('games', body); } catch (e) { return []; }
  if (!Array.isArray(results)) return [];
  return results
    .filter(g => g.name && g.cover?.image_id && g[field] !== undefined && g[field] !== null && !excludeNames.has(g.name))
    .map(g => ({ name: g.name, src: COVER_URL(g.cover.image_id), value: g[field] }));
}

// Cherche la stat d'UN jeu précis dans une catégorie donnée (utilisé quand le
// challenger gagnant devient la nouvelle base et que la catégorie change).
async function fetchStatForGame(name, category) {
  const field = CATEGORIES[category].field;
  const cleanName = name.replace(/["\\]/g, '');
  const body = `search "${cleanName}"; fields name, ${field}; where version_parent = null; limit 5;`;
  let results;
  try { results = await igdbQuery('games', body); } catch (e) { return null; }
  if (!Array.isArray(results) || !results.length) return null;
  const normalized = cleanName.trim().toLowerCase();
  const best = results.find(r => (r.name || '').trim().toLowerCase() === normalized) || results[0];
  const value = best[field];
  if (value === undefined || value === null) return null;
  return value;
}

async function pickPairForCategory(category, excludeNames = new Set()) {
  for (let attempt = 0; attempt < 4; attempt++) {
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
  const pool = await fetchCandidatePool(category, excludeNames);
  if (!pool.length) return null;
  const challenger = pool[Math.floor(Math.random() * pool.length)];
  return { base: previousBase, challenger };
}

function roundKey(id) { return 'pom_round_' + id; }

export default async function handler(req, res) {
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
