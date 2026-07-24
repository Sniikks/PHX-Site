// ==========================================================
// curator-visibility.js — Cache les liens vers les pages réservées
// aux curateurs (menu ☰ + tuiles de l'accueil) pour tout visiteur qui
// n'est pas Sniikks/369. Purement cosmétique : la vraie protection
// (lecture ET écriture) est déjà assurée par les policies RLS et
// curator-gate.js sur les pages elles-mêmes — ce script évite juste
// d'afficher des liens vers des pages inaccessibles.
//
// Fonctionne sur toutes les pages sans dépendre de nav.js : cible
// n'importe quel <a href="..."> pointant vers une des 6 pages,
// que ce soit une tuile d'accueil ou une entrée du menu ☰.
//
// Charger APRÈS auth.js.
// ==========================================================

(function () {
  const RESTRICTED_PAGES = [
    'proposition.html',
    'Sniikks_liste_de_jeux.html',
    '369_liste_de_jeux.html',
    'zoomjeu.html',
    'mot-cache.html',
    'mot-francais.html'
  ];

  let curatorState = false; // état courant, mis à jour par PHXAuth.onChange

  function hideIfRestricted(a) {
    if (a.tagName === 'A' && RESTRICTED_PAGES.includes(a.getAttribute('href'))) {
      a.style.display = curatorState ? '' : 'none';
    }
  }

  function applyVisibility(isCurator) {
    curatorState = isCurator;
    document.querySelectorAll('a[href]').forEach(hideIfRestricted);
  }

  // Caché par défaut dès l'exécution du script (pas d'attente réseau) :
  // évite le flash où tout était visible le temps que la session Supabase
  // soit vérifiée.
  applyVisibility(false);

  // nav.js construit son panneau de menu APRÈS ce script (il est injecté
  // dynamiquement, souvent plus bas dans la page). Un observateur permet
  // de cacher ses liens dès leur apparition, quel que soit l'ordre de
  // chargement des scripts — sans lui, le menu ☰ afficherait brièvement
  // (ou durablement, selon l'ordre) tous les onglets avant correction.
  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        hideIfRestricted(node);
        node.querySelectorAll && node.querySelectorAll('a[href]').forEach(hideIfRestricted);
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  PHXAuth.onChange(({ profile }) => {
    applyVisibility(!!profile && profile.role === 'curator');
  });
})();
