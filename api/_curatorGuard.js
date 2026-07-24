// ==========================================================
// api/_curatorGuard.js — Helper partagé
// Vérifie qu'une requête API vient d'un compte "curator" (Sniikks/369).
// Utilisé par les endpoints des pages réservées aux curateurs
// (guess.js, motcache.js, motfrancais.js) en plus de protected-write.js.
//
// Usage :
//   const guard = await requireCurator(req, res);
//   if (!guard.ok) return; // la réponse d'erreur a déjà été envoyée
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export async function requireCurator(req, res) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: 'Non connecté.', ok: false });
        return { ok: false };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
        res.status(401).json({ error: 'Session invalide, reconnecte-toi.', ok: false });
        return { ok: false };
    }

    const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .single();

    if (profileErr || !profile || profile.role !== 'curator') {
        res.status(403).json({ error: 'Réservé aux curateurs du site.', ok: false });
        return { ok: false };
    }

    return { ok: true, userId: userData.user.id };
}
