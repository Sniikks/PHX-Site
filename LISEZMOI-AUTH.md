# Système de connexion — à faire côté Supabase

## 1. Dashboard Supabase
- Authentication > Sign In / Providers > Email : active **"Confirm email"**
  (si ce n'est pas déjà fait).
- Authentication > URL Configuration : mets l'URL de prod du site en
  **Site URL**, et ajoute-la aussi en **Redirect URLs**.

## 2. SQL
- SQL Editor > New query > coller le contenu de
  `supabase-migration-v4-auth.sql` > Run.

## 3. Déployer les fichiers
- Remplace/ajoute sur ton repo : `auth.js`, `auth-ui.js`,
  `protected-write.js`, `api/protected-write.js`, et les 9 pages HTML
  modifiées (elles chargent juste 2 lignes de script en plus après
  config.js).

## 4. Créer les 2 comptes curateurs
- Va sur le site, inscris Sniikks et 369 normalement (bouton
  "Connexion" en haut à droite > onglet Inscription), chacun confirme
  son email via le lien reçu.
- Dans Supabase SQL Editor, exécute (en remplaçant par les vrais
  pseudos choisis) :
  ```sql
  update profiles set role = 'curator' where username = 'PSEUDO_SNIIKKS';
  update profiles set role = 'curator' where username = 'PSEUDO_369';
  ```
- Tant que cette étape n'est pas faite, personne ne peut modifier les
  listes de jeux / propositions / bracket (tout le monde est "member").

## 5. Optionnel
- Tu peux supprimer la variable d'environnement Vercel
  `SITE_WRITE_CODE` (plus utilisée) et la table `write_attempts`
  (`drop table if exists write_attempts;`).
