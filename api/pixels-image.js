// ==========================================================
// /api/pixels-image.js — Vercel Serverless Function
// Renvoie l'image (base64) de la manche actuelle de "Pixels".
// Stockée séparément de l'état public (pixels_game) pour que les
// mises à jour temps réel (essai, vie perdue…) restent légères — le
// client ne rappelle cette route que quand il détecte un roundId
// différent de celui qu'il affiche déjà.
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { data } = await supabase.from('app_data').select('data').eq('id', 'pixels_game_image').maybeSingle();
        if (!data?.data?.image) return res.status(404).json({ error: "Aucune image disponible." });
        return res.status(200).json(data.data);
    } catch (e) {
        console.error('❌ pixels-image error:', e);
        return res.status(500).json({ error: e.message });
    }
}
