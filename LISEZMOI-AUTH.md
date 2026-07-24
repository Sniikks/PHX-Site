# Système de connexion + pages réservées — à faire côté Supabase

## 1. Dashboard Supabase
- Authentication > Sign In / Providers > Email : active **"Confirm email"**.
- Authentication > URL Configuration : Site URL + Redirect URLs = l'URL de prod du site.

## 2. SQL (dans l'ordre)
1. `supabase-migration-v4-auth.sql` (comptes + rôle curator)
2. `supabase-migration-v5-curator-pages.sql` (verrouille la LECTURE des 6 pages réservées)

## 3. Déployer les fichiers
Nouveaux : `auth.js`, `auth-ui.js`, `curator-gate.js`, `api/_curatorGuard.js`.
Modifiés : `protected-write.js`, `api/protected-write.js`, `api/guess.js`,
`api/motcache.js`, `api/motfrancais.js`, `bracket-jeux.html`, et les 9 pages
HTML (scripts en plus après config.js).

## 4. Créer les 2 comptes curateurs
- Inscris Sniikks et 369 sur le site (pastille "Connexion" en haut à droite),
  chacun confirme son email.
- ⚠️ IMPORTANT : tant que l'étape suivante n'est pas faite, PERSONNE — même
  Sniikks/369 connectés — ne peut voir les 6 pages réservées (la migration v5
  verrouille aussi la lecture). Fais-la tout de suite après inscription :
  ```sql
  update profiles set role = 'curator' where username = 'PSEUDO_SNIIKKS';
  update profiles set role = 'curator' where username = 'PSEUDO_369';
  ```

## 5. Pages concernées
Réservées à Sniikks/369 uniquement (lecture + écriture) :
Proposition de Jeux, Jeux de Sniikks, Jeux de 369, ZoomJeu, Jeu Caché, Mot Français.

Restent ouvertes à tous : Accueil, Bracket, Pixels.

## 6. Optionnel
- Supprime la variable Vercel `SITE_WRITE_CODE` (plus utilisée) et la table
  `write_attempts` (`drop table if exists write_attempts;`).
