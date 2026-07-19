// ==========================================================
// api/_knowngames.js — catalogue interne de secours pour l'autocomplétion
// ==========================================================
// Chaque jeu qui a un jour été la réponse d'un ZoomJeu ou d'un Pixels est
// enregistré ici (name + year), QUE le joueur l'ait trouvé ou non — ça n'a
// pas d'importance : ce qui compte, c'est que le jeu existe vraiment (ce
// sont NOS propres puzzles, choisis via IGDB/Steam à la génération).
//
// Pourquoi : IGDB/Steam peuvent parfois ne PAS faire remonter un jeu dans
// l'autocomplétion (ex. plusieurs Call of Duty récents fusionnés sous une
// seule fiche Steam, IGDB indisponible, filtre anti-DLC trop large...).
// Une fois qu'un jeu est passé ici, il redevient cherchable pour toujours,
// même si les APIs externes continuent de mal le référencer.
//
// Table verrouillée (RLS activé, aucune policy) : seule la clé service
// (utilisée par ces fonctions serverless) peut y lire/écrire — personne
// d'extérieur ne peut la consulter ni la modifier.
// ==========================================================

// name : nom EXACT du jeu (celui qui a servi de réponse) — pas la saisie du joueur.
// year : année de sortie si connue, sinon null.
export async function rememberKnownGame(supabase, name, year) {
    const cleanName = (name || '').trim();
    if (!cleanName) return;
    try {
        await supabase.from('known_games').upsert({
            id: cleanName.toLowerCase(),
            name: cleanName,
            year: Number.isFinite(year) ? year : null,
            updated_at: new Date().toISOString()
        });
    } catch (e) {
        // Best-effort : on ne fait jamais échouer la fin de partie pour ça.
        console.error('rememberKnownGame error:', e.message);
    }
}
