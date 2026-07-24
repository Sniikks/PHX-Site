// ==========================================================
// PHX — TCG — /api/tcg?action=...
// ==========================================================
// Regroupe en UNE SEULE fonction serverless ce qui était 5 routes
// séparées (claim / open / status / sets / collection), pour rester
// sous la limite de 12 fonctions du plan Vercel Hobby.
// Dispatch via ?action=... :
//   GET  ?action=status               -> inventaire + créneau en cours
//   POST ?action=claim                -> récupère le booster du créneau en cours
//   POST ?action=open                 -> ouvre 1 booster (tirage pondéré)
//   GET  ?action=sets                 -> liste des sets (public, pas d'auth)
//   GET  ?action=collection&setId=xxx -> cartes d'un set + possédées/manquantes
// ==========================================================

const { createClient } = require('@supabase/supabase-js');
const { drawBooster } = require('./_tcg-rarity');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Auth ----------

async function requireUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { error: 'Non authentifié.', status: 401 };
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { error: 'Session invalide.', status: 401 };
  return { user: data.user };
}

// ---------- Créneau 00h00 / 12h00 (heure de Paris) ----------

function currentSlotInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find(p => p.type === type).value;
  const year = get('year'), month = get('month'), day = get('day');
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;

  const slotDate = `${year}-${month}-${day}`;
  const slotTime = hour < 12 ? '00h00' : '12h00';
  const nextHourLocal = hour < 12 ? 12 : 24;
  const nextSlotLocalStr = `${year}-${month}-${day}T${String(nextHourLocal).padStart(2, '0')}:00:00`;

  return { slotDate, slotTime, nextSlotLocalStr };
}

// ---------- Actions ----------

async function actionStatus(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const userId = auth.user.id;

  const { slotDate, slotTime, nextSlotLocalStr } = currentSlotInfo();

  const [{ data: inv }, { data: claim }] = await Promise.all([
    supabaseAdmin.from('tcg_inventory').select('unopened_count').eq('user_id', userId).maybeSingle(),
    supabaseAdmin.from('tcg_claims').select('id').eq('user_id', userId).eq('slot_date', slotDate).eq('slot_time', slotTime).maybeSingle(),
  ]);

  return res.status(200).json({
    unopenedCount: inv?.unopened_count || 0,
    currentSlotClaimed: !!claim,
    slotDate,
    slotTime,
    nextSlotLocalStr,
  });
}

async function actionClaim(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const userId = auth.user.id;

  const { slotDate, slotTime } = currentSlotInfo();

  const { data: existing, error: checkError } = await supabaseAdmin
    .from('tcg_claims')
    .select('id')
    .eq('user_id', userId).eq('slot_date', slotDate).eq('slot_time', slotTime)
    .maybeSingle();
  if (checkError) return res.status(500).json({ error: 'Erreur serveur.' });
  if (existing) return res.status(200).json({ claimed: false, alreadyClaimed: true, slotDate, slotTime });

  const { error: insertError } = await supabaseAdmin
    .from('tcg_claims')
    .insert({ user_id: userId, slot_date: slotDate, slot_time: slotTime });
  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(200).json({ claimed: false, alreadyClaimed: true, slotDate, slotTime });
    }
    console.error('tcg claim insert error:', insertError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  const { data: inv, error: invReadError } = await supabaseAdmin
    .from('tcg_inventory').select('unopened_count').eq('user_id', userId).maybeSingle();
  if (invReadError) return res.status(500).json({ error: 'Erreur serveur.' });

  const newCount = (inv?.unopened_count || 0) + 1;
  const { error: invWriteError } = await supabaseAdmin
    .from('tcg_inventory')
    .upsert({ user_id: userId, unopened_count: newCount, updated_at: new Date().toISOString() });
  if (invWriteError) return res.status(500).json({ error: 'Erreur serveur.' });

  return res.status(200).json({ claimed: true, slotDate, slotTime, unopenedCount: newCount });
}

async function actionOpen(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const userId = auth.user.id;

  const { data: inv, error: invReadError } = await supabaseAdmin
    .from('tcg_inventory').select('unopened_count').eq('user_id', userId).maybeSingle();
  if (invReadError) return res.status(500).json({ error: 'Erreur serveur.' });

  const currentCount = inv?.unopened_count || 0;
  if (currentCount <= 0) return res.status(400).json({ error: 'Aucun booster disponible.' });

  const { error: invWriteError, data: updatedInv } = await supabaseAdmin
    .from('tcg_inventory')
    .update({ unopened_count: currentCount - 1, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('unopened_count', currentCount)
    .select('unopened_count')
    .maybeSingle();
  if (invWriteError || !updatedInv) return res.status(409).json({ error: 'Le stock a changé, réessaie.' });

  let cards;
  try {
    cards = await drawBooster();
  } catch (e) {
    console.error('tcg open draw error:', e);
    await supabaseAdmin
      .from('tcg_inventory')
      .update({ unopened_count: currentCount, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return res.status(502).json({ error: `Erreur lors du tirage des cartes : ${e.message}` });
  }

  // Lecture des quantités existantes EN PARALLÈLE (pas une par une),
  // puis écriture (update ou insert selon le cas) EN PARALLÈLE aussi
  // — ça ramène ~12 allers-retours séquentiels à 2 vagues parallèles,
  // ce qui évite de dépasser le temps d'exécution max de la fonction.
  const existingResults = await Promise.all(
    cards.map(card =>
      supabaseAdmin.from('tcg_collection').select('quantity')
        .eq('user_id', userId).eq('card_id', card.id).maybeSingle()
    )
  );

  await Promise.all(cards.map((card, i) => {
    const existingCard = existingResults[i].data;
    if (existingCard) {
      return supabaseAdmin
        .from('tcg_collection')
        .update({ quantity: existingCard.quantity + 1 })
        .eq('user_id', userId).eq('card_id', card.id);
    }
    return supabaseAdmin.from('tcg_collection').insert({
      user_id: userId,
      card_id: card.id,
      card_name: card.name,
      set_id: card.set?.id || '',
      set_name: card.set?.name || '',
      rarity: card.rarity || null,
      image_small: card.images?.small || null,
      image_large: card.images?.large || null,
      quantity: 1,
    });
  }));

  return res.status(200).json({
    cards: cards.map(c => ({
      id: c.id, name: c.name, setName: c.set?.name || '',
      rarity: c.rarity || null, tier: c._tier,
      imageSmall: c.images?.small || null, imageLarge: c.images?.large || null,
    })),
    unopenedCount: updatedInv.unopened_count,
  });
}

async function actionSets(req, res) {
  try {
    const response = await fetch('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250', {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
    });
    if (!response.ok) throw new Error(`pokemontcg.io ${response.status}`);
    const data = await response.json();
    const sets = (data.data || []).map(s => ({
      id: s.id, name: s.name, series: s.series, releaseDate: s.releaseDate,
      total: s.total, symbol: s.images?.symbol || null, logo: s.images?.logo || null,
    }));
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ sets });
  } catch (e) {
    console.error('tcg sets error:', e);
    return res.status(502).json({ error: 'Impossible de récupérer les sets.' });
  }
}

async function actionCollection(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const userId = auth.user.id;

  const setId = req.query.setId;
  if (!setId) return res.status(400).json({ error: 'setId manquant.' });

  let setCards;
  try {
    const response = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`set.id:${setId}`)}&orderBy=number&pageSize=250`,
      { headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY } }
    );
    if (!response.ok) throw new Error(`pokemontcg.io ${response.status}`);
    const data = await response.json();
    setCards = data.data || [];
  } catch (e) {
    console.error('tcg collection fetch error:', e);
    return res.status(502).json({ error: 'Impossible de récupérer les cartes du set.' });
  }

  const { data: owned, error: ownedError } = await supabaseAdmin
    .from('tcg_collection').select('card_id, quantity')
    .eq('user_id', userId).eq('set_id', setId);
  if (ownedError) return res.status(500).json({ error: 'Erreur serveur.' });

  const ownedMap = new Map((owned || []).map(o => [o.card_id, o.quantity]));
  const cards = setCards.map(c => ({
    id: c.id, name: c.name, number: c.number, rarity: c.rarity || null,
    imageSmall: c.images?.small || null, imageLarge: c.images?.large || null,
    quantity: ownedMap.get(c.id) || 0,
  }));

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ cards });
}

// ---------- Dispatch ----------

module.exports = async function handler(req, res) {
  const action = req.query.action;

  try {
    if (req.method === 'GET' && action === 'status') return actionStatus(req, res);
    if (req.method === 'POST' && action === 'claim') return actionClaim(req, res);
    if (req.method === 'POST' && action === 'open') return actionOpen(req, res);
    if (req.method === 'GET' && action === 'sets') return actionSets(req, res);
    if (req.method === 'GET' && action === 'collection') return actionCollection(req, res);
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    console.error('tcg handler error:', e);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
};
