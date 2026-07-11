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
--   'motcache_YYYY-MM-DD'        -> puzzle public du jour (longueur, essais,
--                                    ET session partagée : essais/solved/failed) — mot-cache.html
--   'motcache_secret_YYYY-MM-DD' -> mot secret du jour (jamais lu par le navigateur) — /api/motcache-guess.js
--   'motcache_used'               -> mots déjà tombés (pour ne jamais répéter)
--   'pixels_game'                 -> partie partagée en cours (image/vies/série/historique) — pixels.html
--   'pixels_game_secret'          -> nom du jeu de la manche en cours (jamais lu par le navigateur)
--   'pixels_game_image'           -> jaquette (base64) de la manche en cours, à part pour alléger le temps réel
--   'plusoumoins_game'            -> partie partagée en cours (duel/série) — plus-ou-moins.html
--   'plusoumoins_game_secret'     -> valeurs cachées du duel en cours (jamais lues par le navigateur)
--   (tes futures pages pourront simplement utiliser de nouvelles clés)

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

-- ==========================================================
-- MIGRATION REALTIME (proposition.html) — à exécuter UNE FOIS
-- Active les notifications temps réel sur les tables de la page
-- "Proposition de Jeux". Sans ça, le point vert s'affiche mais les
-- modifications de l'autre n'apparaissent pas en direct.
-- (Le bloc gère le cas où une table est déjà dans la publication.)
-- ==========================================================
do $$
begin
  begin
    alter publication supabase_realtime add table jeux_a_faire;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table proposition;
  exception when duplicate_object then null;
  end;
end $$;

-- ==========================================================
-- MIGRATION SÉCURITÉ — écriture réservée aux sessions connectées
-- (même anonymement) sur app_data
-- ==========================================================
-- AVANT d'exécuter ce bloc :
--   1. Dans le dashboard Supabase : Authentication > Sign In / Providers
--      > active "Allow anonymous sign-ins".
--   2. Déploie d'abord la version du site qui appelle
--      supabaseClient.auth.signInAnonymously() (voir config.js) et
--      vérifie que le site fonctionne toujours normalement (le point
--      "● Connecté" doit s'afficher).
--   3. Seulement APRÈS, exécute le bloc ci-dessous.
-- Sinon, les écritures (scores, parties en cours...) cesseront de
-- fonctionner tant que le site ne sait pas s'authentifier.
--
-- Avant : n'importe qui connaissant l'URL + la clé anon pouvait
-- écrire n'importe quoi dans app_data depuis la console du navigateur.
-- Après : il faut au minimum une session (même anonyme) pour écrire.
-- La lecture reste publique (les jeux restent jouables sans "compte").

drop policy if exists "Public write access" on app_data;
drop policy if exists "Public update access" on app_data;

create policy "Authenticated write access"
  on app_data for insert
  with check (auth.role() = 'authenticated');

create policy "Authenticated update access"
  on app_data for update
  using (auth.role() = 'authenticated');

-- La politique de lecture ("Public read access") ne change pas :
-- tout le monde peut toujours lire les scores/parties en cours.

-- ==========================================================
-- NOTE — tables jeux_a_faire / proposition (page "Proposition de Jeux")
-- ==========================================================
-- Ces deux tables ne sont pas définies dans ce fichier (créées à part)
-- et proposition.html les modifie en appels REST directs, y compris
-- des DELETE. Elles n'ont pas été auditées/durcies ici — si tu veux
-- qu'on fasse la même chose pour elles, dis-le et on regarde leurs
-- policies actuelles avant de les resserrer.
