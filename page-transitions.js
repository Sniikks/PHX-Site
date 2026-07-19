// ==========================================================
// page-transitions.js — Boutons de navigation directe (trios)
// ==========================================================
// Les animations de transition entre pages ont été retirées à la demande.
// Il ne reste que les boutons ‹ › fixés sur les bords des pages de chaque
// trio ci-dessous, qui forment chacun une boucle cyclique (chaque page a
// une voisine "à droite" et une "à gauche") — ce sont de simples liens,
// sans effet au clic. Une page ne peut appartenir qu'à un seul trio.
// ==========================================================

(function () {
  const GROUPS = [
    {
      pages: ['Sniikks_liste_de_jeux.html', '369_liste_de_jeux.html', 'proposition.html'],
      labels: {
        'Sniikks_liste_de_jeux.html': 'Sniikks',
        '369_liste_de_jeux.html': '369',
        'proposition.html': 'Proposition'
      }
    },
    {
      // Zoomjeu → (droite) Mot Caché → (droite) Mot Français → (droite) Zoomjeu
      pages: ['zoomjeu.html', 'mot-cache.html', 'mot-francais.html'],
      labels: {
        'zoomjeu.html': 'ZoomJeu',
        'mot-cache.html': 'Mot Caché',
        'mot-francais.html': 'Mot Français'
      }
    }
  ];

  function pageName(hrefOrPath) {
    try { return new URL(hrefOrPath, location.href).pathname.split('/').pop() || 'index.html'; }
    catch (e) { return ''; }
  }
  function currentPage() { return pageName(location.href); }
  function findGroup(name) { return GROUPS.find(g => g.pages.indexOf(name) !== -1) || null; }
  function trioNeighbor(group, name, dir) { // dir : 1 = à droite (suivant), -1 = à gauche (précédent)
    const i = group.pages.indexOf(name);
    if (i === -1) return null;
    return group.pages[(i + dir + group.pages.length) % group.pages.length];
  }

  function injectStyles() {
    const css = `
      .phx-trio-arrow {
        position:fixed; top:50%; transform:translateY(-50%);
        display:flex; align-items:center; justify-content:center;
        width:40px; height:40px; z-index:500;
        color:rgba(240,241,245,.65); text-decoration:none;
        background:rgba(13,14,20,.5);
        border:1px solid rgba(240,241,245,.18);
        border-radius:50%;
        font-family:'Rajdhani', sans-serif; font-size:1.25rem; line-height:1;
        transition:color .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease;
      }
      .phx-trio-arrow:hover {
        color:var(--gold, #00f0ff); border-color:var(--gold, #00f0ff);
        background:rgba(13,14,20,.8);
        box-shadow:0 0 14px color-mix(in srgb, var(--gold, #00f0ff) 40%, transparent);
      }
      .phx-trio-left { left:.6rem; }
      .phx-trio-right { right:.6rem; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildTrioArrows(group, here) {
    const prevName = trioNeighbor(group, here, -1);
    const nextName = trioNeighbor(group, here, 1);
    const mk = (name, side) => {
      const a = document.createElement('a');
      a.href = name;
      a.className = 'phx-trio-arrow phx-trio-' + side;
      a.setAttribute('aria-label', group.labels[name]);
      a.title = group.labels[name];
      a.textContent = side === 'left' ? '‹' : '›';
      document.body.appendChild(a);
    };
    if (prevName) mk(prevName, 'left');
    if (nextName) mk(nextName, 'right');
  }

  function init() {
    const here = currentPage();
    const group = findGroup(here);
    if (!group) return; // pas une page d'un trio : rien à faire
    injectStyles();
    buildTrioArrows(group, here);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
