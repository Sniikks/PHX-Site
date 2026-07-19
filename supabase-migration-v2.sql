-- ==========================================================
-- MIGRATION v2 — une table Supabase par page, fin de "app_data"
-- À exécuter dans Supabase : SQL Editor > New query > Run
-- (à exécuter EN UNE FOIS, dans l'ordre, sur la base existante)
-- ==========================================================
--
-- Remplace la table fourre-tout "app_data" (id text, data jsonb) par une
-- table dédiée par page. Même format de ligne partout (id text primaire,
-- data jsonb, updated_at) pour ne pas casser le code existant — seul le
-- NOM de la table change page par page.
--
-- Nouveauté sécurité au passage : les données "secrètes" (réponse du jour
-- pour ZoomJeu / Mot Caché / Mot Français / Pixels) vivaient jusqu'ici dans
-- "app_data", qui a une policy de LECTURE PUBLIQUE. Rien n'empêchait donc
-- quelqu'un d'appeler l'API REST Supabase directement pour lire par exemple
-- "zoomjeu_secret_2026-07-19" et connaître la réponse du jour avant de
-- deviner. Les nouvelles tables *_secret n'ont AUCUNE policy de lecture :
-- seules les fonctions serverless (clé service, qui bypass RLS) peuvent
-- les lire. Le navigateur n'y a plus jamais accès, même en connaissant
-- l'URL + la clé anon.

-- ── Fonction utilitaire : policies standard (lecture publique, écriture
--    réservée à une session authentifiée même anonyme) ──
-- Réutilisée pour chaque table "publique" créée ci-dessous.

create or replace function _phx_apply_standard_policies(tbl text) returns void as $$
begin
  execute format('alter table %I enable row level security', tbl);
  execute format('drop policy if exists "Public read access" on %I', tbl);
  execute format('drop policy if exists "Authenticated write access" on %I', tbl);
  execute format('drop policy if exists "Authenticated update access" on %I', tbl);
  execute format('create policy "Public read access" on %I for select using (true)', tbl);
  execute format('create policy "Authenticated write access" on %I for insert with check (auth.role() = ''authenticated'')', tbl);
  execute format('create policy "Authenticated update access" on %I for update using (auth.role() = ''authenticated'')', tbl);
end;
$$ language plpgsql;

-- Tables "secrètes" : écriture réservée au rôle service (les fonctions
-- serverless utilisent SUPABASE_SERVICE_ROLE_KEY, qui bypass RLS de toute
-- façon) — donc AUCUNE policy = personne (ni anon ni authenticated) ne
-- peut lire ni écrire via l'API publique.
create or replace function _phx_apply_secret_policies(tbl text) returns void as $$
begin
  execute format('alter table %I enable row level security', tbl);
  -- Pas de policy créée : RLS activé + 0 policy = accès refusé à tout le
  -- monde sauf la clé service (qui bypass RLS).
end;
$$ language plpgsql;

-- ==========================================================
-- 1. LISTES DE JEUX (Sniikks_liste_de_jeux.html / 369_liste_de_jeux.html)
-- ==========================================================
create table if not exists sniikks_games (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists 369_games (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('sniikks_games');
select _phx_apply_standard_policies('369_games');

insert into sniikks_games (id, data, updated_at)
  select id, data, updated_at from app_data where id = 'backlog_jeux_v4'
  on conflict (id) do nothing;
insert into 369_games (id, data, updated_at)
  select id, data, updated_at from app_data where id = 'backlog_cards_v1'
  on conflict (id) do nothing;

-- ==========================================================
-- 2. BRACKET (bracket-jeux.html)
-- ==========================================================
create table if not exists bracket_data (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('bracket_data');

insert into bracket_data (id, data, updated_at)
  select id, data, updated_at from app_data
  where id in ('bracketJeux_savedImports', 'bracketJeux_defaultSeeded',
               'bracketJeux_defaultGames', 'bracketJeux_blacklists')
  on conflict (id) do nothing;

-- ==========================================================
-- 3. ZOOMJEU (zoomjeu.html)
-- ==========================================================
create table if not exists zoomjeu_public (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists zoomjeu_secret (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('zoomjeu_public');
select _phx_apply_secret_policies('zoomjeu_secret');

insert into zoomjeu_public (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'zoomjeu_2%' or id = 'zoomjeu_used'
  on conflict (id) do nothing;
insert into zoomjeu_secret (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'zoomjeu_secret_%'
  on conflict (id) do nothing;

-- ==========================================================
-- 4. MOT CACHÉ (mot-cache.html)
-- ==========================================================
create table if not exists motcache_public (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists motcache_secret (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('motcache_public');
select _phx_apply_secret_policies('motcache_secret');

insert into motcache_public (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'motcache_2%' or id = 'motcache_used'
  on conflict (id) do nothing;
insert into motcache_secret (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'motcache_secret_%'
  on conflict (id) do nothing;

-- ==========================================================
-- 5. MOT FRANÇAIS (mot-francais.html)
-- ==========================================================
create table if not exists motfrancais_public (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists motfrancais_secret (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('motfrancais_public');
select _phx_apply_secret_policies('motfrancais_secret');

insert into motfrancais_public (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'motfrancais_2%' or id = 'motfrancais_used'
  on conflict (id) do nothing;
insert into motfrancais_secret (id, data, updated_at)
  select id, data, updated_at from app_data
  where id like 'motfrancais_secret_%'
  on conflict (id) do nothing;

-- ==========================================================
-- 6. PIXELS (pixels.html)
-- ==========================================================
create table if not exists pixels_public (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists pixels_secret (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_standard_policies('pixels_public');
select _phx_apply_secret_policies('pixels_secret');

insert into pixels_public (id, data, updated_at)
  select id, data, updated_at from app_data
  where id in ('pixels_game', 'pixels_game_image')
  on conflict (id) do nothing;
insert into pixels_secret (id, data, updated_at)
  select id, data, updated_at from app_data
  where id = 'pixels_game_secret'
  on conflict (id) do nothing;

-- ==========================================================
-- 6bis. CACHE AUTOCOMPLÉTION (api/search-games.js — zoomjeu/pixels)
-- ==========================================================
-- Cache écrit au fil de l'eau : chaque saisie déjà cherchée par IGDB/Steam
-- est mémorisée ici (id = saisie en minuscules, data = suggestions).
-- Aucune policy créée : RLS activé + 0 policy = ni "anon" ni "authenticated"
-- ne peut lire/écrire via l'API REST publique — seule la fonction
-- serverless (clé service, qui bypass RLS) y touche. Personne d'extérieur
-- ne peut donc consulter ni modifier ce cache.
create table if not exists games_cache (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
select _phx_apply_secret_policies('games_cache');

-- ==========================================================
-- 7. TEMPS RÉEL — active la publication realtime sur les nouvelles
--    tables publiques (sinon les mises à jour en direct entre appareils
--    ne fonctionnent plus, comme c'était le cas pour app_data)
-- ==========================================================
do $$
declare
  t text;
begin
  foreach t in array array['sniikks_games','369_games','bracket_data',
                            'zoomjeu_public','motcache_public',
                            'motfrancais_public','pixels_public']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ==========================================================
-- 8. VÉRIFICATION — à faire AVANT de supprimer app_data
-- ==========================================================
-- Lance ces requêtes et compare les comptes avec l'ancien app_data :
--   select count(*) from sniikks_games;
--   select count(*) from 369_games;
--   select count(*) from bracket_data;
--   select count(*) from zoomjeu_public;
--   select count(*) from zoomjeu_secret;
--   select count(*) from motcache_public;
--   select count(*) from motcache_secret;
--   select count(*) from motfrancais_public;
--   select count(*) from motfrancais_secret;
--   select count(*) from pixels_public;
--   select count(*) from pixels_secret;
--   select count(*) from games_cache; -- 0 au départ, se remplit à l'usage, c'est normal
-- Recharge aussi chaque page du site (avec le nouveau code déployé) et
-- vérifie que les listes/parties en cours s'affichent bien AVANT de
-- passer à l'étape 9.

-- ==========================================================
-- 9. SUPPRESSION DE "app_data" — À NE FAIRE QU'APRÈS AVOIR VÉRIFIÉ
--    ci-dessus que tout fonctionne avec le nouveau code déployé.
--    Décommente et exécute séparément quand tu es prêt :
-- ==========================================================
-- drop table if exists app_data;
-- drop function if exists _phx_apply_standard_policies(text);
-- drop function if exists _phx_apply_secret_policies(text);
