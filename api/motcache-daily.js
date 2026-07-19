// ==========================================================
// /api/motcache-daily.js — Vercel Serverless Function
// Génère (une seule fois par jour, paresseusement : au 1er visiteur)
// le mot du jour de "Mot Caché" et le stocke dans Supabase (tables motcache_public / motcache_secret).
//
// Comme ZoomJeu : la ligne publique porte AUSSI la "session" partagée
// (essais déjà tentés, résolu/échoué) — pas juste les infos du puzzle.
// mot-cache.html s'abonne en temps réel à cette ligne (Supabase
// Realtime) : les deux joueurs voient donc exactement la même grille,
// et si tu régénères un mot en vidant les tables, la nouvelle ligne
// (nouvelle session vide) arrive automatiquement chez tout le monde.
//
// Le mot lui-même reste dans une ligne SECRÈTE (comme zoomjeu_secret_*),
// jamais lue par le navigateur : /api/motcache-guess.js est seul à
// comparer les essais.
//
// Source du mot : SteamSpy donne le pool de jeux CONNUS (≥ 10 000
// propriétaires estimés, même mécanisme que pixels.js/plusoumoins.js),
// filtré aux noms d'UN SEUL mot de 5 à 9 lettres (esprit "Portal /
// Skyrim / Halo / Celeste"), puis validé sur IGDB pour écarter tout
// DLC/extension/réédition et récupérer la jaquette. Jamais réutilisé
// (mots déjà tombés gardés dans 'motcache_used').
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const MIN_OWNERS = 10000;
const IGDB_TIMEOUT_MS = 8000;
const MAX_TRIES = 6;

const DLC_NAME_PATTERN = /\b(dlc|season pass|expansion pass|expansion|add-?on|content pack|bonus content|artbook|art book|soundtrack|ost|skin pack|costume pack|weapon pack|outfit pack|upgrade pack|map pack|character pack|booster pack|challenge pack|premiere club|wallpaper|bundle|chapter|remaster(?:ed)?|definitive edition|goty|anniversary edition|enhanced edition|complete edition|deluxe edition|ultimate edition|hd edition)\b/i;
// 1=dlc_addon, 3=bundle, 5=mod, 6=episode, 7=season, 9=remaster, 13=pack, 14=update
const EXCLUDED_CATEGORIES = new Set([1, 3, 5, 6, 7, 9, 13, 14]);

function isUnwantedName(name) {
    if (!name) return true;
    if (DLC_NAME_PATTERN.test(name)) return true;
    if (/\bpack\b/i.test(name) && !/party pack/i.test(name)) return true;
    return false;
}
function isUnwantedIgdb(game) {
    if (EXCLUDED_CATEGORIES.has(game.category)) return true;
    return isUnwantedName(game.name);
}

function normalizeWord(name) {
    return String(name || '')
        .toUpperCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z]/g, '');
}

function getParisDateString(offsetDays = 0) {
    const now = new Date(Date.now() + offsetDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseOwnersLowerBound(ownersStr) {
    if (!ownersStr) return null;
    const match = ownersStr.match(/[\d,]+/);
    if (!match) return null;
    const n = parseInt(match[0].replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
}

// Pool de noms de jeux CONNUS (≥ MIN_OWNERS), déjà filtré DLC/pack par le
// nom, réduit aux candidats "un seul mot de 5 à 9 lettres".
async function fetchSingleWordCandidates(usedWords) {
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
        .map(g => ({ name: g.name.trim(), owners: parseOwnersLowerBound(g.owners) }))
        .filter(g => g.owners !== null && g.owners >= MIN_OWNERS)
        .filter(g => !isUnwantedName(g.name))
        .filter(g => !g.name.includes(' '))
        .map(g => {
            const clean = normalizeWord(g.name);
            return { name: g.name, word: clean };
        })
        .filter(g => g.word.length >= 5 && g.word.length <= 9 && !usedWords.has(g.word));
}

async function igdbQueryWithRetry(endpoint, body, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return await igdbQuery(endpoint, body, IGDB_TIMEOUT_MS); }
        catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, 400)); }
    }
    throw lastErr;
}

// Valide un candidat sur IGDB : rejette DLC/extension/réédition, renvoie la jaquette.
async function validateOnIgdb(name) {
    const cleanName = name.replace(/["\\]/g, '');
    const body = `search "${cleanName}"; fields name, category, cover.image_id, first_release_date; where version_parent = null; limit 5;`;
    let results;
    try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
    if (!Array.isArray(results) || !results.length) return null;

    const normalized = cleanName.trim().toLowerCase();
    // Même exigence que Pixels/ZoomJeu : pas de date connue = pas retenu.
    const candidates = results.filter(r => !isUnwantedIgdb(r) && r.cover?.image_id && r.first_release_date);
    const best = candidates.find(r => (r.name || '').trim().toLowerCase() === normalized) || candidates[0];
    if (!best) return null;
    return { name: best.name, cover: `https://images.igdb.com/igdb/image/upload/t_cover_big/${best.cover.image_id}.jpg` };
}

async function pickWord(usedWords, maxAttempts = 8) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidates = await fetchSingleWordCandidates(usedWords);
        if (!candidates.length) continue;
        const candidate = candidates[Math.floor(Math.random() * candidates.length)];
        const validated = await validateOnIgdb(candidate.name);
        if (validated) {
            return { word: candidate.word, name: validated.name, cover: validated.cover };
        }
    }
    return null;
}

function puzzleKey(date) { return 'motcache_' + date; }
function secretKey(date) { return 'motcache_secret_' + date; }

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!isIgdbConfigured()) {
        return res.status(500).json({ error: "IGDB non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants)." });
    }

    // Bouton "Générer" (forcer un nouveau mot même si celui du jour existe déjà) :
    // réservé à l'admin, même clé/vérification que ZoomJeu (/api/generate-daily?verify=1).
    const isAdmin = ADMIN_KEY && req.query.key === ADMIN_KEY;
    const force = req.query.force === 'true';
    if (force && !isAdmin) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    try {
        const dateStr = getParisDateString();

        const { data: existing } = await supabase.from('motcache_public').select('data').eq('id', puzzleKey(dateStr)).maybeSingle();
        if (existing?.data?.wordLength && !force) {
            const publicData = existing.data;
            publicData.session = publicData.session || { guesses: [], solved: false, failed: false };
            return res.status(200).json(publicData);
        }

        const { data: usedRow } = await supabase.from('motcache_public').select('data').eq('id', 'motcache_used').maybeSingle();
        const usedWords = new Set(usedRow?.data?.words || []);

        const picked = await pickWord(usedWords);
        if (!picked) {
            return res.status(503).json({ error: "Impossible de trouver un mot pour aujourd'hui, réessaie dans un instant." });
        }

        const puzzleId = dateStr + '_' + Math.random().toString(36).slice(2, 8);

        const secret = { word: picked.word, name: picked.name, cover: picked.cover, puzzleId };
        await supabase.from('motcache_secret').upsert({ id: secretKey(dateStr), data: secret, updated_at: new Date().toISOString() });

        const publicData = {
            date: dateStr,
            puzzleId,
            wordLength: picked.word.length,
            maxTries: MAX_TRIES,
            session: { guesses: [], solved: false, failed: false }
        };
        await supabase.from('motcache_public').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

        usedWords.add(picked.word);
        await supabase.from('motcache_public').upsert({ id: 'motcache_used', data: { words: [...usedWords] }, updated_at: new Date().toISOString() });

        return res.status(200).json(publicData);
    } catch (e) {
        console.error('❌ motcache-daily error:', e);
        return res.status(500).json({ error: e.message });
    }
}
