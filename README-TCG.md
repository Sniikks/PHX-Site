# Page TCG — intégration dans PHX

## Fichiers fournis
- `tcg.html`, `tcg.css`, `tcg.js` — la page
- `api/tcg-claim.js` — récupération du booster du créneau en cours
- `api/tcg-open.js` — ouverture d'un booster (tirage pondéré)
- `api/tcg-status.js` — statut (inventaire + créneau) pour le front
- `api/tcg-sets.js` — liste des sets Pokémon (filtre collection)
- `api/tcg-collection.js` — cartes d'un set + possédées/manquantes
- `api/_tcg-rarity.js` — classification des raretés + tirage (pas une route, utilisé par tcg-open.js)
- `supabase-tcg-schema.sql` — les 3 nouvelles tables + policies RLS

## À faire côté toi

**1. Copier les fichiers** dans les mêmes dossiers que le reste du site (les `api/tcg-*.js` dans ton dossier `api/` existant, le reste à la racine).

**2. Exécuter `supabase-tcg-schema.sql`** dans l'éditeur SQL Supabase (crée les 3 tables + policies, ne touche à rien d'existant).

**3. Variables d'environnement Vercel** (Project Settings → Environment Variables) :
- `SUPABASE_URL` — l'URL de ton projet Supabase (si pas déjà présente sous ce nom exact, vérifie le nom utilisé par tes autres fonctions `api/` et adapte les 4 fichiers `tcg-*.js` en conséquence)
- `SUPABASE_SERVICE_ROLE_KEY` — la clé **service_role** (PAS la clé anon) — Project Settings → API → `service_role` sur Supabase. Cette clé est secrète, ne jamais la mettre dans un fichier front ni sur GitHub.
- `POKEMON_TCG_API_KEY` — ta clé pokemontcg.io

**4. Authentification réelle requise.** Les 4 routes API vérifient un vrai utilisateur connecté via Supabase Auth (`supabaseAdmin.auth.getUser(token)`), pas l'auth anonyme du dépôt GitHub de référence. Le front (`tcg.js`) récupère le token via `supabaseClient.auth.getSession()` — si ton système de login stocke/expose la session autrement, adapte la fonction `authHeader()` en haut de `tcg.js`.

**5. Ajouter le lien vers `tcg.html`** dans ta navigation (`nav.js` / menu pilule), comme pour tes autres pages.

**6. Vérifier `package.json`** : `@supabase/supabase-js` est déjà une dépendance du site, rien à ajouter normalement.

## Notes sur le tirage des raretés
Voir les commentaires dans `api/_tcg-rarity.js`. Pondération actuelle :
- 5 cartes de base : 70% Commune / 30% Peu commune
- 1 carte "slot rare" : 55% Rare / 25% Rare Holo / 13% Ultra-Double Rare / 7% Rare Secrète/Spéciale

Facile à retoucher : ce sont juste les objets `BASE_TIERS` / `RARE_SLOT_TIERS` en haut du fichier.

## Note copyright
Les images de cartes viennent exclusivement de l'API officielle pokemontcg.io (faite pour cet usage par des devs tiers) — aucun asset Pokémon n'est stocké en dur dans le code. Le visuel autour (UI, cartes de fond, animations) est fait maison.
