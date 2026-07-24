-- ==========================================================
-- MIGRATION v6 — Classement Pixels
-- À exécuter APRÈS les migrations v4/v5
-- SQL Editor > New query > coller > Run
-- ==========================================================
-- Une ligne par joueur (compte réel uniquement — les sessions anonymes
-- n'ont pas de pseudo et ne sont pas classées) : son meilleur score
-- (= la plus longue série obtenue avant de perdre toutes ses vies).
-- Écrit uniquement par le serveur (clé service_role, /api/pixels) —
-- aucune écriture directe possible depuis le navigateur.

create table if not exists pixels_leaderboard (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  best_score int not null,
  updated_at timestamptz default now()
);

alter table pixels_leaderboard enable row level security;

drop policy if exists "Classement Pixels lisible par tous" on pixels_leaderboard;
create policy "Classement Pixels lisible par tous"
  on pixels_leaderboard for select
  using (true);

-- Aucune policy insert/update/delete : seule la clé service_role (utilisée
-- par /api/pixels) peut écrire, ce qui bypass RLS de toute façon.
