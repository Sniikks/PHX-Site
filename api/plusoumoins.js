// ==========================================================
// /api/plusoumoins.js — Vercel Serverless Function
// Jeu "Plus ou moins" (higher/lower) : compare deux jeux vidéo
// sur une statistique (date de sortie, note IGDB, popularité).
//
// La valeur du "challenger" ne doit jamais être visible côté client
// avant que le joueur ait répondu (sinon triche triviale en F12),
// donc chaque round est stocké côté serveur (table app_data,
// même pattern que zoomjeu_secret_*) et vérifié ici.
//
// GET  /api/plusoumoins?action=start                     -> nouveau round
// POST /api/plusoumoins  { roundId, guess:'higher'|'lower'} -> vérifie + round suivant
//
// Source des jeux : bracket_games.json (pool déjà utilisé par
// bracket-jeux.html), enrichi à la volée par IGDB (mêmes identifiants
// Twitch que generate-daily.js / search-games.js — pas de nouvelle
// variable d'env nécessaire).
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const POOL_PATH = fileURLToPath(new URL('../bracket_games.json', import.meta.url));
let POOL = null;
function getPool() {
  if (!POOL) POOL = JSON.parse(readFileSync(POOL_PATH, 'utf-8'));
  return POOL;
}

const CATEGORIES = {
  release: { label: 'Date de sortie', field: 'first_release_date', unit: 'date' },
  rating: { label: 'Note IGDB', field: 'total_rating', unit: 'score' },
  popularity: { label: 'Popularité (follows IGDB)', field: 'follows', unit: 'count' }
};

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function displayValue(category, value) {
  if (category === 'release') {
    const d = new Date(value * 1000);
    return d.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (category === 'rating') return `${Math.round(value)} / 100`;
  if (category === 'popularity') return `${value} follows`;
  return String(value);
}

// Interroge IGDB pour UN jeu et retourne la valeur de la catégorie demandée (ou null).
async function fetchStat(name, category) {
  const field = CATEGORIES[category].field;
  const cleanName = name.replace(/["\\]/g, '');
  const body = `search "${cleanName}"; fields name,first_release_date,total_rating,rating,follows,hypes; where version_parent = null; limit 5;`;
  let results;
  try {
    results = await igdbQuery('games', body);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(results) || !results.length) return null;

  // Meilleure correspondance : nom exact (insensible casse) sinon 1er résultat.
  const normalized = cleanName.trim().toLowerCase();
  const best = results.find(r => (r.name || '').trim().toLowerCase() === normalized) || results[0];

  let value = best[field];
  if (value === undefined || value === null) {
    // Filets de repli : rating -> total_rating, follows -> hypes
    if (category === 'rating') value = best.total_rating ?? best.rating;
    if (category === 'popularity') value = best.follows ?? best.hypes;
  }
  if (value === undefined || value === null) return null;
  return { value, matchedName: best.name };
}

// Tire un jeu au hasard dans le pool ayant une statistique exploitable pour la catégorie,
// en excluant les noms déjà utilisés dans ce round. Plusieurs tentatives bornées.
async function pickGameWithStat(category, excludeNames, maxTries = 8) {
  const pool = getPool();
  const tried = new Set();
  for (let i = 0; i < maxTries; i++) {
    const candidate = pickRandom(pool);
    if (excludeNames.has(candidate.name) || tried.has(candidate.name)) continue;
    tried.add(candidate.name);
    const stat = await fetchStat(candidate.name, category);
    if (stat) {
      return { name: candidate.name, src: candidate.src, value: stat.value };
    }
  }
  return null;
}

async function buildRound(category, baseGame) {
  const excludeNames = new Set([baseGame.name]);
  const challenger = await pickGameWithStat(category, excludeNames);
  if (!challenger) return null;
  return { base: baseGame, challenger };
}

async function startNewGame() {
  const category = pickRandom(Object.keys(CATEGORIES));
  const base = await pickGameWithStat(category, new Set());
  if (!base) return null;
  const round = await buildRound(category, base);
  if (!round) return null;
  return { category, ...round };
}

function roundKey(id) { return 'pom_round_' + id; }

export default async function handler(req, res) {
  if (!isIgdbConfigured()) {
    return res.status(500).json({ error: "IGDB non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants)." });
  }

  try {
    if (req.method === 'GET') {
      const built = await startNewGame();
      if (!built) return res.status(503).json({ error: "Impossible de trouver deux jeux comparables pour l'instant, réessaie." });

      const roundId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await supabase.from('app_data').upsert({
        id: roundKey(roundId),
        data: { category: built.category, base: built.base, challenger: built.challenger },
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({
        roundId,
        category: built.category,
        categoryLabel: CATEGORIES[built.category].label,
        base: { name: built.base.name, src: built.base.src, displayValue: displayValue(built.category, built.base.value) },
        challenger: { name: built.challenger.name, src: built.challenger.src }
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
      const actualHigher = challenger.value > base.value;
      const actualEqual = challenger.value === base.value;
      const correct = actualEqual ? true : (guess === 'higher' ? actualHigher : !actualHigher);

      const reveal = {
        base: { name: base.name, displayValue: displayValue(category, base.value) },
        challenger: { name: challenger.name, displayValue: displayValue(category, challenger.value) }
      };

      if (!correct) {
        return res.status(200).json({ correct: false, reveal });
      }

      // Bonne réponse : le challenger devient la nouvelle base, on tire un nouveau challenger.
      const nextCategory = pickRandom(Object.keys(CATEGORIES));
      const newBase = { name: challenger.name, src: challenger.src, value: challenger.value };
      // Si la catégorie change, la "value" de la nouvelle base doit être ré-interrogée dans la nouvelle catégorie.
      let nextBase = newBase;
      if (nextCategory !== category) {
        const stat = await fetchStat(challenger.name, nextCategory);
        if (!stat) {
          // repli : on reste sur la même catégorie si la nouvelle ne donne rien pour ce jeu
          nextBase = newBase;
        } else {
          nextBase = { name: challenger.name, src: challenger.src, value: stat.value };
        }
      }
      const finalCategory = (nextCategory !== category && nextBase !== newBase) ? nextCategory : category;
      const nextRound = await buildRound(finalCategory, nextBase);
      if (!nextRound) {
        return res.status(200).json({ correct: true, reveal, gameEnded: true });
      }

      const newRoundId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await supabase.from('app_data').upsert({
        id: roundKey(newRoundId),
        data: { category: finalCategory, base: nextRound.base, challenger: nextRound.challenger },
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({
        correct: true,
        reveal,
        next: {
          roundId: newRoundId,
          category: finalCategory,
          categoryLabel: CATEGORIES[finalCategory].label,
          base: { name: nextRound.base.name, src: nextRound.base.src, displayValue: displayValue(finalCategory, nextRound.base.value) },
          challenger: { name: nextRound.challenger.name, src: nextRound.challenger.src }
        }
      });
    }

    return res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (e) {
    console.error('❌ plusoumoins error:', e);
    return res.status(500).json({ error: e.message });
  }
}
