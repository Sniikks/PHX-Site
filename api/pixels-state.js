// ==========================================================
// /api/pixels-state.js — Vercel Serverless Function
// Renvoie l'état PARTAGÉ actuel de "Pixels" (une seule partie pour
// tout le monde, comme Mot Caché/ZoomJeu). Ne génère une manche que
// si AUCUNE partie n'existe encore en base (tout premier lancement) :
// un simple chargement/rechargement de page ne crée jamais une
// nouvelle image — seules les actions réelles (deviner/passer/
// continuer/rejouer, voir /api/pixels-action.js) le font.
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { pickGameWithCover, fetchImageAsDataUri } from './_pixelpool.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GAME_KEY = 'pixels_game';
const SECRET_KEY = 'pixels_game_secret';
const IMAGE_KEY = 'pixels_game_image';
const MAX_LIVES = 3;

function freshRoundState(name, coverId, previousUsedNames = []) {
    return {
        roundId: Math.random().toString(36).slice(2) + Date.now().toString(36),
        attempt: 0,
        guesses: [],
        roundOver: false,
        gameOver: false,
        reveal: null,
        usedNames: [...previousUsedNames, name]
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    try {
        const { data: existing } = await supabase.from('app_data').select('data').eq('id', GAME_KEY).maybeSingle();
        if (existing?.data?.roundId) {
            return res.status(200).json(existing.data);
        }

        // Aucune partie en cours nulle part : on en crée une (bootstrap).
        const picked = await pickGameWithCover([]);
        if (!picked) {
            return res.status(503).json({ error: "Impossible de démarrer une partie pour l'instant, réessaie." });
        }
        const image = await fetchImageAsDataUri(picked.coverId);

        const round = freshRoundState(picked.name, picked.coverId, []);
        const publicData = { ...round, lives: MAX_LIVES, streak: 0 };

        await supabase.from('app_data').upsert({ id: SECRET_KEY, data: { name: picked.name }, updated_at: new Date().toISOString() });
        await supabase.from('app_data').upsert({ id: IMAGE_KEY, data: { roundId: round.roundId, image }, updated_at: new Date().toISOString() });
        await supabase.from('app_data').upsert({ id: GAME_KEY, data: publicData, updated_at: new Date().toISOString() });

        return res.status(200).json(publicData);
    } catch (e) {
        console.error('❌ pixels-state error:', e);
        return res.status(500).json({ error: e.message });
    }
}
