-- ==========================================================
-- MIGRATION v4 — Vrai système de comptes (Supabase Auth)
-- À exécuter UNE FOIS : SQL Editor > New query > coller > Run
-- ==========================================================
-- Remplace le code partagé (SITE_WRITE_CODE / protected-write.js)
-- par de vrais comptes. Seuls les comptes marqués "curator" dans la
-- table profiles (Sniikks + 369) peuvent modifier 369_games,
-- sniikks_games, proposition et bracket_data via /api/protected-write.
--
-- ⚠️ AVANT d'exécuter ce fichier, dans le dashboard Supabase :
--   Authentication > Sign In / Providers > Email :
--     - "Confirm email" doit être ACTIVÉ (connexion bloquée tant que
--       le lien reçu par mail n'a pas été cliqué — géré nativement
--       par Supabase, pas contournable côté client).
--   Authentication > URL Configuration :
--     - Site URL = l'URL de prod du site (ex. https://phx-site-sniikks-369.vercel.app)
--     - Redirect URLs : ajoute la même URL (+ /index.html si besoin)
-- ==========================================================

-- Table des profils : 1 ligne par compte, créée automatiquement à l'inscription
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role text not null default 'member' check (role in ('member','curator')),
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "Profils lisibles par tous" on profiles;
create policy "Profils lisibles par tous"
  on profiles for select
  using (true);

drop policy if exists "Un compte crée son propre profil" on profiles;
create policy "Un compte crée son propre profil"
  on profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Un compte modifie son propre profil" on profiles;
create policy "Un compte modifie son propre profil"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Verrou important : même si la policy ci-dessus autorise la ligne,
-- seule la colonne "username" est modifiable par le compte connecté.
-- La colonne "role" ne peut donc jamais être changée en "curator"
-- par un utilisateur lui-même — uniquement depuis le dashboard
-- Supabase (Table Editor, avec la clé service_role).
revoke update on profiles from authenticated;
grant update (username) on profiles to authenticated;

-- Création automatique du profil quand un compte s'inscrit.
-- Le pseudo choisi à l'inscription est passé via
-- supabaseClient.auth.signUp({ options: { data: { username } } }),
-- récupéré ici dans raw_user_meta_data.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    'member'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ==========================================================
-- ÉTAPE MANUELLE — à faire une fois les 2 comptes créés
-- ==========================================================
-- 1. Sniikks et 369 s'inscrivent normalement sur le site (modal
--    "Inscription") et confirment leur email.
-- 2. Dans Supabase, SQL Editor, remplace 'pseudo_sniikks' et
--    'pseudo_369' par les pseudos exacts choisis, puis exécute :
--
--   update profiles set role = 'curator' where username = 'pseudo_sniikks';
--   update profiles set role = 'curator' where username = 'pseudo_369';
--
-- Tant que cette étape n'est pas faite, tout le monde est "member"
-- (peut lire, voter, jouer) mais personne ne peut modifier les
-- listes de jeux / propositions / bracket.

-- ==========================================================
-- write_attempts (ancien anti brute-force du code partagé) :
-- n'est plus utilisé, /api/protected-write vérifie maintenant une
-- vraie identité (JWT Supabase) au lieu d'un code. Tu peux supprimer
-- la table si tu veux faire le ménage (optionnel, sans risque) :
--   drop table if exists write_attempts;
