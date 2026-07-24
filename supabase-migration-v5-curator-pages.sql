-- ==========================================================
-- MIGRATION v5 — Pages réservées aux curateurs (lecture incluse)
-- À exécuter APRÈS supabase-migration-v4-auth.sql
-- SQL Editor > New query > coller > Run
-- ==========================================================
-- Jusqu'ici, seules les ÉCRITURES sur 369_games / sniikks_games /
-- proposition étaient réservées aux curateurs (via api/protected-write.js).
-- La LECTURE restait publique ("Public read access" using(true)) : un
-- visiteur non connecté, ou connecté sans être curateur, pouvait quand
-- même lire (voire écrire directement en appelant l'API REST Supabase
-- avec la clé anon, en contournant le site) ces tables, ainsi que celles
-- de ZoomJeu / Jeu Caché / Mot Français.
--
-- Cette migration verrouille aussi la LECTURE de ces tables aux seuls
-- comptes "curator". Les tables non listées ici (bracket_data, pixels_*,
-- games_cache, known_games...) restent accessibles à tous : Bracket et
-- Pixels ne sont PAS des pages réservées.
-- ==========================================================

create or replace function public.is_curator(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = uid and role = 'curator'
  );
$$;

-- Fonction utilitaire : remplace les anciennes policies "publiques" par
-- des policies réservées aux curateurs (lecture ET écriture directe —
-- l'écriture réelle passe de toute façon par les endpoints serveur qui
-- utilisent la clé service_role, mais on ferme aussi la porte directe).
create or replace function _phx_restrict_to_curators(tbl text) returns void as $$
begin
  execute format('drop policy if exists "Public read access" on %I', tbl);
  execute format('drop policy if exists "Authenticated write access" on %I', tbl);
  execute format('drop policy if exists "Authenticated update access" on %I', tbl);
  execute format('drop policy if exists "Authenticated delete access" on %I', tbl);
  execute format('drop policy if exists "Curator read access" on %I', tbl);
  execute format('drop policy if exists "Curator write access" on %I', tbl);
  execute format('drop policy if exists "Curator update access" on %I', tbl);
  execute format('drop policy if exists "Curator delete access" on %I', tbl);

  execute format('create policy "Curator read access" on %I for select using (is_curator(auth.uid()))', tbl);
  execute format('create policy "Curator write access" on %I for insert with check (is_curator(auth.uid()))', tbl);
  execute format('create policy "Curator update access" on %I for update using (is_curator(auth.uid()))', tbl);
  execute format('create policy "Curator delete access" on %I for delete using (is_curator(auth.uid()))', tbl);
end;
$$ language plpgsql;

select _phx_restrict_to_curators('369_games');
select _phx_restrict_to_curators('sniikks_games');
select _phx_restrict_to_curators('proposition');
select _phx_restrict_to_curators('zoomjeu_public');
select _phx_restrict_to_curators('motcache_public');
select _phx_restrict_to_curators('motfrancais_public');

-- ⚠️ bracket_data, pixels_public, games_cache, known_games : PAS touchés,
-- ces pages/fonctionnalités restent ouvertes à tous les visiteurs.

-- ==========================================================
-- Rappel : tant qu'aucun compte n'a le rôle "curator" (voir l'étape
-- manuelle à la fin de supabase-migration-v4-auth.sql), plus PERSONNE —
-- pas même Sniikks/369 — ne peut lire ces 6 tables. Fais donc l'étape
-- "role = 'curator'" AVANT ou juste APRÈS avoir exécuté ce fichier.
-- ==========================================================
