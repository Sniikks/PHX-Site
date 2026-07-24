// ==========================================================
// /api/protected-write.js — Vercel Serverless Function
// Passerelle d'écriture protégée pour les tables modifiées en direct
// depuis le navigateur : 369_games, sniikks_games, proposition,
// bracket_data.
//
// Remplace l'ancien code partagé (SITE_WRITE_CODE) : l'appelant doit
// présenter un token de session Supabase valide (header Authorization:
// Bearer <token>, envoyé par protected-write.js côté client), ET son
// compte doit avoir le rôle "curator" dans la table profiles (voir
// supabase-migration-v4-auth.sql). L'écriture se fait ensuite avec la
// clé service_role (qui ignore RLS).
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_TABLES = new Set(['369_games', 'sniikks_games', 'proposition', 'bracket_data']);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non supportée.' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Configuration serveur incomplète (clé service_role manquante).' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Non connecté.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ── Qui est l'appelant ? ──
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
        return res.status(401).json({ error: 'Session invalide, reconnecte-toi.' });
    }

    // ── Est-il curateur ? ──
    const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .single();

    if (profileErr || !profile || profile.role !== 'curator') {
        return res.status(403).json({ error: 'Réservé aux curateurs du site.' });
    }

    const { table, mode, key, value, id, data } = req.body || {};

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
