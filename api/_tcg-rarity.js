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

// La doc pokemontcg.io ne montre les parenthèses OR qu'en groupe
// SECONDAIRE à côté d'une autre clause (ex. name:charizard
// (subtypes:mega OR subtypes:vmax)). Ici la clause de rareté est la
// SEULE clause de la requête : envelopper un groupe unique dans des
// parenthèses comme unique contenu semble faire planter leur parseur
// côté serveur (500). On envoie donc l'expression OR sans parenthèses
// englobantes, et sans aucune parenthèse du tout pour un seul terme.
function buildRarityQuery(values) {
  if (values.length === 1) return `rarity:"${values[0]}"`;
  return values.map(v => `rarity:"${v}"`).join(' OR ');
}

// Timeout court par requête externe : sur Vercel Hobby, une fonction
// serverless est tuée au bout de 10s max. Tirer 6 cartes en séquence
// (2 appels réseau chacune) pouvait facilement dépasser ce budget et
// faire échouer TOUTE l'ouverture sans qu'aucune carte ne s'affiche.
// On limite chaque appel à 6s et on parallélise tout ce qui peut
// l'être (voir drawBooster) pour rester largement sous la limite.
//
// 1 retry automatique sur échec 429 (quota/minute dépassé — probable
// en lançant 6 tirages en parallèle d'un coup) ou 500 ponctuel, avant
// d'abandonner ce palier : explique pourquoi certains tirages
// n'obtenaient qu'une partie des 6 cartes.
async function fetchJSON(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
      signal: controller.signal,
    });
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        clearTimeout(timeout);
        await new Promise(r => setTimeout(r, 350 * attempt));
        return fetchJSON(url, attempt + 1);
      }
      throw new Error(`pokemontcg.io ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Cache mémoire valable le temps d'UNE ouverture de booster : les 5
// cartes de base ne roulent que sur 2 valeurs possibles (Common /
// Uncommon), donc sans ce cache on redemandait le même total() à
// l'API 5 fois pour rien.
function makeCountCache() {
  const cache = new Map();
  return async function getTotal(query) {
    if (cache.has(query)) return cache.get(query);
    const data = await fetchJSON(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=1`);
    const total = data.totalCount || 0;
    cache.set(query, total);
    return total;
  };
}

// Tire UNE carte au hasard parmi tous les sets, pour une liste de
// valeurs de rareté données. Utilise pageSize=1 + un numéro de page
// aléatoire dans [1, totalCount] pour piocher un élément précis sans
// avoir à rapatrier toutes les cartes.
async function pickRandomCardForValues(values, getTotal) {
  const query = buildRarityQuery(values);
  const total = await getTotal(query);
  if (total === 0) return null;

  const randomPage = Math.floor(Math.random() * total) + 1;
  const cardData = await fetchJSON(
    `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&page=${randomPage}&pageSize=1`
  );
  return (cardData.data && cardData.data[0]) || null;
}

async function drawCardFromTierGroup(tiers, fallbackOrder, getTotal) {
  let tierKey = weightedPick(tiers);
  let card = null;
  let lastError = null;
  try {
    card = await pickRandomCardForValues(tiers[tierKey].values, getTotal);
  } catch (e) {
    lastError = e.message;
    console.error(`tcg rarity draw error (tier ${tierKey}):`, e.message);
  }

  // Repli en cascade si le palier tiré n'a rien renvoyé OU si
  // l'appel a échoué (erreur réseau/serveur ponctuelle côté API)
  let i = fallbackOrder.indexOf(tierKey);
  while (!card && i < fallbackOrder.length - 1) {
    i += 1;
    tierKey = fallbackOrder[i];
    try {
      card = await pickRandomCardForValues(tiers[tierKey].values, getTotal);
    } catch (e) {
      lastError = e.message;
      console.error(`tcg rarity draw error (tier ${tierKey}):`, e.message);
    }
  }
  return { card, tier: tierKey, lastError };
}

// Tire un booster complet : 5 cartes de base (commune/peu commune)
// + 1 carte du slot rare garanti. Les 6 tirages sont indépendants,
// donc lancés EN PARALLÈLE (Promise.all) plutôt qu'en séquence —
// c'était la cause probable des échecs silencieux (fonction tuée
// avant la fin des 12 appels réseau séquentiels).
//
// Si TOUS les tirages échouent (0 carte au final), on ne renvoie
// plus un booster vide en silence : on lève une erreur avec le
// dernier message concret rencontré, pour que l'utilisateur (et moi)
// voyions enfin la vraie cause au lieu d'un overlay vide sans rien.
async function drawBooster() {
  const getTotal = makeCountCache();

  const basePromises = Array.from({ length: 5 }, () =>
    drawCardFromTierGroup(BASE_TIERS, BASE_FALLBACK_ORDER, getTotal)
  );
  const rarePromise = drawCardFromTierGroup(RARE_SLOT_TIERS, RARE_FALLBACK_ORDER, getTotal);

  const results = await Promise.all([...basePromises, rarePromise]);
  const cards = results.filter(r => r.card).map(r => ({ ...r.card, _tier: r.tier }));

  if (cards.length === 0) {
    const lastError = results.map(r => r.lastError).find(Boolean);
    throw new Error(lastError || 'Aucune carte renvoyée par pokemontcg.io (raison inconnue).');
  }

  return cards;
}

module.exports = { drawBooster, BASE_TIERS, RARE_SLOT_TIERS };
