// ==========================================================
// /api/pixels-action.js — Vercel Serverless Function
// Seule route qui fait progresser la partie PARTAGÉE de "Pixels".
// Toute action (deviner, passer, continuer après une manche,
// rejouer après une partie terminée) passe par ici et met à jour la
// même ligne Supabase que tout le monde regarde (comme /api/guess.js
// pour ZoomJeu et /api/motcache-guess.js pour Mot Caché) — jamais de
// nouvelle image générée par un simple chargement de page.
//
// POST { action: 'guess', text } | { action: 'skip' } | { action: 'continue' } | { action: 'retry' }
// Réponse : l'état public à jour (pixels_game).
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { pickGameWithCover, fetchImageAsDataUri, isCorrectGuess } from './_pixelpool.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GAME_KEY = 'pixels_game';
const SECRET_KEY = 'pixels_game_secret';
const IMAGE_KEY = 'pixels_game_image';
const MAX_LIVES = 3;
const MAX_ATTEMPTS = 5;

function newRoundId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function loadState() {
    const [{ data: pub }, { data: secret }] = await Promise.all([
        supabase.from('app_data').select('data').eq('id', GAME_KEY).maybeSingle(),
        supabase.from('app_data').select('data').eq('id', SECRET_KEY).maybeSingle()
    ]);
    return { publicData: pub?.data || null, secretName: secret?.data?.name || null };
}

async function saveRound(publicData, name, coverId) {
    const image = await fetchImageAsDataUri(coverId);
    await supabase.from('app_data').upsert({ id: SECRET_KEY, data: { name }, updated_at: new Date().toISOString() });
    await supabase.from('app_data').upsert({ id: IMAGE_KEY, data: { roundId: publicData.roundId, image }, updated_at: new Date().toISOString() });
    await supabase.from('app_data').upsert({ id: GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
}

async function savePublicOnly(publicData) {
    await supabase.from('app_data').upsert({ id: GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }

    try {
        const { action, text } = req.body || {};
        if (!['guess', 'skip', 'continue', 'retry'].includes(action)) {
            return res.status(400).json({ error: 'Action invalide.' });
        }

        let { publicData, secretName } = await loadState();
        if (!publicData) {
            return res.status(404).json({ error: "Aucune partie en cours. Recharge la page." });
        }

        // ── Rejouer : toujours autorisé (utile même en cours de partie si besoin) ──
        if (action === 'retry') {
            const picked = await pickGameWithCover([]);
            if (!picked) return res.status(503).json({ error: "Impossible de démarrer une nouvelle partie, réessaie." });
            const round = { roundId: newRoundId(), attempt: 0, guesses: [], roundOver: false, gameOver: false, reveal: null, usedNames: [picked.name] };
            const newPublic = { ...round, lives: MAX_LIVES, streak: 0 };
            await saveRound(newPublic, picked.name, picked.coverId);
            return res.status(200).json(newPublic);
        }

        // ── Continuer : uniquement après une manche conclue ──
        if (action === 'continue') {
            if (!publicData.roundOver) return res.status(409).json({ error: 'La manche en cours n\'est pas terminée.', state: publicData });
            if (publicData.gameOver) return res.status(409).json({ error: 'La partie est terminée, relance-en une nouvelle.', state: publicData });
            const picked = await pickGameWithCover(publicData.usedNames || []);
            if (!picked) {
                // Plus aucun jeu disponible hors doublons : on termine proprement la partie.
                publicData.gameOver = true;
                await savePublicOnly(publicData);
                return res.status(200).json(publicData);
            }
            const round = {
                roundId: newRoundId(), attempt: 0, guesses: [], roundOver: false, gameOver: false, reveal: null,
                usedNames: [...(publicData.usedNames || []), picked.name]
            };
            const newPublic = { ...round, lives: publicData.lives, streak: publicData.streak };
            await saveRound(newPublic, picked.name, picked.coverId);
            return res.status(200).json(newPublic);
        }

        // ── Deviner / Passer : uniquement en cours de manche ──
        if (publicData.roundOver || publicData.gameOver) {
            return res.status(409).json({ error: 'La manche est terminée, clique sur "Jeu suivant".', state: publicData });
        }
        if (!secretName) return res.status(404).json({ error: 'Partie introuvable.' });

        if (action === 'guess') {
            if (!text || typeof text !== 'string' || !text.trim()) {
                return res.status(400).json({ error: 'Essai invalide.' });
            }
            if (isCorrectGuess(text, secretName)) {
                publicData.streak++;
                // Tous les 10 niveaux réussis d'affilée : +1 vie, sauf si déjà au max.
                const lifeGained = publicData.streak % 10 === 0 && publicData.lives < MAX_LIVES;
                if (lifeGained) publicData.lives++;
                publicData.guesses.push({ text: `✓ Trouvé en ${publicData.attempt + 1}/${MAX_ATTEMPTS}`, wrong: false });
                publicData.roundOver = true;
                publicData.reveal = { name: secretName, verdict: lifeGained ? 'Trouvé ! 🎉 +1 vie ❤️' : 'Trouvé ! 🎉', win: true };
                await savePublicOnly(publicData);
                return res.status(200).json(publicData);
            }

            publicData.attempt++;
            if (publicData.attempt >= MAX_ATTEMPTS) {
                return await resolveLoss(publicData, secretName, res);
            }
            publicData.guesses.push({ text: `✕ ${text.trim()}`, wrong: true });
            await savePublicOnly(publicData);
            return res.status(200).json(publicData);
        }

        if (action === 'skip') {
            publicData.attempt++;
            if (publicData.attempt >= MAX_ATTEMPTS) {
                return await resolveLoss(publicData, secretName, res);
            }
            publicData.guesses.push({ text: '» Passé', wrong: true });
            await savePublicOnly(publicData);
            return res.status(200).json(publicData);
        }

        return res.status(400).json({ error: 'Action invalide.' });
    } catch (e) {
        console.error('❌ pixels-action error:', e);
        return res.status(500).json({ error: e.message });
    }
}

async function resolveLoss(publicData, secretName, res) {
    publicData.lives--;
    publicData.guesses.push({ text: `✕ Réponse : ${secretName}`, wrong: true });
    publicData.roundOver = true;
    publicData.reveal = {
        name: secretName,
        verdict: publicData.lives <= 0 ? 'Perdu — bien joué quand même' : 'Perdu cette image',
        win: false
    };
    await savePublicOnly(publicData);
    return res.status(200).json(publicData);
}
