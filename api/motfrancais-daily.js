// ==========================================================
// /api/motfrancais-daily.js — Vercel Serverless Function
// Génère (une seule fois par jour, paresseusement : au 1er visiteur)
// le mot français du jour de "Mot Français" et le stocke dans
// Supabase (tables motfrancais_public / motfrancais_secret).
//
// Même principe que ZoomJeu / Mot Caché : la ligne publique porte
// AUSSI la "session" partagée (essais déjà tentés, résolu/échoué) —
// mot-francais.html s'abonne en temps réel à cette ligne (Supabase
// Realtime) : les deux joueurs voient donc exactement la même grille.
//
// Le mot lui-même reste dans une ligne SECRÈTE (comme motcache_secret_*
// / zoomjeu_secret_*), jamais lue par le navigateur : seul
// /api/motfrancais-guess.js compare les essais.
//
// Source du mot : contrairement à Mot Caché (SteamSpy + IGDB en
// direct), ici pas d'appel réseau externe : un pool STATIQUE d'environ
// 30 600 mots français (5 à 9 lettres, sans pluriel ni mot composé),
// déjà filtré à l'avance (voir _mots-francais.json). On y pioche un mot
// au hasard, jamais réutilisé (mots déjà tombés gardés dans
// 'motfrancais_used').
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import MOTS_POOL from './_mots-francais.json';

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

// Pioche un mot non encore utilisé. Si (un jour, très lointain) tout le
// pool est épuisé, on repart de zéro plutôt que de bloquer le jeu.
function pickWord(usedWords) {
    let candidates = MOTS_POOL.filter(w => !usedWords.has(w.word));
    if (!candidates.length) candidates = MOTS_POOL;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    // Bouton "Générer" (forcer un nouveau mot même si celui du jour existe déjà) :
    // réservé à l'admin, même clé/vérification que ZoomJeu / Mot Caché.
    const isAdmin = ADMIN_KEY && req.query.key === ADMIN_KEY;
    const force = req.query.force === 'true';
    if (force && !isAdmin) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    try {
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
    } catch (e) {
        console.error('❌ motfrancais-daily error:', e);
        return res.status(500).json({ error: e.message });
    }
}
