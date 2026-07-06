-- ==========================================================
-- SCHÉMA SUPABASE — Backlog Jeux
-- À exécuter dans Supabase : SQL Editor > New query > Run
-- ==========================================================

-- Table générique clé/valeur : chaque page stocke son JSON
-- sous une clé (id) différente dans la colonne "data" (jsonb).
--
-- Clés utilisées par le site :
--   'backlog_jeux_v4'          -> liste des jeux réalisés (jeux-realises.html)
--   'bracketJeux_savedImports' -> listes de jeux sauvegardées (bracket-jeux.html)
--   'bracketJeux_blacklists'   -> blacklists sauvegardées (bracket-jeux.html)
--   (tes 2 futures pages pourront simplement utiliser de nouvelles clés)

create table if not exists app_data (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

-- Active la Row Level Security (bonne pratique même en accès public)
alter table app_data enable row level security;

-- Politique : lecture, insertion et mise à jour ouvertes via la clé "anon".
-- ⚠️ Quiconque a ton URL + clé anon peut lire/écrire ces données.
-- C'est acceptable pour un usage perso sans compte utilisateur,
-- mais NE mets jamais de données sensibles dans cette table.
--
-- 🔒 La suppression (DELETE) n'est PAS autorisée : le code du site
-- n'en a pas besoin (il ne fait que select/upsert), et cela empêche
-- un visiteur malveillant de vider toute la table en une requête.
--
-- Si tu veux restreindre plus tard, remplace ces policies par une
-- vérification d'authentification Supabase (auth.uid()).

create policy "Public read access"
  on app_data for select
  using (true);

create policy "Public write access"
  on app_data for insert
  with check (true);

create policy "Public update access"
  on app_data for update
  using (true);

-- ==========================================================
-- MIGRATION — à exécuter UNE FOIS sur ta base existante
-- (SQL Editor > New query > coller la ligne ci-dessous > Run)
-- ==========================================================
-- drop policy if exists "Public delete access" on app_data;

-- Si le temps réel ne fonctionne pas (listes qui ne se mettent pas à jour
-- entre deux appareils), vérifie que la table est bien dans la publication :
-- alter publication supabase_realtime add table app_data;
