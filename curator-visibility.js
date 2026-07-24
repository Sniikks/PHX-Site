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

  function applyVisibility(isCurator) {
    document.querySelectorAll('a[href]').forEach(a => {
      if (RESTRICTED_PAGES.includes(a.getAttribute('href'))) {
        a.style.display = isCurator ? '' : 'none';
      }
    });
  }

  PHXAuth.onChange(({ profile }) => {
    applyVisibility(!!profile && profile.role === 'curator');
  });
})();
