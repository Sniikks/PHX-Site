// ==========================================================
// /api/plusoumoins.js — Vercel Serverless Function
// Jeu "Plus ou moins" (higher/lower) : compare deux jeux CONNUS
// (≥ 10 000 propriétaires estimés via SteamSpy, même mécanisme que
// pixels.js et generate-daily.js/ZoomJeu) sur une statistique IGDB
// (date de sortie, note, popularité).
//
// Pourquoi SteamSpy + IGDB combinés ? SteamSpy donne le filtre "jeu
// connu" (aucune API ne donne un vrai nombre de joueurs multi-
// plateformes), IGDB donne les stats à comparer (date/note/follows)
// et la jaquette. On pioche donc d'abord un nom via SteamSpy (déjà
// filtré par popularité), puis on va chercher SES stats sur IGDB —
// un seul jeu ciblé à la fois, pas un gros lot : plus rapide et plus
// fiable qu'interroger IGDB en vrac puis croiser après coup.
//
// Filtres IGDB appliqués à chaque recherche :
//  - version_parent = null                        -> pas de rééditions/GOTY
//  - first_release_date != null & < "maintenant"   -> jeux déjà sortis
//    uniquement (exclut les jeux annoncés pour 2027/2028 etc.)
//  - catégorie IGDB + motif de nom en repli         -> pas de DLC/pack
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

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const COVER_URL = id => `https://images.igdb.com/igdb/image/upload/t_cover_big/${id}.jpg`;
const MIN_OWNERS = 10000;
const IGDB_TIMEOUT_MS = 8000;

const CATEGORIES = {
  release: { label: 'Date de sortie', field: 'first_release_date' },
  rating: { label: 'Note IGDB', field: 'total_rating' },
  popularity: { label: 'Popularité (follows IGDB)', field: 'follows' }
};

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
// 1=dlc_addon, 3=bundle, 5=mod, 6=episode, 7=season, 9=remaster, 13=pack, 14=update
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

function isUnwanted(game) {
  if (EXCLUDED_CATEGORIES.has(game.category)) return true;
  if (DLC_NAME_PATTERN.test(game.name || '')) return true;
  if (/\bpack\b/i.test(game.name || '') && !/party pack/i.test(game.name || '')) return true;
  return false;
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function displayValue(category, value) {
  if (category === 'release') {
    return new Date(value * 1000).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (category === 'rating') return `${Math.round(value)} / 100`;
  if (category === 'popularity') return `${value} follows`;
  return String(value);
}

function parseOwnersLowerBound(ownersStr) {
  if (!ownersStr) return null;
  const match = ownersStr.match(/[\d,]+/);
  if (!match) return null;
  const n = parseInt(match[0].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

// Pool de NOMS de jeux connus (≥ MIN_OWNERS), rafraîchi à chaque appel.
async function fetchSteamSpyPoolFiltered() {
  const roll = Math.random();
  let url;
  if (roll < 0.35) url = `${STEAMSPY_BASE}?request=top100forever`;
  else if (roll < 0.6) url = `${STEAMSPY_BASE}?request=top100in2weeks`;
  else url = `${STEAMSPY_BASE}?request=all&page=${Math.floor(Math.random() * 40)}`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return Object.values(data || {})
    .filter(g => g && g.name)
    .map(g => ({ name: g.name, owners: parseOwnersLowerBound(g.owners) }))
    .filter(g => g.owners !== null && g.owners >= MIN_OWNERS)
    .map(g => g.name);
}

async function igdbQueryWithRetry(endpoint, body, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await igdbQuery(endpoint, body, IGDB_TIMEOUT_MS); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, 400)); }
  }
  throw lastErr;
}

// Cherche la stat + jaquette d'UN jeu précis (par nom) dans une catégorie donnée.
// Rejette les DLC/rééditions/jeux pas encore sortis.
async function fetchStatForGame(name, category) {
  const field = CATEGORIES[category].field;
  const nowUnix = Math.floor(Date.now() / 1000);
  const cleanName = name.replace(/["\\]/g, '');
  const body = `search "${cleanName}"; fields name, category, cover.image_id, first_release_date, ${field}; where version_parent = null; limit 5;`;
  let results;
  try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
  if (!Array.isArray(results) || !results.length) return null;

  const normalized = cleanName.trim().toLowerCase();
  const candidates = results.filter(r => !isUnwanted(r) && r.first_release_date && r.first_release_date < nowUnix && r.cover?.image_id);
  const best = candidates.find(r => (r.name || '').trim().toLowerCase() === normalized) || candidates[0];
  if (!best) return null;

  const value = best[field];
  if (value === undefined || value === null) return null;
  return { value, coverId: best.cover.image_id, name: best.name };
}

// Pioche un jeu CONNU (SteamSpy) puis va chercher sa stat/jaquette sur IGDB.
async function pickGameWithStat(category, excludeNames = new Set(), maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const names = await fetchSteamSpyPoolFiltered();
    if (!names.length) continue;
    const candidateName = names[Math.floor(Math.random() * names.length)];
    if (excludeNames.has(candidateName)) continue;
    const stat = await fetchStatForGame(candidateName, category);
    if (stat) return { name: stat.name, src: COVER_URL(stat.coverId), value: stat.value };
  }
  return null;
}

async function pickPairForCategory(category) {
  const base = await pickGameWithStat(category);
  if (!base) return null;
  const challenger = await pickGameWithStat(category, new Set([base.name]));
  if (!challenger) return null;
  return { base, challenger };
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

      const nextCategory = pickRandom(Object.keys(CATEGORIES));
      let nextBaseValue = challenger.value;
      let finalCategory = category;
      if (nextCategory !== category) {
        const stat = await fetchStatForGame(challenger.name, nextCategory);
        if (stat !== null) { nextBaseValue = stat.value; finalCategory = nextCategory; }
      }
      const nextBase = { name: challenger.name, src: challenger.src, value: nextBaseValue };

      const nextChallenger = await pickGameWithStat(finalCategory, new Set([nextBase.name]));
      if (!nextChallenger) {
        return res.status(200).json({ correct: true, reveal, gameEnded: true });
      }

      const newRoundId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await supabase.from('app_data').upsert({
        id: roundKey(newRoundId),
        data: { category: finalCategory, base: nextBase, challenger: nextChallenger },
        updated_at: new Date().toISOString()
      });

      return res.status(200).json({
        correct: true,
        reveal,
        next: {
          roundId: newRoundId,
          category: finalCategory,
          categoryLabel: CATEGORIES[finalCategory].label,
          base: { name: nextBase.name, src: nextBase.src, displayValue: displayValue(finalCategory, nextBase.value) },
          challenger: { name: nextChallenger.name, src: nextChallenger.src }
        }
      });
    }

    return res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (e) {
    console.error('❌ plusoumoins error:', e);
    return res.status(500).json({ error: e.message });
  }
}
