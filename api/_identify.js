// ==========================================================
// api/_identify.js — Helper partagé
// Identifie l'utilisateur appelant à partir du token de session envoyé
// en header Authorization: Bearer <token> — sans exiger de rôle
// particulier (contrairement à _curatorGuard.js, réservé aux curateurs).
// Fonctionne aussi bien pour un vrai compte que pour une session
// anonyme (Bracket/Pixels) : chacune a un id utilisateur distinct.
//
// Usage :
//   const userId = await getCallerId(req);
//   if (!userId) return res.status(401).json({ error: '...' });
// ==========================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export async function getCallerId(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
}
