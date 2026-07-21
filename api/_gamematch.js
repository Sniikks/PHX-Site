// ==========================================================
// /api/_gamematch.js — Bibliothèque partagée (non exposée en HTTP,
// le préfixe "_" empêche Vercel d'en faire une route).
//
// Contient toute la logique de comparaison des réponses du ZoomJeu,
// AUPARAVANT dans zoomjeu.html côté client. Elle a été déplacée ici
// car la réponse du jour n'est plus jamais envoyée au navigateur :
// c'est /api/guess.js qui vérifie les essais côté serveur.
// (Logique identique au bot Discord "369".)
// ==========================================================

export function normalize(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Suffixe d'édition/version commerciale ajouté par Steam ou IGDB (ex. "Grand
// Theft Auto V: Premium Edition") : ça ne désigne PAS un jeu différent, juste
// un SKU/une édition — contrairement au sous-titre d'un épisode numéroté
// (ex. "Half-Life: Alyx"), qui lui identifie un jeu précis. Sans ce filet, la
// bonne réponse tapée telle quelle ("Grand Theft Auto V") n'était jamais
// validée : juste comptée "proche" 🔥, alors que c'est le bon jeu.
const EDITION_SUFFIX_RE = /[:\-–]?\s*(the\s+)?(complete|definitive|enhanced|remaster(?:ed)?|redux|legacy|goty|game of the year|premium(?:\s+online)?|deluxe|ultimate|gold|special|anniversary|standard|extended|director'?s?\s*cut)\s*(edition)?\s*$/i;

function stripEditionSuffix(name) {
    let prev, current = name.trim();
    do {
        prev = current;
        current = current.replace(EDITION_SUFFIX_RE, '').trim();
    } while (current !== prev && current.length > 0);
    return current;
}

export function getVariants(name) {
    const cleanName = name.replace(/\s*\(\d{4}\)\s*$/, '');
    const base = normalize(cleanName);
    // Seul le SOUS-TITRE (après le dernier ":" ou "-") est repris comme réponse
    // valide à lui seul, ex. "Alyx" pour "Half-Life: Alyx" — il identifie
    // l'épisode précis. Le préfixe avant (le nom de la licence, ex. "Call of
    // Duty", "Civilization") est ambigu à lui seul sur plusieurs épisodes et
    // NE DOIT PAS suffire à gagner (c'était la cause du bug où deviner juste
    // le nom de la licence validait n'importe quel épisode).
    const variants = [base];
    const withoutEdition = normalize(stripEditionSuffix(cleanName));
    if (withoutEdition && withoutEdition !== base) variants.push(withoutEdition);
    const parts = cleanName.split(/[:\-]/);
    if (parts.length > 1) {
        const subtitle = normalize(parts[parts.length - 1]);
        if (subtitle.length >= 3) variants.push(subtitle);
    }
    return [...new Set(variants)];
}

export function tokensMatch(a, b) {
    if (a === b) return true;
    if (/\d/.test(a) || /\d/.test(b)) return false;
    if (a.length <= 3 || b.length <= 3) return false;
    const maxLen = Math.max(a.length, b.length);
    // Un mot court (4 lettres) où une seule lettre change peut être un tout
    // autre jeu (ex. "Raft" vs "Rift") : pas de tolérance dans ce cas, il faut
    // une correspondance exacte. La tolérance ne s'applique qu'à partir de 5
    // lettres, où une faute de frappe pèse proportionnellement moins.
    const threshold = maxLen <= 4 ? 0 : maxLen <= 7 ? 1 : 2;
    return levenshtein(a, b) <= threshold;
}

// Un article en tête ("the", "a", "an") est souvent omis par les joueurs sans
// que ça change le jeu visé ("Legend of Zelda" pour "The Legend of Zelda") :
// on l'ignore uniquement en tête de liste, pas ailleurs dans le titre.
const LEADING_ARTICLES = new Set(['the', 'a', 'an']);
function stripLeadingArticle(tokens) {
    return tokens.length > 1 && LEADING_ARTICLES.has(tokens[0]) ? tokens.slice(1) : tokens;
}

// Comparaison stricte : le nombre de mots doit correspondre (à l'article près),
// chaque mot est comparé un à un avec tolérance de faute de frappe.
// AVANT (tokenWindowMatch) : une simple sous-séquence contiguë suffisait, donc
// deviner juste "Civilization" ou "Call of Duty" validait N'IMPORTE QUEL épisode
// de la licence — c'est ce qui causait le bug "Civilization V" accepté pour
// "Civilization VI" (et plus généralement, tout titre incomplet accepté comme
// bonne réponse). Un essai qui ne cite pas le numéro/sous-titre ne doit plus
// suffire à gagner : il doit rester "proche" (voir isCloseGuess) mais pas correct.
export function tokensFullMatch(guessTokens, targetTokens) {
    const g = stripLeadingArticle(guessTokens);
    const t = stripLeadingArticle(targetTokens);
    if (g.length !== t.length) return false;
    for (let i = 0; i < g.length; i++) {
        if (!tokensMatch(g[i], t[i])) return false;
    }
    return true;
}

export function isCorrectGuess(guessRaw, gameName) {
    const guess = normalize(guessRaw);
    if (guess.length < 2) return false;
    const guessTokens = guess.split(' ').filter(Boolean);
    for (const variant of getVariants(gameName)) {
        if (guess === variant) return true;
        const variantTokens = variant.split(' ').filter(Boolean);
        if (tokensFullMatch(guessTokens, variantTokens)) return true;
    }
    return false;
}

// Détecte une réponse "proche" : bonne licence/franchise, mais pas le bon
// épisode/édition (ex: "Counter-Strike 2" pour "Counter-Strike: Source").
const STOP_WORDS = new Set(['the', 'of', 'a', 'an', 'and', 'edition', 'goty', 'remastered', 'definitive']);

function significantTokens(tokens) {
    return tokens.filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

export function isCloseGuess(guessRaw, gameName) {
    const cleanName = gameName.replace(/\s*\(\d{4}\)\s*$/, '');
    const guessAllTokens = normalize(guessRaw).split(' ').filter(Boolean);
    const baseAllTokens = normalize(cleanName).split(' ').filter(Boolean);
    const guessTokens = significantTokens(guessAllTokens);
    const baseTokens = significantTokens(baseAllTokens);
    if (guessTokens.length === 0 || baseTokens.length === 0) return false;

    let matches = 0;
    guessTokens.forEach(gt => { if (baseTokens.some(bt => tokensMatch(gt, bt))) matches++; });

    // Un numéro d'épisode identique (ex. "Persona 3" pour "Persona 3
    // Portable") est un signal fort de proximité — mais les tokens numériques
    // sont exclus de significantTokens (ce ne sont pas des "mots" comparables
    // par faute de frappe), donc ce match ne comptait jamais. Sans ce bonus,
    // deviner la bonne franchise ET le bon numéro, sans le mot d'édition qui
    // suit ("Portable", "Reload"...), ne comptait jamais comme "proche" — juste
    // "faux" 🔥, ce qui perdait le joueur qui avait pourtant identifié le bon
    // jeu. Le bonus n'est appliqué que s'il y a déjà au moins un mot en commun
    // (matches > 0), pour ne pas rapprocher deux jeux sans rapport qui
    // partagent juste un numéro (ex. "Diablo 2" ne doit pas devenir "proche"
    // de "Fallout 2").
    const guessNumbers = new Set(guessAllTokens.filter(t => /^\d+$/.test(t)));
    const baseNumbers = new Set(baseAllTokens.filter(t => /^\d+$/.test(t)));
    let numberBonus = 0;
    guessNumbers.forEach(n => { if (baseNumbers.has(n)) numberBonus++; });
    const totalMatches = matches + (matches > 0 ? numberBonus : 0);

    const threshold = Math.min(2, baseTokens.length);
    return totalMatches >= threshold;
}

// Repère si la réponse commence par le(s) même(s) mot(s) que le vrai jeu.
// Renvoie { text, wordCount } ou null. (Voir zoomjeu.html pour l'historique
// des subtilités : sous-tokens normalisés, garde-fou anti-révélation totale.)
export function nameHint(guessRaw, answer) {
    const cleanAnswer = answer.replace(/\s*\(\d{4}\)\s*$/, '');
    const gTokens = normalize(guessRaw).split(' ').filter(Boolean);

    const origTokens = cleanAnswer.split(/[\s:\-]+/).filter(Boolean);
    const subCounts = [];
    const aTokensNorm = [];
    origTokens.forEach(t => {
        const subs = normalize(t).split(' ').filter(Boolean);
        subCounts.push(subs.length);
        aTokensNorm.push(...subs);
    });

    let matchLen = 0;
    while (matchLen < gTokens.length && matchLen < aTokensNorm.length && tokensMatch(gTokens[matchLen], aTokensNorm[matchLen])) {
        matchLen++;
    }

    let covered = 0, acc = 0;
    for (const c of subCounts) {
        if (acc + c <= matchLen) { acc += c; covered++; } else break;
    }
    if (covered >= origTokens.length) covered = origTokens.length - 1;
    if (covered <= 0) return null;
    return { text: origTokens.slice(0, covered).join(' '), wordCount: covered };
}

export function extractYear(releasedStr) {
    if (!releasedStr) return null;
    const m = String(releasedStr).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
}
