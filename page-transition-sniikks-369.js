// ==========================================================
// page-transition-sniikks-369.js — Effet de glissement UNIQUEMENT entre
// Sniikks_liste_de_jeux.html et 369_liste_de_jeux.html.
//
// Principe : ce sont deux pages DIFFÉRENTES (pas une single-page app),
// donc l'animation se fait en 2 temps qui ne partagent que sessionStorage
// pour se transmettre la direction :
//   1. Sur la page qu'on QUITTE : on intercepte le clic sur le lien vers
//      l'autre page, on joue une animation de sortie (glisse hors écran),
//      on note la direction dans sessionStorage, PUIS on navigue.
//   2. Sur la page qui S'AFFICHE : on lit cette direction au chargement,
//      on joue l'animation d'entrée correspondante, puis on efface le flag
//      (sinon un rechargement/retour arrière rejouerait l'animation à tort).
//
// Sens demandé : Sniikks → 369 = glisse vers la DROITE (le contenu sort par
// la gauche, le suivant entre par la droite) ; 369 → Sniikks = vers la
// GAUCHE (sens inverse). Si JS/sessionStorage est indisponible, la
// navigation reste un simple lien classique, sans animation — jamais bloquant.
// ==========================================================

(function () {
  const PAGE_A = 'Sniikks_liste_de_jeux.html';
  const PAGE_B = '369_liste_de_jeux.html';
  const FLAG_KEY = 'phxPageTransitionEnter';
  const EXIT_MS = 220;   // doit correspondre à la durée CSS ci-dessous
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function injectStyles() {
    const css = `
      @keyframes phxEnterFromRight { from { transform:translateX(36px); opacity:0; } to { transform:translateX(0); opacity:1; } }
      @keyframes phxEnterFromLeft  { from { transform:translateX(-36px); opacity:0; } to { transform:translateX(0); opacity:1; } }
      @keyframes phxExitToLeft     { to { transform:translateX(-36px); opacity:0; } }
      @keyframes phxExitToRight    { to { transform:translateX(36px); opacity:0; } }
      body.phx-enter-right { animation: phxEnterFromRight .32s ease both; }
      body.phx-enter-left  { animation: phxEnterFromLeft .32s ease both; }
      body.phx-exit-left   { animation: phxExitToLeft ${EXIT_MS}ms ease both; }
      body.phx-exit-right  { animation: phxExitToRight ${EXIT_MS}ms ease both; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function pageName(hrefOrPath) {
    try { return new URL(hrefOrPath, location.href).pathname.split('/').pop(); }
    catch (e) { return ''; }
  }

  function currentPage() { return pageName(location.href); }

  function playEntranceIfNeeded() {
    if (reduceMotion) return;
    let dir;
    try { dir = sessionStorage.getItem(FLAG_KEY); } catch (e) { return; }
    if (!dir) return;
    try { sessionStorage.removeItem(FLAG_KEY); } catch (e) {}
    document.body.classList.add(dir === 'right' ? 'phx-enter-right' : 'phx-enter-left');
  }

  function interceptSiblingLinks() {
    const here = currentPage();
    const sibling = here === PAGE_A ? PAGE_B : (here === PAGE_B ? PAGE_A : null);
    if (!sibling) return; // page tierce : rien à faire

    // Sniikks → 369 : sort par la gauche, entre par la droite.
    // 369 → Sniikks : sort par la droite, entre par la gauche.
    const exitClass = here === PAGE_A ? 'phx-exit-left' : 'phx-exit-right';
    const enterDir = here === PAGE_A ? 'right' : 'left';

    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      if (pageName(a.getAttribute('href')) !== sibling) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // laisse "ouvrir dans un nouvel onglet" etc. intacts

      e.preventDefault();
      const target = a.href;
      if (reduceMotion) { location.href = target; return; }

      try { sessionStorage.setItem(FLAG_KEY, enterDir); } catch (err) {}
      document.body.classList.add(exitClass);
      setTimeout(() => { location.href = target; }, EXIT_MS);
    });
  }

  function init() {
    injectStyles();
    playEntranceIfNeeded();
    interceptSiblingLinks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
