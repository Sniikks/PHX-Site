// ==========================================================
// /api/motcache-guess.js — Vercel Serverless Function
// Compare un essai du "Mot Caché" au mot secret du jour et renvoie
// le résultat lettre par lettre (correct/present/absent), façon Wordle.
// Ne révèle le mot (et sa jaquette) que si l'essai est correct, ou si
// isFinalAttempt=true (dernier essai autorisé, gagné ou pas).
//
// Requête : POST { guess: string, isFinalAttempt?: boolean }
// Réponse : { result: ['correct'|'present'|'absent', ...], correct: boolean, reveal: {name,cover,word}|null }
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function getParisDateString(offsetDays = 0) {
    const now = new Date(Date.now() + offsetDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }

    try {
        const { guess, isFinalAttempt } = req.body || {};
        if (!guess || typeof guess !== 'string') {
            return res.status(400).json({ error: 'Essai invalide.' });
        }

        const dateStr = getParisDateString();
        const { data: row } = await supabase.from('app_data').select('data').eq('id', 'motcache_secret_' + dateStr).maybeSingle();
        if (!row || !row.data || !row.data.word) {
            return res.status(404).json({ error: "Aucun mot du jour trouvé." });
        }

        const answer = row.data.word;
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
        const reveal = (correct || isFinalAttempt === true)
            ? { name: row.data.name, cover: row.data.cover, word: answer }
            : null;

        return res.status(200).json({ result, correct, reveal });
    } catch (e) {
        console.error('❌ motcache-guess error:', e);
        return res.status(500).json({ error: e.message });
    }
}
