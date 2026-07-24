// ==========================================================
// protected-write.js — Passerelle d'écriture protégée (client)
// Toute écriture sur 369_games / sniikks_games / proposition /
// bracket_data passe par /api/protected-write, qui vérifie que
// l'appelant est connecté ET a le rôle "curator" (Sniikks / 369)
// dans la table profiles — voir supabase-migration-v4-auth.sql.
//
// Remplace l'ancien système de code partagé : plus de popup de code,
// l'identité vient de la session Supabase (voir auth.js / auth-ui.js).
// ==========================================================

const ProtectedWrite = {
  async call(payload) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      throw new Error('Connecte-toi avec un compte curateur pour modifier ça.');
    }

    const res = await fetch('/api/protected-write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 401) {
      throw new Error('Session expirée, reconnecte-toi.');
    }
    if (res.status === 403) {
      throw new Error('Réservé aux curateurs du site (Sniikks / 369).');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Erreur serveur.');
    }
    return await res.json().catch(() => ({}));
  }
};
