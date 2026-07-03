# Backlog Jeux — déploiement Vercel + Supabase

## Contenu du dossier

- `index.html` — page de **menu** (point d'entrée du site)
- `jeux-realises.html` — ta liste de jeux réalisés
- `bracket-jeux.html` — l'outil de bracket
- `config.js` — clés Supabase (à remplir, voir étape 2)
- `db.js` — petit module qui lit/écrit le JSON dans Supabase
- `supabase-schema.sql` — script SQL à exécuter dans Supabase
- `listejeuxrealises.json` / `bracket_games.json` — tes fichiers actuels, à importer une fois le site en ligne (voir étape 4)

Les 2 futures pages n'ont qu'à être ajoutées dans ce dossier + un lien dans `index.html`.

---

## 1. Créer le projet Supabase

1. Va sur https://supabase.com → crée un compte / un projet (choisis une région proche de toi, ex. Europe).
2. Une fois le projet créé, va dans **SQL Editor** → **New query**.
3. Colle le contenu de `supabase-schema.sql` et clique **Run**.
   Ça crée la table `app_data` qui stockera tous tes fichiers JSON (une ligne par "fichier").

## 2. Récupérer les clés et configurer `config.js`

1. Dans Supabase : **Project Settings** (icône ⚙️) → **API**.
2. Copie :
   - **Project URL**
   - **anon public** key
3. Ouvre `config.js` et remplace :
   ```js
   const SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
   const SUPABASE_ANON_KEY = "VOTRE_CLE_ANON_PUBLIC";
   ```

⚠️ La clé "anon" est destinée à être publique (elle finira dans le code JS envoyé au navigateur), c'est normal. Les policies SQL du script contrôlent qui peut lire/écrire — ici elles sont ouvertes (pas de compte utilisateur), donc ne mets rien de confidentiel dans cette base.

## 3. Déployer sur Vercel

**Option A — le plus simple (sans Git) :**
1. Va sur https://vercel.com → connecte-toi.
2. "Add New…" → "Project" → onglet **Deploy without Git** / glisse-dépose tout le dossier (ou passe par la CLI ci-dessous).

**Option B — via GitHub (recommandé pour pouvoir mettre à jour facilement) :**
1. Crée un dépôt GitHub, mets-y tous ces fichiers.
2. Sur https://vercel.com → "Add New…" → "Project" → importe le dépôt.
3. Vercel détecte un site statique automatiquement (aucune configuration de build nécessaire) → **Deploy**.

**Option C — CLI :**
```bash
npm i -g vercel
cd dossier-du-site
vercel
```

Une fois déployé, Vercel te donne une URL du type `https://ton-projet.vercel.app`.

## 4. Importer tes données existantes

Au tout premier chargement, `jeux-realises.html` affichera un jeu de données par défaut (intégré dans le fichier) tant que la base Supabase est vide. Pour mettre **tes vraies données** :

1. Ouvre `https://ton-projet.vercel.app/jeux-realises.html`
2. Clique **Importer** → sélectionne `listejeuxrealises.json`
3. Confirme le remplacement → c'est automatiquement sauvegardé dans Supabase.

Pour le bracket :
1. Ouvre `https://ton-projet.vercel.app/bracket-jeux.html`
2. Glisse-dépose ou sélectionne `bracket_games.json` dans la zone d'import
3. Il sera automatiquement ajouté à tes "sauvegardes" (synchronisées avec Supabase) pour être réutilisé plus tard sans le ré-importer.

## 5. Vérifier que ça fonctionne

- En haut de chaque page, un petit indicateur affiche **● Connecté** (vert) si Supabase répond, ou **● Hors-ligne** (rouge) sinon.
- Si tu vois "Hors-ligne", vérifie `config.js` (URL/clé) et que le script SQL a bien été exécuté.
- Tu peux vérifier les données directement dans Supabase : **Table Editor** → `app_data`.

## Ajouter les 2 futures pages

Pour chaque nouvelle page :
1. Ajoute les 3 lignes suivantes dans son `<head>` :
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="config.js"></script>
   <script src="db.js"></script>
   ```
2. Utilise `RemoteStore.get(cle, valeurParDefaut)` pour lire et `RemoteStore.set(cle, valeur)` pour écrire (choisis une clé unique par page, ex. `'ma_nouvelle_page'`).
3. Ajoute une tuile dans `index.html` (copie un bloc `<a class="tile" href="...">`).

---

## Pages ajoutées

### `369_liste_de_jeux.html`
Branchée sur le même système que les 2 premières pages (`config.js` / `db.js` / table `app_data`, clé `backlog_cards_v1`). Rien à faire de plus : elle utilise ta base Supabase du projet.

### `proposition.html`
⚠️ Cette page est différente : elle contient **son propre projet Supabase** codé en dur dans le fichier (`SUPA_URL` / `SUPA_KEY` en haut du `<script>`), avec ses propres tables `jeux_a_faire` et `proposition`, et une synchronisation **temps réel** (WebSocket) entre plusieurs visiteurs. Elle ne passe pas par `config.js`/`db.js` et n'a pas besoin d'y être connectée — elle fonctionne de façon autonome avec son propre projet Supabase (probablement déjà créé et configuré au préalable). Si un jour tu veux tout unifier sous un seul projet Supabase, il faudrait migrer ses tables (`jeux_a_faire`, `proposition`) et le realtime vers ton projet principal — dis-le moi si tu veux que je le fasse.
