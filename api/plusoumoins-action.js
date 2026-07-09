// ==========================================================
// /api/plusoumoins-action.js — Vercel Serverless Function
// Seule route qui fait progresser la partie PARTAGÉE de "Plus ou
// moins". Toute action (deviner, continuer après un duel, rejouer
// après une partie terminée) passe par ici et met à jour la même
// ligne Supabase que tout le monde regarde — jamais de nouveau duel
// généré par un simple chargement de page.
//
// POST { action: 'guess', guess:'higher'|'lower' } | { action: 'continue' } | { action: 'retry' }
// Réponse : l'état public à jour (plusoumoins_game).
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { CATEGORIES, pickRandom, displayValue, pickPairForCategory, pickGameWithStat, fetchStatForGame } from './_pommpool.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GAME_KEY = 'plusoumoins_game';
const SECRET_KEY = 'plusoumoins_game_secret';

function newRoundId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function loadState() {
  const [{ data: pub }, { data: secret }] = await Promise.all([
    supabase.from('app_data').select('data').eq('id', GAME_KEY).maybeSingle(),
    supabase.from('app_data').select('data').eq('id', SECRET_KEY).maybeSingle()
  ]);
  return { publicData: pub?.data || null, secret: secret?.data || null };
}

async function savePublic(publicData) {
  await supabase.from('app_data').upsert({ id: GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
}
async function saveSecret(secret) {
  await supabase.from('app_data').upsert({ id: SECRET_KEY, data: secret, updated_at: new Date().toISOString() });
}

async function startFreshGame() {
  const category = pickRandom(Object.keys(CATEGORIES));
  const pair = await pickPairForCategory(category);
  if (!pair) return null;
  const publicData = {
    roundId: newRoundId(),
    category,
    categoryLabel: CATEGORIES[category].label,
    base: { name: pair.base.name, src: pair.base.src, displayValue: displayValue(category, pair.base.value) },
    challenger: { name: pair.challenger.name, src: pair.challenger.src },
    streak: 0,
    usedNames: pair.usedNames,
    roundOver: false,
    gameOver: false,
    reveal: null
  };
  const secret = { category, baseValue: pair.base.value, challengerValue: pair.challenger.value };
  await saveSecret(secret);
  await savePublic(publicData);
  return publicData;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non supportée.' });
  }

  try {
    const { action, guess } = req.body || {};
    if (!['guess', 'continue', 'retry'].includes(action)) {
      return res.status(400).json({ error: 'Action invalide.' });
    }

    if (action === 'retry') {
      const publicData = await startFreshGame();
      if (!publicData) return res.status(503).json({ error: "Impossible de démarrer une nouvelle partie, réessaie." });
      return res.status(200).json(publicData);
    }

    let { publicData, secret } = await loadState();
    if (!publicData || !secret) {
      return res.status(404).json({ error: "Aucune partie en cours. Recharge la page." });
    }

    if (action === 'guess') {
      if (publicData.roundOver || publicData.gameOver) {
        return res.status(409).json({ error: 'Ce duel est déjà résolu.', state: publicData });
      }
      if (!['higher', 'lower'].includes(guess)) {
        return res.status(400).json({ error: 'Réponse invalide.' });
      }

      const { category, baseValue, challengerValue } = secret;
      const actualEqual = challengerValue === baseValue;
      const actualHigher = challengerValue > baseValue;
      const correct = actualEqual ? true : (guess === 'higher' ? actualHigher : !actualHigher);

      publicData.roundOver = true;
      publicData.reveal = {
        correct,
        base: { name: publicData.base.name, displayValue: displayValue(category, baseValue) },
        challenger: { name: publicData.challenger.name, displayValue: displayValue(category, challengerValue) }
      };
      if (correct) publicData.streak++;

      await savePublic(publicData);
      return res.status(200).json(publicData);
    }

    if (action === 'continue') {
      if (!publicData.roundOver) {
        return res.status(409).json({ error: "Le duel en cours n'est pas résolu.", state: publicData });
      }
      if (publicData.gameOver) {
        return res.status(409).json({ error: 'La partie est terminée, relance-en une nouvelle.', state: publicData });
      }

      if (!publicData.reveal.correct) {
        // Mauvaise réponse : on referme la partie, sans nouveau duel.
        publicData.gameOver = true;
        await savePublic(publicData);
        return res.status(200).json(publicData);
      }

      // Bonne réponse : le challenger devient la nouvelle base, nouvelle catégorie tirée au hasard.
      const { category } = secret;
      const nextCategory = pickRandom(Object.keys(CATEGORIES));
      let nextBaseValue = secret.challengerValue;
      let finalCategory = category;
      if (nextCategory !== category) {
        const stat = await fetchStatForGame(publicData.challenger.name, nextCategory);
        if (stat !== null) { nextBaseValue = stat.value; finalCategory = nextCategory; }
      }
      const nextBase = { name: publicData.challenger.name, src: publicData.challenger.src, value: nextBaseValue };

      const usedNamesLower = new Set((publicData.usedNames || []).map(n => n.toLowerCase()));
      const nextChallenger = await pickGameWithStat(finalCategory, usedNamesLower);
      if (!nextChallenger) {
        publicData.gameOver = true;
        await savePublic(publicData);
        return res.status(200).json(publicData);
      }

      const newPublic = {
        roundId: newRoundId(),
        category: finalCategory,
        categoryLabel: CATEGORIES[finalCategory].label,
        base: { name: nextBase.name, src: nextBase.src, displayValue: displayValue(finalCategory, nextBase.value) },
        challenger: { name: nextChallenger.name, src: nextChallenger.src },
        streak: publicData.streak,
        usedNames: [...(publicData.usedNames || []), nextChallenger.name],
        roundOver: false,
        gameOver: false,
        reveal: null
      };
      const newSecret = { category: finalCategory, baseValue: nextBase.value, challengerValue: nextChallenger.value };

      await saveSecret(newSecret);
      await savePublic(newPublic);
      return res.status(200).json(newPublic);
    }

    return res.status(400).json({ error: 'Action invalide.' });
  } catch (e) {
    console.error('❌ plusoumoins-action error:', e);
    return res.status(500).json({ error: e.message });
  }
}
