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