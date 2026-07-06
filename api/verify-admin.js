// ==========================================================
// /api/verify-admin.js — Vercel Serverless Function
// Vérifie qu'une clé admin est valide, sans rien faire d'autre.
// Utilisé par les actions sensibles côté client (ex: bouton
// "Réinitialiser les avis" de la tier list) pour exiger la clé
// avant d'exécuter. Réutilise la variable d'environnement
// ADMIN_KEY déjà configurée dans Vercel (celle de generate-daily).
//
// Réponses : 200 {ok:true} si la clé est bonne, 401 {ok:false} sinon.
// ==========================================================

export default function handler(req, res) {
    const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
    res.setHeader('Cache-Control', 'no-store');
    const ok = !!ADMIN_KEY && (req.query.key || '') === ADMIN_KEY;
    return res.status(ok ? 200 : 401).json({ ok });
}
