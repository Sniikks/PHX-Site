// ==========================================================
// /api/guess.js — Vercel Serverless Function
// Reçoit les actions de jeu du ZoomJeu (essai, passer, abandonner)
// et met à jour la session partagée côté serveur.
//
// Pourquoi côté serveur ? Avant, la réponse du jour était stockée
// en clair dans la ligne publique "zoomjeu_YYYY-MM-DD" que le
// navigateur lisait directement : n'importe qui pouvait la voir
// dans l'onglet Réseau (F12). Désormais la réponse vit dans une
// ligne "zoomjeu_secret_YYYY-MM-DD" que la clé anon ne peut pas
// lire (voir supabase-migration-zoomjeu.sql), et c'est cette API
// qui compare les essais.
//
// Requête : POST JSON { date, action: 'guess'|'skip'|'giveup', text?, year? }
// Réponse : { ok, session, revealed|null, guess|null }
//   - session  : la session partagée mise à jour (guesses/solved/gaveUp)
//   - revealed : { answer, released } une fois la partie terminée
//   - guess    : l'objet essai calculé (correct/close/nameHint/yearHint)
//
// Rétro-compatibilité : pour les anciens puzzles (générés avant la
// v2, réponse encore dans la ligne publique), on lit la réponse là.
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { isCorrectGuess, isCloseGuess, nameHint, extractYear } from './_gamematch.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
// La clé service_role est nécessaire pour lire les lignes secrètes une fois
// la migration RLS appliquée. Repli sur la clé anon si absente (fonctionne
// tant que la migration n'a pas été exécutée).
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_ATTEMPTS = 5;

// Résout l'année d'un jeu via notre propre API /api/search-games?resolve=1
// (même déploiement — on reconstruit l'URL depuis les en-têtes de la requête).
// Best-effort : timeout court, et null en cas d'échec — le jeu marche sans.
async function resolveYear(req, name) {
    try {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
        const clean = String(name || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
        if (!host || !clean) return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(`${proto}://${host}/api/search-games?resolve=1&name=${encodeURIComponent(clean)}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) return null;
        const d = await r.json();
        return d.year || null;
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
    }

    const body = req.body || {};
    const date = String(body.date || '');
    const action = String(body.action || '');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ ok: false, error: 'Date invalide' });
    }
    if (!['guess', 'skip', 'giveup'].includes(action)) {
        return res.status(400).json({ ok: false, error: 'Action invalide' });
    }

    try {
        const puzzleId = 'zoomjeu_' + date;
        const [{ data: pubRow }, { data: secretRow }] = await Promise.all([
            supabase.from('zoomjeu_public').select('data').eq('id', puzzleId).maybeSingle(),
            supabase.from('zoomjeu_secret').select('data').eq('id', 'zoomjeu_secret_' + date).maybeSingle()
        ]);

        const pub = pubRow?.data;
        if (!pub || !pub.image) {
            return res.status(404).json({ ok: false, error: 'Aucun puzzle pour cette date.' });
        }

        const secret = secretRow?.data || null;
        const answer = secret?.answer || pub.answer || null; // pub.answer = anciens puzzles (v1)
        if (!answer) {
            return res.status(409).json({ ok: false, error: 'Puzzle sans réponse enregistrée côté serveur.' });
        }
        const released = secret?.released || pub.released || null;

        const session = (pub.session && Array.isArray(pub.session.guesses))
            ? pub.session
            : { guesses: [], solved: false, gaveUp: false };

        let finished = session.solved || session.gaveUp || session.guesses.length >= MAX_ATTEMPTS;
        let lastGuess = null;

        if (!finished) {
            if (action === 'skip') {
                session.guesses.push({ text: '', correct: false, skipped: true });
            } else if (action === 'giveup') {
                session.gaveUp = true;
            } else {
                const text = String(body.text || '').trim().slice(0, 120);
                if (!text) return res.status(400).json({ ok: false, error: 'Réponse vide.' });

                const correct = isCorrectGuess(text, answer);
                const close = !correct && isCloseGuess(text, answer);
                const hint = !correct ? nameHint(text, answer) : null;
                lastGuess = { text, correct, close, nameHint: hint, year: null, yearHint: null };

                // ── Indice "avant/après" sur l'année ──
                // Année de la réponse : d'abord la date enregistrée à la génération
                // (fiable depuis IGDB), sinon résolution best-effort via search-games.
                let answerYear = extractYear(released);
                if (!answerYear && !correct) answerYear = await resolveYear(req, answer);

                // Année de l'essai : fournie par la suggestion cliquée côté client,
                // sinon résolue ici (l'ancien comportement client, déplacé serveur).
                let guessYear = Number.isFinite(Number(body.year)) && Number(body.year) > 1900 ? Number(body.year) : null;
                if (!correct && !guessYear) guessYear = await resolveYear(req, text);
                if (guessYear) lastGuess.year = guessYear;

                const hintFor = y => y < answerYear ? 'after' : (y > answerYear ? 'before' : 'same');
                if (!correct && answerYear && guessYear) lastGuess.yearHint = hintFor(guessYear);

                // Rattrapage rétroactif : complète les indices d'année des essais
                // précédents si l'année de la réponse vient seulement d'être connue.
                if (answerYear) {
                    session.guesses.forEach(g => {
                        if (!g.correct && !g.skipped && g.year && !g.yearHint) g.yearHint = hintFor(g.year);
                    });
                }

                session.guesses.push(lastGuess);
                if (correct) session.solved = true;
            }
        }

        finished = session.solved || session.gaveUp || session.guesses.length >= MAX_ATTEMPTS;

        const newData = { ...pub, session };
        // Partie terminée -> on révèle la réponse dans la ligne publique, pour
        // que tous les visiteurs (et les archives) puissent l'afficher.
        if (finished && !newData.revealed) {
            newData.revealed = { answer, released };
        }

        await supabase.from('zoomjeu_public').upsert({ id: puzzleId, data: newData, updated_at: new Date().toISOString() });

        return res.status(200).json({ ok: true, session, revealed: newData.revealed || null, guess: lastGuess });
    } catch (e) {
        console.error('❌ guess error:', e);
        return res.status(500).json({ ok: false, error: e.message });
    }
}
