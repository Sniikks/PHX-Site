// ==========================================================
// /api/image.js — Vercel Serverless Function
// Sert le screenshot du puzzle en proxy : /api/image?d=YYYY-MM-DD
//
// Pourquoi ? L'URL directe du screenshot trahissait la réponse :
//  - Steam : https://.../steam/apps/<APPID>/... (l'appid suffit à
//    retrouver le jeu),
//  - RAWG/IGDB : l'URL contient parfois le slug ou un id du jeu.
// Un joueur qui ouvrait F12 > Réseau voyait donc d'où venait
// l'image. Ici, l'URL publique ne contient que la date : la vraie
// URL est lue dans la ligne secrète "zoomjeu_secret_YYYY-MM-DD".
//
// Cache : la réponse est mise en cache par le CDN Vercel (s-maxage
// long + immutable). Le générateur ajoute un paramètre &v=... à
// l'URL stockée dans le puzzle : si le puzzle est régénéré (&force),
// le paramètre change et le cache est naturellement contourné.
//
// Rétro-compatibilité : pour les anciens puzzles (pas de ligne
// secrète), on ressert l'URL déjà publique de la ligne classique.
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};

export default async function handler(req, res) {
    const d = String(req.query.d || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).send('Requête invalide');
    }

    try {
        const { data: secretRow } = await supabase
            .from('app_data').select('data').eq('id', 'zoomjeu_secret_' + d).maybeSingle();

        let imageUrl = secretRow?.data?.image || null;

        // Repli anciens puzzles : l'image était déjà publique, on la ressert telle quelle.
        if (!imageUrl) {
            const { data: pubRow } = await supabase
                .from('app_data').select('data').eq('id', 'zoomjeu_' + d).maybeSingle();
            const img = pubRow?.data?.image;
            if (img && /^https?:\/\//i.test(img)) imageUrl = img;
        }

        if (!imageUrl) return res.status(404).send('Image introuvable');

        const upstream = await fetch(imageUrl, { headers: BROWSER_HEADERS });
        if (!upstream.ok) return res.status(502).send('Image source indisponible');

        const buf = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
        // Cache navigateur court (1 h) mais cache CDN long : le paramètre &v=
        // ajouté par le générateur invalide le CDN en cas de régénération.
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=31536000, immutable');
        return res.status(200).send(buf);
    } catch (e) {
        console.error('❌ image proxy error:', e);
        return res.status(500).send('Erreur serveur');
    }
}
