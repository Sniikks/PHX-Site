// ==========================================================
// PHX — TCG — Classification des raretés + tirage pondéré
// ==========================================================
// L'API pokemontcg.io renvoie un champ `rarity` en texte libre qui
// varie énormément selon l'époque du set (23 valeurs connues à ce
// jour, voir https://api.pokemontcg.io/v2/rarities). On les range
// dans 4 paliers pour appliquer une pondération cohérente peu
// importe quel set est pioché.
// ==========================================================

const BASE_TIERS = {
  common:   { weight: 0.70, values: ['Common'] },
  uncommon: { weight: 0.30, values: ['Uncommon'] },
};

// Palier du "slot rare" garanti (6e carte du booster)
const RARE_SLOT_TIERS = {
  rare: {
    weight: 0.55,
    values: ['Rare', 'Rare ACE', 'Rare BREAK', 'Rare Prime', 'Rare Prism Star', 'Promo'],
  },
  rare_holo: {
    weight: 0.25,
    values: ['Rare Holo', 'Rare Holo Star', 'Rare Holo LV.X', 'Rare Shining', 'Rare Shiny', 'LEGEND'],
  },
  ultra_double: {
    weight: 0.13,
    values: ['Rare Holo EX', 'Rare Holo GX', 'Rare Holo V', 'Rare Holo VMAX', 'Rare Ultra', 'Rare Shiny GX', 'Amazing Rare'],
  },
  secret_special: {
    weight: 0.07,
    values: ['Rare Secret', 'Rare Rainbow'],
  },
};

// Ordre de repli si un palier tiré n'a aucune carte disponible
// (données API incomplètes) : on retombe sur le palier immédiatement
// inférieur plutôt que de faire planter le tirage.
const RARE_FALLBACK_ORDER = ['secret_special', 'ultra_double', 'rare_holo', 'rare'];
const BASE_FALLBACK_ORDER = ['uncommon', 'common'];

function weightedPick(tiers) {
  const entries = Object.entries(tiers);
  const total = entries.reduce((sum, [, t]) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const [key, t] of entries) {
    if (roll < t.weight) return key;
    roll -= t.weight;
  }
  return entries[entries.length - 1][0];
}

function buildRarityQuery(values) {
  return '(' + values.map(v => `rarity:"${v}"`).join(' OR ') + ')';
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
  });
  if (!res.ok) throw new Error(`pokemontcg.io ${res.status}`);
  return res.json();
}

// Tire UNE carte au hasard parmi tous les sets, pour une liste de
// valeurs de rareté données. Utilise pageSize=1 + un numéro de page
// aléatoire dans [1, totalCount] pour piocher un élément précis sans
// avoir à rapatrier toutes les cartes.
async function pickRandomCardForValues(values) {
  const query = buildRarityQuery(values);
  const countData = await fetchJSON(
    `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=1`
  );
  const total = countData.totalCount || 0;
  if (total === 0) return null;

  const randomPage = Math.floor(Math.random() * total) + 1;
  const cardData = await fetchJSON(
    `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&page=${randomPage}&pageSize=1`
  );
  return (cardData.data && cardData.data[0]) || null;
}

async function drawCardFromTierGroup(tiers, fallbackOrder) {
  let tierKey = weightedPick(tiers);
  let card = await pickRandomCardForValues(tiers[tierKey].values);

  // Repli en cascade si le palier tiré n'a rien renvoyé
  let i = fallbackOrder.indexOf(tierKey);
  while (!card && i < fallbackOrder.length - 1) {
    i += 1;
    tierKey = fallbackOrder[i];
    card = await pickRandomCardForValues(tiers[tierKey].values);
  }
  return { card, tier: tierKey };
}

// Tire un booster complet : 5 cartes de base (commune/peu commune)
// + 1 carte du slot rare garanti.
async function drawBooster() {
  const cards = [];

  for (let i = 0; i < 5; i++) {
    const { card, tier } = await drawCardFromTierGroup(BASE_TIERS, BASE_FALLBACK_ORDER);
    if (card) cards.push({ ...card, _tier: tier });
  }

  const { card: rareCard, tier: rareTier } = await drawCardFromTierGroup(RARE_SLOT_TIERS, RARE_FALLBACK_ORDER);
  if (rareCard) cards.push({ ...rareCard, _tier: rareTier });

  return cards;
}

module.exports = { drawBooster, BASE_TIERS, RARE_SLOT_TIERS };
