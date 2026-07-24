// ==========================================================
// /api/pixels.js — Vercel Serverless Function
// Fusion de pixels-state.js + pixels-image.js + pixels-action.js
// (limite de 12 fonctions du plan Hobby Vercel) — même logique,
// dispatchée par méthode/paramètre au lieu de 3 fichiers séparés :
//   GET  /api/pixels            → état public actuel (ex pixels-state.js)
//   GET  /api/pixels?image=1    → image de la manche (ex pixels-image.js)
//   POST /api/pixels            → deviner/passer/continuer/rejouer (ex pixels-action.js)
//
// PARTIE PROPRE À CHAQUE UTILISATEUR (24 juil.) : chaque appelant a
// désormais ses propres vies/série/manche, identifiés par son id de
// session (compte réel OU session anonyme, chacune a un id distinct) —
// avant, tout le monde partageait une seule partie globale. Les clés
// de stockage (avant fixes : "pixels_game", etc.) sont maintenant
// suffixées par cet id.
// ==========================================================

import { createClient } from '@supabase/supabase-js';
import { pickGameWithCover, fetchImageAsDataUri, isCorrectGuess, isCloseGuess, sharesLeadingToken } from './_pixelpool.js';
import { isSameFranchiseIgdb } from './_franchise.js';
import { rememberKnownGame } from './_knowngames.js';
import { getCallerId } from './_identify.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_LIVES = 3;
const MAX_ATTEMPTS = 5;
const LIFE_INTERVAL = 20; // +1 vie tous les X jeux trouvés d'affilée

function newRoundId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function yearFromUnix(ts) { return ts ? new Date(ts * 1000).getUTCFullYear() : null; }

// Clés de stockage propres à l'appelant (userId = compte réel ou session
// anonyme — jamais partagées entre deux personnes différentes).
function keysFor(userId) {
    return {
        GAME_KEY: `pixels_game_${userId}`,
        SECRET_KEY: `pixels_game_secret_${userId}`,
        IMAGE_KEY: `pixels_game_image_${userId}`
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.method === 'GET' && req.query.leaderboard !== undefined) {
            return await handleLeaderboard(req, res);
        }

        const userId = await getCallerId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Session invalide, recharge la page.' });
        }
        const keys = keysFor(userId);

        if (req.method === 'POST') return await handleAction(req, res, keys, userId);
        if (req.method === 'GET') {
            if (req.query.image !== undefined) return await handleImage(req, res, keys);
            return await handleState(req, res, keys);
        }
        return res.status(405).json({ error: 'Méthode non supportée.' });
    } catch (e) {
        console.error('❌ pixels error:', e);
        return res.status(500).json({ error: e.message });
    }
}

// ────────────────────────────────────────────────────────
// GET /api/pixels?leaderboard=1 — classement des meilleurs scores
// ────────────────────────────────────────────────────────
async function handleLeaderboard(req, res) {
    const { data, error } = await supabase
        .from('pixels_leaderboard')
        .select('username, best_score')
        .order('best_score', { ascending: false })
        .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ leaderboard: data || [] });
}

// Enregistre le score (série obtenue) d'une partie terminée — seulement
// pour un compte réel (pseudo connu) ; les sessions anonymes ne sont pas
// classées. Ne met à jour QUE si le score dépasse le meilleur déjà enregistré.
async function maybeUpdateLeaderboard(userId, score) {
    if (!score || score <= 0) return;
    try {
        const { data: profile } = await supabase.from('profiles').select('username').eq('id', userId).maybeSingle();
        if (!profile?.username) return; // session anonyme : pas de classement

        const { data: existing } = await supabase.from('pixels_leaderboard').select('best_score').eq('user_id', userId).maybeSingle();
        if (existing && existing.best_score >= score) return; // pas mieux que l'ancien score, on ne touche à rien

        await supabase.from('pixels_leaderboard').upsert({
            user_id: userId, username: profile.username, best_score: score, updated_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('❌ pixels leaderboard error:', e);
    }
}

// ────────────────────────────────────────────────────────
// GET /api/pixels?image=1 (ex pixels-image.js)
// ────────────────────────────────────────────────────────
async function handleImage(req, res, keys) {
    const { data } = await supabase.from('pixels_public').select('data').eq('id', keys.IMAGE_KEY).maybeSingle();
    if (!data?.data?.image) return res.status(404).json({ error: "Aucune image disponible." });
    return res.status(200).json(data.data);
}

// ────────────────────────────────────────────────────────
// GET /api/pixels (ex pixels-state.js)
// ────────────────────────────────────────────────────────
function freshRoundState(name, coverId, previousUsedNames = []) {
    return {
        roundId: newRoundId(),
        attempt: 0,
        guesses: [],
        roundOver: false,
        gameOver: false,
        reveal: null,
        usedNames: [...previousUsedNames, name]
    };
}

async function handleState(req, res, keys) {
    const { data: existing } = await supabase.from('pixels_public').select('data').eq('id', keys.GAME_KEY).maybeSingle();
    if (existing?.data?.roundId) {
        return res.status(200).json(existing.data);
    }

    // Aucune partie en cours pour cet utilisateur : on lui en crée une.
    const picked = await pickGameWithCover([]);
    if (!picked) {
        return res.status(503).json({ error: "Impossible de démarrer une partie pour l'instant, réessaie." });
    }
    const image = await fetchImageAsDataUri(picked.coverId);

    const round = freshRoundState(picked.name, picked.coverId, []);
    const publicData = { ...round, lives: MAX_LIVES, streak: 0 };

    await supabase.from('pixels_secret').upsert({ id: keys.SECRET_KEY, data: { name: picked.name, released: picked.released || null }, updated_at: new Date().toISOString() });
    await supabase.from('pixels_public').upsert({ id: keys.IMAGE_KEY, data: { roundId: round.roundId, image }, updated_at: new Date().toISOString() });
    await supabase.from('pixels_public').upsert({ id: keys.GAME_KEY, data: publicData, updated_at: new Date().toISOString() });

    return res.status(200).json(publicData);
}

// ────────────────────────────────────────────────────────
// POST /api/pixels (ex pixels-action.js)
// ────────────────────────────────────────────────────────
async function loadActionState(keys) {
    const [{ data: pub }, { data: secret }] = await Promise.all([
        supabase.from('pixels_public').select('data').eq('id', keys.GAME_KEY).maybeSingle(),
        supabase.from('pixels_secret').select('data').eq('id', keys.SECRET_KEY).maybeSingle()
    ]);
    return { publicData: pub?.data || null, secretName: secret?.data?.name || null, secretYear: yearFromUnix(secret?.data?.released) };
}

async function saveRound(publicData, name, coverId, released, keys) {
    const image = await fetchImageAsDataUri(coverId);
    await supabase.from('pixels_secret').upsert({ id: keys.SECRET_KEY, data: { name, released: released || null }, updated_at: new Date().toISOString() });
    await supabase.from('pixels_public').upsert({ id: keys.IMAGE_KEY, data: { roundId: publicData.roundId, image }, updated_at: new Date().toISOString() });
    await supabase.from('pixels_public').upsert({ id: keys.GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
}

async function savePublicOnly(publicData, keys) {
    await supabase.from('pixels_public').upsert({ id: keys.GAME_KEY, data: publicData, updated_at: new Date().toISOString() });
}

async function resolveLoss(publicData, secretName, secretYear, res, keys, userId) {
    publicData.lives--;
    publicData.guesses.push({ text: `✕ Réponse : ${secretName}`, wrong: true });
    publicData.roundOver = true;
    publicData.gameOver = publicData.lives <= 0;
    publicData.reveal = {
        name: secretName,
        verdict: publicData.gameOver ? 'Perdu — bien joué quand même' : 'Perdu cette image',
        win: false
    };
    await savePublicOnly(publicData, keys);
    await rememberKnownGame(supabase, secretName, secretYear);
    if (publicData.gameOver) await maybeUpdateLeaderboard(userId, publicData.streak);
    return res.status(200).json(publicData);
}

async function handleAction(req, res, keys, userId) {
    const { action, text } = req.body || {};
    if (!['guess', 'skip', 'continue', 'retry'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide.' });
    }

    let { publicData, secretName, secretYear } = await loadActionState(keys);
    if (!publicData) {
        return res.status(404).json({ error: "Aucune partie en cours. Recharge la page." });
    }

    // ── Rejouer : toujours autorisé (utile même en cours de partie si besoin) ──
    if (action === 'retry') {
        const picked = await pickGameWithCover([]);
        if (!picked) return res.status(503).json({ error: "Impossible de démarrer une nouvelle partie, réessaie." });
        const round = { roundId: newRoundId(), attempt: 0, guesses: [], roundOver: false, gameOver: false, reveal: null, usedNames: [picked.name] };
        const newPublic = { ...round, lives: MAX_LIVES, streak: 0 };
        await saveRound(newPublic, picked.name, picked.coverId, picked.released, keys);
        return res.status(200).json(newPublic);
    }

    // ── Continuer : uniquement après une manche conclue ──
    if (action === 'continue') {
        if (!publicData.roundOver) return res.status(409).json({ error: 'La manche en cours n\'est pas terminée.', state: publicData });
        if (publicData.gameOver) return res.status(409).json({ error: 'La partie est terminée, relance-en une nouvelle.', state: publicData });
        const picked = await pickGameWithCover(publicData.usedNames || []);
        if (!picked) {
            publicData.gameOver = true;
            await savePublicOnly(publicData, keys);
            return res.status(200).json(publicData);
        }
        const round = {
            roundId: newRoundId(), attempt: 0, guesses: [], roundOver: false, gameOver: false, reveal: null,
            usedNames: [...(publicData.usedNames || []), picked.name]
        };
        const newPublic = { ...round, lives: publicData.lives, streak: publicData.streak };
        await saveRound(newPublic, picked.name, picked.coverId, picked.released, keys);
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
            const lifeGained = publicData.streak % LIFE_INTERVAL === 0 && publicData.lives < MAX_LIVES;
            if (lifeGained) publicData.lives++;
            publicData.guesses.push({ text: `✓ Trouvé en ${publicData.attempt + 1}/${MAX_ATTEMPTS}`, wrong: false });
            publicData.roundOver = true;
            publicData.reveal = { name: secretName, verdict: lifeGained ? 'Trouvé ! 🎉 +1 vie ❤️' : 'Trouvé ! 🎉', win: true };
            await savePublicOnly(publicData, keys);
            await rememberKnownGame(supabase, secretName, secretYear);
            return res.status(200).json(publicData);
        }

        publicData.attempt++;
        if (publicData.attempt >= MAX_ATTEMPTS) {
            return await resolveLoss(publicData, secretName, secretYear, res, keys, userId);
        }
        let close = isCloseGuess(text, secretName);
        // Repli licence réelle : un seul mot en commun (le premier) ne suffit
        // pas à isCloseGuess (trop risqué, voir "Dead Island"/"Dead Space")
        // mais peut être le bon signal pour une vraie licence courte (ex.
        // "Amnesia", "Arma", "TrackMania"). Vérifié via IGDB SEULEMENT dans
        // ce cas précis (pas à chaque essai), pour rester rapide.
        if (!close && sharesLeadingToken(text, secretName)) {
            close = await isSameFranchiseIgdb(text, secretName);
        }
        publicData.guesses.push({ text: `${close ? '🔥' : '✕'} ${text.trim()}`, wrong: true, close });
        await savePublicOnly(publicData, keys);
        return res.status(200).json(publicData);
    }

    if (action === 'skip') {
        publicData.attempt++;
        if (publicData.attempt >= MAX_ATTEMPTS) {
            return await resolveLoss(publicData, secretName, secretYear, res, keys, userId);
        }
        publicData.guesses.push({ text: '» Passé', wrong: true });
        await savePublicOnly(publicData, keys);
        return res.status(200).json(publicData);
    }

    return res.status(400).json({ error: 'Action invalide.' });
}
