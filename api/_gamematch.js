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

export function getVariants(name) {
    const cleanName = name.replace(/\s*\(\d{4}\)\s*$/, '');
    const base = normalize(cleanName);
    const parts = cleanName.split(/[:\-]/).map(p => normalize(p)).filter(p => p.length >= 3);
    return [...new Set([base, ...parts])];
}

export function tokensMatch(a, b) {
    if (a === b) return true;
    if (/\d/.test(a) || /\d/.test(b)) return false;
    if (a.length <= 3 || b.length <= 3) return false;
    const maxLen = Math.max(a.length, b.length);
    const threshold = maxLen <= 6 ? 1 : 2;
    return levenshtein(a, b) <= threshold;
}

export function tokenWindowMatch(guessTokens, targetTokens) {
    const gLen = guessTokens.length;
    if (gLen === 0 || gLen > targetTokens.length) return false;
    for (let start = 0; start + gLen <= targetTokens.length; start++) {
        let ok = true;
        for (let k = 0; k < gLen; k++) {
            if (!tokensMatch(guessTokens[k], targetTokens[start + k])) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

export function isCorrectGuess(guessRaw, gameName) {
    const guess = normalize(guessRaw);
    if (guess.length < 2) return false;
    const guessTokens = guess.split(' ').filter(Boolean);
    for (const variant of getVariants(gameName)) {
        if (guess === variant) return true;
        const variantTokens = variant.split(' ').filter(Boolean);
        if (tokenWindowMatch(guessTokens, variantTokens)) return true;
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
    const guessTokens = significantTokens(normalize(guessRaw).split(' ').filter(Boolean));
    const baseTokens = significantTokens(normalize(cleanName).split(' ').filter(Boolean));
    if (guessTokens.length === 0 || baseTokens.length === 0) return false;

    let matches = 0;
    guessTokens.forEach(gt => { if (baseTokens.some(bt => tokensMatch(gt, bt))) matches++; });

    const threshold = Math.min(2, baseTokens.length);
    return matches >= threshold;
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
