// ==========================================================
// /api/motfrancais-guess.js — Vercel Serverless Function
// Vérifie un essai de "Mot Français" côté serveur et met à jour la
// SESSION PARTAGÉE (comme /api/motcache-guess.js) : les essais de
// n'importe quel joueur s'ajoutent à la même ligne Supabase, que
// mot-francais.html reçoit ensuite via Realtime — donc les deux
// joueurs voient toujours exactement la même grille.
//
// Contrairement à Mot Caché (n'importe quelle suite de lettres est
// acceptée comme essai), ici on vérifie EN PLUS que l'essai est un
// vrai mot français connu (même pool statique que motfrancais-daily.js),
// pour un ressenti plus proche d'un vrai Wordle.
//
// Requête : POST { guess: string }
// Réponse : { session } où session = { guesses:[{guess,result}], solved, failed, reveal? }
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import MOTS_POOL from './_mots-francais.json';
const VALID_WORDS = new Set(MOTS_POOL.map(w => w.word));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }

    try {
        const { guess } = req.body || {};
        if (!guess || typeof guess !== 'string') {
            return res.status(400).json({ error: 'Essai invalide.' });
        }

        const dateStr = getParisDateString();
        const [{ data: pubRow }, { data: secretRow }] = await Promise.all([
            supabase.from('app_data').select('data').eq('id', puzzleKey(dateStr)).maybeSingle(),
            supabase.from('app_data').select('data').eq('id', secretKey(dateStr)).maybeSingle()
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

        // ── Indices, en deux paliers (identique à Mot Caché) ──
        // Palier 1 : au commencement du 3e essai (donc dès 2 essais ratés), une
        // lettre au hasard parmi celles que PERSONNE n'a encore trouvée en
        // "correct" (ni par un essai, ni par un indice précédent).
        // Palier 2 : au commencement du 5e essai (donc dès 4 essais ratés), la
        // PREMIÈRE lettre du mot pas encore connue.
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

        await supabase.from('app_data').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

        return res.status(200).json({ session });
    } catch (e) {
        console.error('❌ motfrancais-guess error:', e);
        return res.status(500).json({ error: e.message });
    }
}
