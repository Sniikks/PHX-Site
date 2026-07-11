// ==========================================================
// CONFIGURATION SUPABASE
// ==========================================================
// 1. Crée un projet sur https://supabase.com
// 2. Va dans Project Settings > API
// 3. Copie "Project URL" et "anon public" key ci-dessous
// ==========================================================

const SUPABASE_URL = "https://qalytqwjpzugzxjhymkh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_sN9nt7F-gdP_hSG6NQZmmQ_NnKbCMPe";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================================
// SESSION ANONYME AUTOMATIQUE
// ==========================================================
// Avant : n'importe qui connaissant l'URL + la clé anon pouvait
// écrire dans la base directement depuis la console du navigateur.
// Désormais, écrire nécessite d'être "connecté" — même de façon
// anonyme, sans email ni mot de passe. Cette ligne ouvre cette
// session anonyme automatiquement, dès le chargement de la page,
// pour que ça reste invisible pour le visiteur.
//
// ⚠️ Nécessite d'avoir activé "Anonymous Sign-Ins" dans le
// dashboard Supabase (Authentication > Sign In / Providers) ET
// d'avoir appliqué la migration RLS du fichier supabase-schema.sql
// AVANT de resserrer les policies, sous peine de casser les
// écritures du site. Voir les instructions dans supabase-schema.sql.
//
// Si la connexion échoue (offline, anon sign-in pas encore activé
// côté Supabase...), on n'affiche rien et le site continue de
// fonctionner en lecture — exactement comme avant cette évolution.
supabaseClient.auth.signInAnonymously().catch(() => {});