// ==========================================================
// /api/_pommpool.js — Bibliothèque partagée pour "Plus ou moins"
// (non exposée en HTTP, le préfixe "_" empêche Vercel d'en faire
// une route). Utilisée par plusoumoins-state.js (1re génération) et
// plusoumoins-action.js (manche suivante / nouvelle partie).
//
// Pioche un jeu CONNU (≥ 10 000 propriétaires estimés via SteamSpy,
// même mécanisme que _pixelpool.js), sans DLC/extension/réédition/
// jeu pas encore sorti, puis va chercher sa stat + sa jaquette sur IGDB.
// ==========================================================

import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const COVER_URL = id => `https://images.igdb.com/igdb/image/upload/t_cover_big/${id}.jpg`;
const MIN_OWNERS = 10000;
const IGDB_TIMEOUT_MS = 8000;

export const CATEGORIES = {
  release: { label: 'Date de sortie', field: 'first_release_date' },
  rating: { label: 'Note IGDB', field: 'total_rating' },
  popularity: { label: 'Popularité (follows IGDB)', field: 'follows' }
};

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

function isUnwantedName(name) {
  if (!name) return true;
  if (DLC_NAME_PATTERN.test(name)) return true;
  if (/\bpack\b/i.test(name) && !/party pack/i.test(name)) return true;
  return false;
}
function isUnwanted(game) {
  if (EXCLUDED_CATEGORIES.has(game.category)) return true;
  return isUnwantedName(game.name);
}

export function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function displayValue(category, value) {
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
    .filter(g => !isUnwantedName(g.name))
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
export async function fetchStatForGame(name, category) {
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
// excludeNames doit contenir des noms déjà en minuscules.
export async function pickGameWithStat(category, excludeNames = new Set(), maxAttempts = 8) {
  if (!isIgdbConfigured()) return null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const names = await fetchSteamSpyPoolFiltered();
    if (!names.length) continue;
    const candidateName = names[Math.floor(Math.random() * names.length)];
    if (excludeNames.has(candidateName.toLowerCase())) continue;
    const stat = await fetchStatForGame(candidateName, category);
    if (stat && !excludeNames.has(stat.name.toLowerCase())) {
      return { name: stat.name, src: COVER_URL(stat.coverId), value: stat.value };
    }
  }
  return null;
}

export async function pickPairForCategory(category) {
  const base = await pickGameWithStat(category);
  if (!base) return null;
  const challenger = await pickGameWithStat(category, new Set([base.name.toLowerCase()]));
  if (!challenger) return null;
  return { base, challenger, usedNames: [base.name, challenger.name] };
}
