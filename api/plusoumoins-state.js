// ==========================================================
// /api/plusoumoins-state.js — Vercel Serverless Function
// Renvoie l'état PARTAGÉ actuel de "Plus ou moins" (une seule partie
// pour tout le monde, comme Mot Caché/Pixels/ZoomJeu). Ne génère un
// duel que si AUCUNE partie n'existe encore en base (tout premier
// lancement) : un simple chargement/rechargement de page ne crée
// jamais un nouveau duel — seules les actions réelles (deviner/
// continuer/rejouer, voir /api/plusoumoins-action.js) le font.
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { CATEGORIES, pickRandom, displayValue, pickPairForCategory } from './_pommpool.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GAME_KEY = 'plusoumoins_game';
const SECRET_KEY = 'plusoumoins_game_secret';

function newRoundId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function bootstrapGame() {
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

  await supabase.from('app_data').upsert({ id: SECRET_KEY, data: secret, updated_at: new Date().toISOString() });
  await supabase.from('app_data').upsert({ id: GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
  return publicData;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { data: existing } = await supabase.from('app_data').select('data').eq('id', GAME_KEY).maybeSingle();
    if (existing?.data?.roundId) {
      return res.status(200).json(existing.data);
    }

    const publicData = await bootstrapGame();
    if (!publicData) {
      return res.status(503).json({ error: "Impossible de démarrer une partie pour l'instant, réessaie." });
    }
    return res.status(200).json(publicData);
  } catch (e) {
    console.error('❌ plusoumoins-state error:', e);
    return res.status(500).json({ error: e.message });
  }
}
