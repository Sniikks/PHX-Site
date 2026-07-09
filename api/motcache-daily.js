// ==========================================================
// /api/motcache-daily.js — Vercel Serverless Function
// Génère (une seule fois par jour, paresseusement : au 1er visiteur)
// le mot du jour de "Mot Caché" et le stocke dans Supabase (app_data).
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
// Source du mot : IGDB. On tire un lot de jeux populaires et on ne
// garde que les noms d'UN SEUL mot, 5 à 9 lettres (esprit "Portal /
// Skyrim / Halo / Celeste"), jamais réutilisé (mots déjà tombés
// gardés dans 'motcache_used').
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { igdbQuery, isIgdbConfigured } from './_igdb.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_TRIES = 6;

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

async function pickWordFromIgdb(usedWords) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const offset = Math.floor(Math.random() * 800);
        const body = `fields name, cover.image_id; where version_parent = null & name != null & cover != null; sort follows desc; limit 500; offset ${offset};`;
        let results;
        try { results = await igdbQuery('games', body, 8000); } catch (e) { continue; }
        if (!Array.isArray(results)) continue;

        const candidates = results.filter(r => {
            const name = (r.name || '').trim();
            if (!name || name.includes(' ')) return false;
            const core = name.split(/[:\-]/)[0].trim();
            if (core.includes(' ')) return false;
            const clean = normalizeWord(core);
            return clean.length >= 5 && clean.length <= 9 && !usedWords.has(clean);
        });
        if (candidates.length) {
            const chosen = candidates[Math.floor(Math.random() * candidates.length)];
            const clean = normalizeWord(chosen.name.split(/[:\-]/)[0].trim());
            const cover = chosen.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${chosen.cover.image_id}.jpg` : null;
            return { word: clean, name: chosen.name, cover };
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

    try {
        const dateStr = getParisDateString();

        const { data: existing } = await supabase.from('app_data').select('data').eq('id', puzzleKey(dateStr)).maybeSingle();
        if (existing?.data?.wordLength) {
            const publicData = existing.data;
            publicData.session = publicData.session || { guesses: [], solved: false, failed: false };
            return res.status(200).json(publicData);
        }

        const { data: usedRow } = await supabase.from('app_data').select('data').eq('id', 'motcache_used').maybeSingle();
        const usedWords = new Set(usedRow?.data?.words || []);

        const picked = await pickWordFromIgdb(usedWords);
        if (!picked) {
            return res.status(503).json({ error: "Impossible de trouver un mot pour aujourd'hui, réessaie dans un instant." });
        }

        const puzzleId = dateStr + '_' + Math.random().toString(36).slice(2, 8);

        const secret = { word: picked.word, name: picked.name, cover: picked.cover, puzzleId };
        await supabase.from('app_data').upsert({ id: secretKey(dateStr), data: secret, updated_at: new Date().toISOString() });

        const publicData = {
            date: dateStr,
            puzzleId,
            wordLength: picked.word.length,
            maxTries: MAX_TRIES,
            session: { guesses: [], solved: false, failed: false }
        };
        await supabase.from('app_data').upsert({ id: puzzleKey(dateStr), data: publicData, updated_at: new Date().toISOString() });

        usedWords.add(picked.word);
        await supabase.from('app_data').upsert({ id: 'motcache_used', data: { words: [...usedWords] }, updated_at: new Date().toISOString() });

        return res.status(200).json(publicData);
    } catch (e) {
        console.error('❌ motcache-daily error:', e);
        return res.status(500).json({ error: e.message });
    }
}
