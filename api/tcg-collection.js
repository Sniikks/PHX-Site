// ==========================================================
// PHX — TCG — GET /api/tcg-collection?setId=xxx
// ==========================================================
// Renvoie toutes les cartes d'un set donné, fusionnées avec les
// quantités possédées par l'utilisateur connecté (0 = manquante,
// affichée en silhouette côté front).
// ==========================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const setId = req.query.setId;
  if (!setId) return res.status(400).json({ error: 'setId manquant.' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide.' });
  }
  const userId = userData.user.id;

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
    console.error('tcg-collection fetch error:', e);
    return res.status(502).json({ error: 'Impossible de récupérer les cartes du set.' });
  }

  const { data: owned, error: ownedError } = await supabaseAdmin
    .from('tcg_collection')
    .select('card_id, quantity')
    .eq('user_id', userId)
    .eq('set_id', setId);

  if (ownedError) {
    console.error('tcg-collection owned error:', ownedError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  const ownedMap = new Map((owned || []).map(o => [o.card_id, o.quantity]));

  const cards = setCards.map(c => ({
    id: c.id,
    name: c.name,
    number: c.number,
    rarity: c.rarity || null,
    imageSmall: c.images?.small || null,
    imageLarge: c.images?.large || null,
    quantity: ownedMap.get(c.id) || 0,
  }));

  res.setHeader('Cache-Control', 'private, no-store'); // dépend de l'utilisateur, pas de cache CDN
  return res.status(200).json({ cards });
};
