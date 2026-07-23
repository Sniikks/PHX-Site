// ==========================================================
// /api/motcache.js — Vercel Serverless Function
// Fusion de motcache-daily.js + motcache-guess.js (limite de 12
// fonctions du plan Hobby Vercel) — même logique, dispatchée par
// méthode HTTP au lieu de 2 fichiers séparés :
//   GET  /api/motcache   → génère/renvoie le mot du jour (ex motcache-daily.js)
//   POST /api/motcache   → vérifie un essai (ex motcache-guess.js)
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
// 1=dlc_addon, 2=expansion, 3=bundle, 4=standalone_expansion, 5=mod, 6=episode,
// 7=season, 9=remaster, 13=pack, 14=update — 2 et 4 manquaient (voir _pixelpool.js).
const EXCLUDED_CATEGORIES = new Set([1, 2, 3, 4, 5, 6, 7, 9, 13, 14]);

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

function puzzleKey(date) { return 'motcache_' + date; }
function secretKey(date) { return 'motcache_secret_' + date; }

// Voir motfrancais.js pour l'explication complète : calcul de l'état du
// clavier basé sur le VRAI mot (connu seulement ici, côté serveur), pas une
// supposition côté client sur le nombre d'occurrences d'une lettre.
function computeKeyboardStates(guesses, answer) {
    const answerLetters = answer.split('');
    const totalCount = {};
    answerLetters.forEach(l => { totalCount[l] = (totalCount[l] || 0) + 1; });

    const confirmedPositions = new Set();
    const everTried = new Set();
    guesses.forEach(({ guess }) => {
        for (let i = 0; i < guess.length; i++) {
            everTried.add(guess[i]);
            if (guess[i] === answerLetters[i]) confirmedPositions.add(i);
        }
    });

    const confirmedCountPerLetter = {};
    confirmedPositions.forEach(i => {
        const l = answerLetters[i];
        confirmedCountPerLetter[l] = (confirmedCountPerLetter[l] || 0) + 1;
    });

    const states = {};
    everTried.forEach(l => {
        if (!totalCount[l]) { states[l] = 'absent'; return; }
        const confirmed = confirmedCountPerLetter[l] || 0;
        states[l] = confirmed >= totalCount[l] ? 'correct' : 'present';
    });
    return states;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.method === 'POST') return await handleGuess(req, res);
        return await handleDaily(req, res);
    } catch (e) {
        console.error('❌ motcache error:', e);
        return res.status(500).json({ error: e.message });
    }
}

// ────────────────────────────────────────────────────────
// GET /api/motcache (ex motcache-daily.js)
// ────────────────────────────────────────────────────────
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

async function validateOnIgdb(name) {
    const cleanName = name.replace(/["\\]/g, '');
    const body = `search "${cleanName}"; fields name, category, cover.image_id, first_release_date; where version_parent = null & parent_game = null; limit 5;`;
    let results;
    try { results = await igdbQueryWithRetry('games', body); } catch (e) { return null; }
    if (!Array.isArray(results) || !results.length) return null;

    const normalized = cleanName.trim().toLowerCase();
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

async function handleDaily(req, res) {
    if (!isIgdbConfigured()) {
        return res.status(500).json({ error: "IGDB non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants)." });
    }

    const isAdmin = ADMIN_KEY && req.query.key === ADMIN_KEY;
    const force = req.query.force === 'true';
    if (force && !isAdmin) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    const dateStr = getParisDateString();

    const { data: existing } = await supabase.from('motcache_public').select('data').eq('id', puzzleKey(dateStr)).maybeSingle();
    if (existing?.data?.wordLength && !force) {
        const publicData = existing.data;
        publicData.session = publicData.session || { guesses: [], solved: false, failed: false };
        if (publicData.session.guesses.length) {
            const { data: secretRow } = await supabase
                .from('motcache_secret').select('data').eq('id', secretKey(dateStr)).maybeSingle();
            if (secretRow?.data?.word) {
                publicData.session.keyboardStates = computeKeyboardStates(publicData.session.guesses, secretRow.data.word);
            }
        }
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
}

// ────────────────────────────────────────────────────────
// POST /api/motcache (ex motcache-guess.js)
// ────────────────────────────────────────────────────────
async function handleGuess(req, res) {
    const { guess } = req.body || {};
    if (!guess || typeof guess !== 'string') {
        return res.status(400).json({ error: 'Essai invalide.' });
    }

    const dateStr = getParisDateString();
    const [{ data: pubRow }, { data: secretRow }] = await Promise.all([
        supabase.from('motcache_public').select('data').eq('id', puzzleKey(dateStr)).maybeSingle(),
        supabase.from('motcache_secret').select('data').eq('id', secretKey(dateStr)).maybeSingle()
    ]);

    if (!pubRow?.data || !secretRow?.data?.word) {
        return res.status(404).json({ error: "Aucun mot du jour trouvé." });
    }

    const publicData = pubRow.data;
    const answer = secretRow.data.word;
    const session = publicData.session || { guesses: [], solved: false, failed: false };

    if (session.solved || session.failed) {
        return res.status(409).json({ error: "La partie du jour est déjà terminée.", session });
    }
    if (session.guesses.length >= publicData.maxTries) {
        return res.status(409).json({ error: "Plus d'essais disponibles.", session });
    }

    const g = guess.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z]/g, '');
    if (g.length !== answer.length) {
        return res.status(400).json({ error: `Le mot doit faire ${answer.length} lettres.` });
    }

    const result = new Array(answer.length).fill('absent');
    const answerLetters = answer.split('');
    const used = new Array(answer.length).fill(false);

    for (let i = 0; i < answer.length; i++) {
        if (g[i] === answerLetters[i]) { result[i] = 'correct'; used[i] = true; }
    }
    for (let i = 0; i < answer.length; i++) {
        if (result[i] === 'correct') continue;
        const idx = answerLetters.findIndex((l, j) => l === g[i] && !used[j]);
        if (idx !== -1) { result[i] = 'present'; used[idx] = true; }
    }

    const correct = g === answer;
    session.guesses.push({ guess: g, result });
    session.solved = correct;
    session.failed = !correct && session.guesses.length >= publicData.maxTries;
    if (session.solved || session.failed) {
        session.reveal = { name: secretRow.data.name, cover: secretRow.data.cover, word: answer };
    }

    const HINT_STAGE1_AFTER_FAILS = 2;
    const HINT_STAGE2_AFTER_FAILS = 4;
    if (!session.solved && !session.failed) {
        session.hints = session.hints || [];

        const knownIndexes = new Set();
        session.guesses.forEach(gu => gu.result.forEach((r, i) => { if (r === 'correct') knownIndexes.add(i); }));
        session.hints.forEach(h => knownIndexes.add(h.index));

        if (session.guesses.length >= HINT_STAGE1_AFTER_FAILS && !session.hints.some(h => h.stage === 1)) {
            const unknownIndexes = [];
            for (let i = 0; i < answer.length; i++) if (!knownIndexes.has(i)) unknownIndexes.push(i);
            if (unknownIndexes.length) {
                const idx = unknownIndexes[Math.floor(Math.random() * unknownIndexes.length)];
                session.hints.push({ stage: 1, index: idx, letter: answer[idx] });
                knownIndexes.add(idx);
            }
        }

        if (session.guesses.length >= HINT_STAGE2_AFTER_FAILS && !session.hints.some(h => h.stage === 2)) {
            let idx = -1;
            for (let i = 0; i < answer.length; i++) { if (!knownIndexes.has(i)) { idx = i; break; } }
            if (idx !== -1) session.hints.push({ stage: 2, index: idx, letter: answer[idx] });
        }
    }

    publicData.session = session;
    session.keyboardStates = computeKeyboardStates(session.guesses, answer);

    await supabase.from('motcache_public').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

    return res.status(200).json({ session });
}
