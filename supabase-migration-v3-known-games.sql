-- ==========================================================
-- MIGRATION v3 — catalogue interne "known_games"
-- À exécuter dans Supabase : SQL Editor > New query > Run
-- (vient EN PLUS de supabase-migration-v2.sql, déjà exécutée)
-- ==========================================================
--
-- Chaque jeu qui a un jour été la réponse d'un ZoomJeu ou d'un Pixels est
-- désormais enregistré ici (id = nom en minuscules, name = nom affiché,
-- year), qu'il ait été trouvé ou non par les joueurs. Objectif : que
-- l'autocomplétion (api/search-games.js) le retrouve TOUJOURS ensuite,
-- même si IGDB/Steam ne le proposent pas ce jour-là (fiche Steam
-- fusionnée avec d'autres jeux de la même série, IGDB indisponible,
-- filtre anti-DLC trop large...).
--
-- Verrouillée comme games_cache/*_secret : RLS activé, AUCUNE policy
-- créée = ni "anon" ni "authenticated" ne peut lire/écrire via l'API
-- REST publique, seule la clé service (utilisée par les fonctions
-- serverless) y a accès.

create table if not exists known_games (
  id text primary key,
  name text not null,
  year int,
  updated_at timestamptz default now()
);

-- Réutilise la fonction créée par supabase-migration-v2.sql. Si tu obtiens
-- une erreur "function _phx_apply_secret_policies does not exist", relance
-- d'abord la section 1 de supabase-migration-v2.sql (elle la recrée).
select _phx_apply_secret_policies('known_games');

-- Index pour accélérer la recherche "contient" utilisée par l'autocomplétion
-- (ilike '%texte%') — nécessite l'extension pg_trgm, activée par défaut sur
-- la plupart des projets Supabase.
create extension if not exists pg_trgm;
create index if not exists known_games_name_trgm_idx on known_games using gin (name gin_trgm_ops);
