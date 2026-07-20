// ==========================================================
// /api/motfrancais.js — Vercel Serverless Function
// Fusion de motfrancais-daily.js + motfrancais-guess.js (limite de 12
// fonctions du plan Hobby Vercel) — même logique, dispatchée par
// méthode HTTP au lieu de 2 fichiers séparés :
//   GET  /api/motfrancais   → génère/renvoie le mot du jour (ex motfrancais-daily.js)
//   POST /api/motfrancais   → vérifie un essai (ex motfrancais-guess.js)
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import MOTS_POOL from './_mots-francais.json';
const VALID_WORDS = new Set(MOTS_POOL.map(w => w.word));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const MAX_TRIES = 6;

function getParisDateString(offsetDays = 0) {
    const now = new Date(Date.now() + offsetDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function puzzleKey(date) { return 'motfrancais_' + date; }
function secretKey(date) { return 'motfrancais_secret_' + date; }

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.method === 'POST') return await handleGuess(req, res);
        return await handleDaily(req, res);
    } catch (e) {
        console.error('❌ motfrancais error:', e);
        return res.status(500).json({ error: e.message });
    }
}

// ────────────────────────────────────────────────────────
// GET /api/motfrancais (ex motfrancais-daily.js)
// ────────────────────────────────────────────────────────
function pickWord(usedWords) {
    let candidates = MOTS_POOL.filter(w => !usedWords.has(w.word));
    if (!candidates.length) candidates = MOTS_POOL;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

async function handleDaily(req, res) {
    const isAdmin = ADMIN_KEY && req.query.key === ADMIN_KEY;
    const force = req.query.force === 'true';
    if (force && !isAdmin) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    const dateStr = getParisDateString();

    const { data: existing } = await supabase.from('motfrancais_public').select('data').eq('id', puzzleKey(dateStr)).maybeSingle();
    if (existing?.data?.wordLength && !force) {
        const publicData = existing.data;
        publicData.session = publicData.session || { guesses: [], solved: false, failed: false };
        return res.status(200).json(publicData);
    }

    const { data: usedRow } = await supabase.from('motfrancais_public').select('data').eq('id', 'motfrancais_used').maybeSingle();
    const usedWords = new Set(usedRow?.data?.words || []);

    const picked = pickWord(usedWords);
    if (!picked) {
        return res.status(503).json({ error: "Impossible de trouver un mot pour aujourd'hui, réessaie dans un instant." });
    }

    const puzzleId = dateStr + '_' + Math.random().toString(36).slice(2, 8);

    const secret = { word: picked.word, name: picked.display, puzzleId };
    await supabase.from('motfrancais_secret').upsert({ id: secretKey(dateStr), data: secret, updated_at: new Date().toISOString() });

    const publicData = {
        date: dateStr,
        puzzleId,
        wordLength: picked.word.length,
        maxTries: MAX_TRIES,
        session: { guesses: [], solved: false, failed: false }
    };
    await supabase.from('motfrancais_public').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

    usedWords.add(picked.word);
    await supabase.from('motfrancais_public').upsert({ id: 'motfrancais_used', data: { words: [...usedWords] }, updated_at: new Date().toISOString() });

    return res.status(200).json(publicData);
}

// ────────────────────────────────────────────────────────
// POST /api/motfrancais (ex motfrancais-guess.js)
// ────────────────────────────────────────────────────────
async function handleGuess(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }

    const { guess } = req.body || {};
    if (!guess || typeof guess !== 'string') {
        return res.status(400).json({ error: 'Essai invalide.' });
    }

    const dateStr = getParisDateString();
    const [{ data: pubRow }, { data: secretRow }] = await Promise.all([
        supabase.from('motfrancais_public').select('data').eq('id', puzzleKey(dateStr)).maybeSingle(),
        supabase.from('motfrancais_secret').select('data').eq('id', secretKey(dateStr)).maybeSingle()
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
    if (!VALID_WORDS.has(g)) {
        return res.status(400).json({ error: "Ce mot n'est pas dans notre dictionnaire." });
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
        session.reveal = { name: secretRow.data.name, word: answer };
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

    await supabase.from('motfrancais_public').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

    return res.status(200).json({ session });
}
