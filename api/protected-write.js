// ==========================================================
// /api/protected-write.js — Vercel Serverless Function
// Passerelle d'écriture protégée par un code partagé, pour les tables
// modifiées en direct depuis le navigateur (pas de système de compte
// sur le site) : 369_games, sniikks_games, proposition, bracket_data.
// Le code est vérifié ICI, côté serveur, puis l'écriture se fait avec
// la clé service_role (qui ignore RLS) — les policies RLS de ces 4
// tables n'autorisent plus aucune écriture directe depuis le navigateur.
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

    if (code !== SITE_WRITE_CODE) {
        return res.status(401).json({ error: 'Code incorrect.' });
    }
    if (!ALLOWED_TABLES.has(table)) {
        return res.status(400).json({ error: 'Table non autorisée.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
