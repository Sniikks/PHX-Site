// ==========================================================
// bg-animate.js — Anime le fond cyberpunk existant (grille + particules)
// ==========================================================
// Reprend le fond déjà en place sur tout le site (grille + scanlines,
// cyber-theme.css) et l'anime :
//   - Parallaxe léger de la grille au mouvement de souris (desktop) et au
//     scroll (tous appareils), via les variables CSS --phx-px/--phx-py
//     posées sur <html> (voir cyber-theme.css pour le rendu).
//   - Particules ("data motes") qui dérivent lentement en fond, purement
//     décoratives (pointer-events:none, jamais au-dessus du contenu).
//
// Rien ici ne capte de clic ni ne bloque une interaction : c'est un pur
// habillage visuel. Désactivé si "réduire les animations" est activé.
// ==========================================================

(function () {
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduceMotion) return;

  const root = document.documentElement;
  const isCoarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const PARALLAX_RANGE = 14; // px max de déplacement de la grille

  // ── Parallaxe souris (desktop/tablette avec pointeur fin uniquement —
  // sur tactile, le mouvement du doigt ne doit pas faire "sauter" la grille) ──
  let mouseTicking = false;
  function onMouseMove(e) {
    if (mouseTicking) return;
    mouseTicking = true;
    requestAnimationFrame(() => {
      const nx = (e.clientX / window.innerWidth) - 0.5;  // -0.5 .. 0.5
      const ny = (e.clientY / window.innerHeight) - 0.5;
      root.style.setProperty('--phx-px', (nx * PARALLAX_RANGE).toFixed(1) + 'px');
      root.style.setProperty('--phx-py', (ny * PARALLAX_RANGE + scrollOffset()).toFixed(1) + 'px');
      mouseTicking = false;
    });
  }

  // ── Parallaxe scroll (tous appareils) : léger décalage vertical amorti,
  // plafonné pour ne jamais faire dériver la grille trop loin sur une page
  // longue (sinon elle finirait hors du cadre masqué). ──
  function scrollOffset() {
    const y = window.scrollY || window.pageYOffset || 0;
    return Math.max(-10, Math.min(10, y / 40));
  }
  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      root.style.setProperty('--phx-py', scrollOffset().toFixed(1) + 'px');
      scrollTicking = false;
    });
  }

  if (!isCoarsePointer) window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── Particules en dérive ──
  function buildParticles() {
    const wrap = document.createElement('div');
    wrap.id = 'phx-bg-particles';
    const count = isCoarsePointer || window.innerWidth < 640 ? 16 : 30;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'phx-particle';
      const size = 1.5 + Math.random() * 2.5;
      const dx = (Math.random() * 160 - 80).toFixed(0) + 'px';
      const dy = -(260 + Math.random() * 300).toFixed(0) + 'px';
      const duration = 16 + Math.random() * 22;
      const delay = -Math.random() * duration; // négatif : déjà "en vol" au chargement
      p.style.left = (Math.random() * 100) + '%';
      p.style.top = (Math.random() * 100) + '%';
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.setProperty('--dx', dx);
      p.style.setProperty('--dy', dy);
      p.style.animationDuration = duration.toFixed(1) + 's';
      p.style.animationDelay = delay.toFixed(1) + 's';
      wrap.appendChild(p);
    }
    document.documentElement.appendChild(wrap);
  }

  function init() {
    buildParticles();
    // Position initiale de la grille (avant tout mouvement de souris)
    root.style.setProperty('--phx-py', scrollOffset().toFixed(1) + 'px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
