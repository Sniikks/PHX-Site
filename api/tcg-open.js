// ==========================================================
// PHX — TCG — POST /api/tcg-open
// ==========================================================
// Ouvre 1 booster depuis l'inventaire (doit être > 0), tire 6
// cartes (5 de base + 1 slot rare, cf. api/_tcg-rarity.js) parmi
// TOUS les sets, les ajoute à la collection de l'utilisateur
// (incrémente si déjà possédée) et renvoie le détail des cartes
// pour l'animation d'ouverture côté client.
// ==========================================================

const { createClient } = require('@supabase/supabase-js');
const { drawBooster } = require('./_tcg-rarity');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide.' });
  }
  const userId = userData.user.id;

  // Vérifie et décrémente l'inventaire AVANT le tirage, pour éviter
  // qu'un double-clic n'ouvre 2 boosters pour 1 seul en stock.
  const { data: inv, error: invReadError } = await supabaseAdmin
    .from('tcg_inventory')
    .select('unopened_count')
    .eq('user_id', userId)
    .maybeSingle();

  if (invReadError) {
    console.error('tcg-open inventory read error:', invReadError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  const currentCount = inv?.unopened_count || 0;
  if (currentCount <= 0) {
    return res.status(400).json({ error: 'Aucun booster disponible.' });
  }

  const { error: invWriteError, data: updatedInv } = await supabaseAdmin
    .from('tcg_inventory')
    .update({ unopened_count: currentCount - 1, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('unopened_count', currentCount) // garde optimiste anti double-clic
    .select('unopened_count')
    .maybeSingle();

  if (invWriteError || !updatedInv) {
    console.error('tcg-open inventory write error:', invWriteError);
    return res.status(409).json({ error: 'Le stock a changé, réessaie.' });
  }

  let cards;
  try {
    cards = await drawBooster();
  } catch (e) {
    console.error('tcg-open draw error:', e);
    // Remboursement du booster consommé si le tirage échoue (API externe down, etc.)
    await supabaseAdmin
      .from('tcg_inventory')
      .update({ unopened_count: currentCount, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return res.status(502).json({ error: "Erreur lors du tirage des cartes, réessaie plus tard." });
  }

  // Ajout à la collection (upsert : incrémente la quantité si déjà possédée)
  for (const card of cards) {
    const { data: existingCard } = await supabaseAdmin
      .from('tcg_collection')
      .select('quantity')
      .eq('user_id', userId)
      .eq('card_id', card.id)
      .maybeSingle();

    if (existingCard) {
      await supabaseAdmin
        .from('tcg_collection')
        .update({ quantity: existingCard.quantity + 1 })
        .eq('user_id', userId)
        .eq('card_id', card.id);
    } else {
      await supabaseAdmin.from('tcg_collection').insert({
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
    }
  }

  return res.status(200).json({
    cards: cards.map(c => ({
      id: c.id,
      name: c.name,
      setName: c.set?.name || '',
      rarity: c.rarity || null,
      tier: c._tier,
      imageSmall: c.images?.small || null,
      imageLarge: c.images?.large || null,
    })),
    unopenedCount: updatedInv.unopened_count,
  });
};
