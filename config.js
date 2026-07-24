// ==========================================================
// CONFIGURATION SUPABASE
// ==========================================================
// 1. Crée un projet sur https://supabase.com
// 2. Va dans Project Settings > API
// 3. Copie "Project URL" et "anon public" key ci-dessous
// ==========================================================

const SUPABASE_URL = "https://qalytqwjpzugzxjhymkh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_sN9nt7F-gdP_hSG6NQZmmQ_NnKbCMPe";

// ==========================================================
// STOCKAGE DYNAMIQUE DE SESSION — case "rester connecté"
// ==========================================================
// Par défaut, Supabase garde la session dans localStorage (persiste même
// après fermeture du navigateur). Pour permettre de choisir ("rester
// connecté" décoché = déconnecté à la fermeture de l'onglet), on route
// nous-mêmes vers localStorage ou sessionStorage selon une préférence
// choisie au moment de la connexion (voir auth.js: signIn(...,rememberMe)).
// La préférence elle-même vit dans localStorage (juste un mot, rien de
// sensible) pour être connue dès le prochain chargement de page.
const PHX_PERSIST_PREF_KEY = 'phx_persist_pref'; // 'local' (défaut) | 'session'

const phxDynamicStorage = {
  getItem(key) {
    const pref = localStorage.getItem(PHX_PERSIST_PREF_KEY) || 'local';
    return (pref === 'session' ? sessionStorage : localStorage).getItem(key);
  },
  setItem(key, value) {
    const pref = localStorage.getItem(PHX_PERSIST_PREF_KEY) || 'local';
    (pref === 'session' ? sessionStorage : localStorage).setItem(key, value);
  },
  removeItem(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
};

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: phxDynamicStorage, persistSession: true, autoRefreshToken: true }
});

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
//
// ⚠️ IMPORTANT : signInAnonymously() ne doit JAMAIS être appelé s'il existe
// déjà une session (un vrai compte connecté, Sniikks/369 ou autre) — sinon
// elle est remplacée par une session anonyme à CHAQUE chargement de page,
// ce qui déconnecte silencieusement tout le monde en permanence. On vérifie
// donc d'abord qu'aucune session n'existe avant d'en ouvrir une anonyme.
supabaseClient.auth.getSession().then(({ data: { session } }) => {
  if (!session) {
    supabaseClient.auth.signInAnonymously().catch(() => {});
  }
});