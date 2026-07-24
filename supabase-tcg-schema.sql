-- ==========================================================
-- PHX — Page Pokémon TCG — schéma Supabase
-- ==========================================================
-- 3 tables, une par usage (suit la convention "une table dédiée
-- par fonctionnalité" déjà en place sur le reste du site) :
--   1. tcg_claims     -> suivi des créneaux de booster récupérés
--   2. tcg_inventory  -> nombre de boosters non ouverts en stock
--   3. tcg_collection -> cartes possédées par utilisateur
--
-- Policies : RLS activée sur les 3 tables. Chaque utilisateur ne
-- peut LIRE que ses propres lignes (auth.uid() = user_id) et n'a
-- AUCUN droit d'écriture direct depuis le client (insert/update/
-- delete refusés) — toute écriture passe uniquement par les
-- fonctions serveur (api/tcg-claim.js, api/tcg-open.js), qui
-- utilisent la clé service_role et contournent donc RLS.
-- Ça empêche un utilisateur de s'auto-attribuer des boosters ou
-- des cartes en modifiant les requêtes depuis la console du
-- navigateur.
-- ==========================================================

create table if not exists tcg_claims (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  slot_date    date not null,
  slot_time    text not null check (slot_time in ('00h00', '12h00')),
  claimed_at   timestamptz not null default now(),
  unique (user_id, slot_date, slot_time)
);

create table if not exists tcg_inventory (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  unopened_count  integer not null default 0 check (unopened_count >= 0),
  updated_at      timestamptz not null default now()
);

create table if not exists tcg_collection (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  card_id           text not null,          -- id pokemontcg.io, ex. "base1-4"
  card_name         text not null,
  set_id            text not null,
  set_name          text not null,
  rarity            text,
  image_small       text,
  image_large       text,
  quantity          integer not null default 1 check (quantity >= 1),
  first_obtained_at timestamptz not null default now(),
  unique (user_id, card_id)
);

create index if not exists idx_tcg_collection_user on tcg_collection(user_id);

-- ==========================================================
-- Row Level Security
-- ==========================================================

alter table tcg_claims enable row level security;
alter table tcg_inventory enable row level security;
alter table tcg_collection enable row level security;

-- Lecture : chacun ne voit que ses propres lignes
create policy "tcg_claims_select_own" on tcg_claims
  for select using (auth.uid() = user_id);

create policy "tcg_inventory_select_own" on tcg_inventory
  for select using (auth.uid() = user_id);

create policy "tcg_collection_select_own" on tcg_collection
  for select using (auth.uid() = user_id);

-- Aucune policy insert/update/delete n'est créée pour le rôle
-- "authenticated" : par défaut, en présence de RLS, toute
-- opération sans policy correspondante est refusée. Les fonctions
-- serveur (api/tcg-claim.js, api/tcg-open.js) utilisent la clé
-- SUPABASE_SERVICE_ROLE_KEY, qui contourne RLS entièrement — c'est
-- donc le SEUL chemin d'écriture possible sur ces 3 tables.
