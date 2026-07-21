// ==========================================================
// /api/protected-write.js — Vercel Serverless Function
// Passerelle d'écriture protégée par un code partagé, pour les tables
// modifiées en direct depuis le navigateur (pas de système de compte
// sur le site) : 369_games, sniikks_games, proposition, bracket_data.
// Le code est vérifié ICI, côté serveur, puis l'écriture se fait avec
// la clé service_role (qui ignore RLS) — les policies RLS de ces 4
// tables n'autorisent plus aucune écriture directe depuis le navigateur.
//
// Anti-brute-force : les fonctions serverless n'ont pas de mémoire
// persistante entre appels, donc le compteur de tentatives ratées est
// stocké dans une table dédiée (write_attempts, verrouillée à
// service_role — jamais accessible depuis le navigateur). Après
// MAX_ATTEMPTS échecs pour une même IP, blocage de LOCKOUT_MINUTES.
//
//   POST /api/protected-write
//   body: { code, table, mode, ...selon le mode }
//     mode 'kv'     : { key, value }         → upsert {id:key, data:value}  (RemoteStore)
//     mode 'insert' : { data }                → insert une ligne, renvoie la ligne créée
//     mode 'update' : { id, data }             → update la ligne id
//     mode 'delete' : { id }                   → delete la ligne id
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_WRITE_CODE = process.env.SITE_WRITE_CODE;

const ALLOWED_TABLES = new Set(['369_games', 'sniikks_games', 'proposition', 'bracket_data']);

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Configuration serveur incomplète (clé service_role manquante).' });
    }
    if (!SITE_WRITE_CODE) {
        return res.status(500).json({ error: "Code d'accès non configuré côté serveur (SITE_WRITE_CODE manquant)." });
    }

    const { code, table, mode, key, value, id, data } = req.body || {};
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const ip = getClientIp(req);
    const now = new Date();

    // ── Anti-brute-force : cette IP est-elle actuellement bloquée ? ──
    let attemptRow = null;
    try {
        const { data: row } = await supabase.from('write_attempts').select('*').eq('ip', ip).maybeSingle();
        attemptRow = row;
    } catch (e) { console.error('write_attempts lecture, erreur:', e); }

    if (attemptRow?.locked_until && new Date(attemptRow.locked_until) > now) {
        const minutesLeft = Math.ceil((new Date(attemptRow.locked_until) - now) / 60000);
        return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${minutesLeft} min.` });
    }

    // ── Vérification du code ──
    if (code !== SITE_WRITE_CODE) {
        try {
            const failCount = (attemptRow?.fail_count || 0) + 1;
            const upd = { ip, fail_count: failCount, updated_at: now.toISOString() };
            if (failCount >= MAX_ATTEMPTS) {
                upd.locked_until = new Date(now.getTime() + LOCKOUT_MINUTES * 60000).toISOString();
                upd.fail_count = 0; // le verrou prend le relai, on repart de zéro après
            } else {
                upd.locked_until = null;
            }
            await supabase.from('write_attempts').upsert(upd, { onConflict: 'ip' });
        } catch (e) { console.error('write_attempts écriture, erreur:', e); }
        return res.status(401).json({ error: 'Code incorrect.' });
    }

    // Code correct : on efface l'historique d'échecs de cette IP.
    if (attemptRow) {
        try {
            await supabase.from('write_attempts').update({ fail_count: 0, locked_until: null, updated_at: now.toISOString() }).eq('ip', ip);
        } catch (e) { console.error('write_attempts reset, erreur:', e); }
    }

    if (!ALLOWED_TABLES.has(table)) {
        return res.status(400).json({ error: 'Table non autorisée.' });
    }

    try {
        if (mode === 'kv') {
            if (!key) return res.status(400).json({ error: 'Clé manquante.' });
            const { error } = await supabase
                .from(table)
                .upsert({ id: key, data: value, updated_at: new Date().toISOString() });
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        if (mode === 'insert') {
            if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Données manquantes.' });
            const { data: rows, error } = await supabase.from(table).insert(data).select();
            if (error) throw error;
            return res.status(200).json(rows);
        }

        if (mode === 'update') {
            if (!id) return res.status(400).json({ error: 'id manquant.' });
            if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Données manquantes.' });
            const { error } = await supabase.from(table).update(data).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        if (mode === 'delete') {
            if (!id) return res.status(400).json({ error: 'id manquant.' });
            const { error } = await supabase.from(table).delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'mode invalide.' });
    } catch (e) {
        console.error('❌ protected-write error:', e);
        return res.status(500).json({ error: e.message });
    }
}
