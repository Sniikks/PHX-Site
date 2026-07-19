// ==========================================================
// page-transitions.js — Transitions entre pages, tout le site
// ==========================================================
// Le site est multi-pages (pas une single-page app) : chaque "transition"
// se joue donc en 2 temps qui ne partagent que sessionStorage pour se
// transmettre quoi jouer :
//   1. Sur la page qu'on QUITTE : on intercepte le clic sur un lien
//      interne, on joue l'animation de "sortie" (l'overlay recouvre
//      l'écran), on note dans sessionStorage ce qu'il faudra rejouer,
//      PUIS on navigue.
//   2. Sur la page qui S'AFFICHE : on lit l'info au chargement, on pose
//      l'overlay déjà en position "couverte" SANS transition (pour éviter
//      un flash du contenu avant l'effet), puis on le fait disparaître en
//      révélant la page.
//
// Deux effets, selon les 2 pages concernées :
//   - "Rideau" cyberpunk (glissement directionnel) : UNIQUEMENT entre les
//     3 pages du trio Sniikks / 369 / Proposition, qui forment une boucle
//     (chacune a une voisine "à droite" et une "à gauche") — ces 3 pages
//     ont aussi des flèches de navigation directe fixées sur les bords.
//   - "Dissolution pixels" cyberpunk : toutes les autres navigations
//     internes (dont celles qui entrent/sortent du trio depuis une page
//     hors-trio, ex. Accueil → Sniikks).
//
// Si JS/sessionStorage est indisponible, ou si la personne a activé
// "réduire les animations", les liens restent de simples liens, sans
// aucun effet — jamais bloquant.
// ==========================================================

(function () {
  // Ordre CYCLIQUE du trio : "à droite" = l'élément suivant, "à gauche" =
  // le précédent (avec retour au début/à la fin). Validé avec Sniikks :
  // droite→369, gauche→Proposition ; 369 : droite→Proposition, gauche→
  // Sniikks ; Proposition : droite→Sniikks, gauche→369.
  const TRIO = ['Sniikks_liste_de_jeux.html', '369_liste_de_jeux.html', 'proposition.html'];
  const TRIO_LABELS = {
    'Sniikks_liste_de_jeux.html': 'Sniikks',
    '369_liste_de_jeux.html': '369',
    'proposition.html': 'Proposition'
  };

  const FLAG_KEY = 'phxPageTransition';
  // Rideau (trio) : ralenti + bordure lumineuse ajoutée (voir CSS) pour que
  // le sens du glissement se voie clairement, au lieu d'un aller-retour
  // trop rapide pour être perçu comme un "slide".
  const CURTAIN_MS = 560;
  // Dissolution pixels : chaque cellule a son propre délai (effet de vague
  // en diagonale + léger décalage pseudo-aléatoire pour un rendu plus
  // "numérique/glitch" qu'une vague parfaitement lisse), calculé pour que
  // TOUTES les cellules aient fini d'apparaître avant de naviguer (sinon
  // l'animation était coupée en plein milieu, donc peu lisible).
  const PIXEL_COLS = 14;
  const PIXEL_ROWS = 8;
  const PIXEL_CELL_MS = 380;
  const PIXEL_STEP_MS = 22;
  const PIXEL_JITTER_MS = 32;
  const PIXEL_MAX_DELAY = (PIXEL_ROWS - 1 + PIXEL_COLS - 1) * PIXEL_STEP_MS + PIXEL_JITTER_MS;
  const PIXEL_MS = PIXEL_MAX_DELAY + PIXEL_CELL_MS; // durée totale de l'aller (couverture complète)
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function pageName(hrefOrPath) {
    try { return new URL(hrefOrPath, location.href).pathname.split('/').pop() || 'index.html'; }
    catch (e) { return ''; }
  }
  function currentPage() { return pageName(location.href); }
  function trioIndex(name) { return TRIO.indexOf(name); }
  function isTrio(name) { return trioIndex(name) !== -1; }
  function trioNeighbor(name, dir) { // dir : 1 = à droite (suivant), -1 = à gauche (précédent)
    const i = trioIndex(name);
    if (i === -1) return null;
    return TRIO[(i + dir + TRIO.length) % TRIO.length];
  }

  function injectStyles() {
    const css = `
      /* ── Rideau (trio) ── */
      #phx-curtain {
        position:fixed; inset:0; z-index:99999; pointer-events:none; display:none;
        background:
          repeating-linear-gradient(0deg, color-mix(in srgb, var(--gold, #00f0ff) 6%, transparent) 0px, transparent 1px, transparent 3px),
          linear-gradient(135deg, #0d0e14 0%, #12141d 55%, #0d0e14 100%);
        box-shadow: inset 0 0 90px color-mix(in srgb, var(--gold, #00f0ff) 22%, transparent);
        transform: translateX(100%);
        transition: transform ${CURTAIN_MS}ms cubic-bezier(.65,0,.2,1);
      }
      /* Bordures lumineuses sur les 2 bords : quel que soit le sens du
         glissement, le bord "actif" (celui qui avance dans l'écran) est
         ainsi toujours marqué clairement — c'est ce qui manquait pour bien
         voir "qu'on glisse" et pas juste un flash. */
      #phx-curtain::before, #phx-curtain::after {
        content:''; position:absolute; top:0; bottom:0; width:4px;
        background: var(--gold, #00f0ff);
        box-shadow: 0 0 20px 4px color-mix(in srgb, var(--gold, #00f0ff) 75%, transparent);
      }
      #phx-curtain::before { left:0; }
      #phx-curtain::after { right:0; }
      #phx-curtain.phx-active { display:block; }
      #phx-curtain.phx-instant { transition:none; }
      #phx-curtain.phx-start-right { transform: translateX(100%); }
      #phx-curtain.phx-start-left  { transform: translateX(-100%); }
      #phx-curtain.phx-cover       { transform: translateX(0); }
      #phx-curtain.phx-exit-right  { transform: translateX(100%); }
      #phx-curtain.phx-exit-left   { transform: translateX(-100%); }

      /* ── Dissolution pixels (reste du site) ── */
      #phx-pixel-overlay {
        position:fixed; inset:0; z-index:99999; pointer-events:none; display:none;
        grid-template-columns: repeat(${PIXEL_COLS}, 1fr);
        grid-template-rows: repeat(${PIXEL_ROWS}, 1fr);
      }
      #phx-pixel-overlay.phx-active { display:grid; }
      .phx-pixel-cell {
        opacity:0; transform:scale(.45);
        transition: opacity ${PIXEL_CELL_MS}ms ease, transform ${PIXEL_CELL_MS}ms ease;
        transition-delay: var(--d, 0ms);
      }
      .phx-pixel-a { background:#0d0e14; }
      .phx-pixel-b {
        background: var(--gold, #00f0ff);
        box-shadow: 0 0 10px color-mix(in srgb, var(--gold, #00f0ff) 60%, transparent);
        opacity:0;
      }
      #phx-pixel-overlay.phx-cover .phx-pixel-cell.phx-pixel-a { opacity:1; transform:scale(1); }
      #phx-pixel-overlay.phx-cover .phx-pixel-cell.phx-pixel-b { opacity:.75; transform:scale(1); }
      #phx-pixel-overlay.phx-instant .phx-pixel-cell { transition:none; }

      /* ── Flèches de navigation rapide (trio uniquement) ── */
      .phx-trio-arrow {
        position:fixed; top:50%; transform:translateY(-50%);
        display:flex; flex-direction:column; align-items:center; gap:.2rem;
        padding:.65rem .45rem; z-index:500;
        color:var(--text2, #939ab0); text-decoration:none;
        background:rgba(18,20,29,.6); border:1px solid var(--border, #2a2d3a);
        border-radius:8px;
        transition:color .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease;
      }
      .phx-trio-arrow:hover {
        color:var(--gold, #00f0ff); border-color:var(--gold-dim, #0097a7);
        background:rgba(18,20,29,.9);
        box-shadow:0 0 14px color-mix(in srgb, var(--gold, #00f0ff) 35%, transparent);
      }
      .phx-trio-chevron { font-size:1.35rem; line-height:1; font-family:'Rajdhani', sans-serif; }
      .phx-trio-label {
        font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;
        writing-mode:vertical-rl; text-orientation:mixed;
      }
      .phx-trio-left { left:.6rem; }
      .phx-trio-right { right:.6rem; }
      /* Mobile/tablette : on ne les masque plus (elles plaisaient bien en
         desktop) — on les rend juste compactes (pastille ronde, pas de
         texte) pour ne pas manger de largeur sur petit écran. Restent
         centrées verticalement sur le bord (donc à l'écart du conteneur de
         toasts, positionné lui en bas à droite). */
      @media (max-width:900px) {
        .phx-trio-arrow {
          padding:0; width:42px; height:42px;
          border-radius:50%; justify-content:center;
        }
        .phx-trio-label { display:none; }
        .phx-trio-chevron { font-size:1.3rem; }
        .phx-trio-left { left:.5rem; }
        .phx-trio-right { right:.5rem; }
      }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildOverlays() {
    const curtain = document.createElement('div');
    curtain.id = 'phx-curtain';
    document.body.appendChild(curtain);

    const pixelWrap = document.createElement('div');
    pixelWrap.id = 'phx-pixel-overlay';
    for (let r = 0; r < PIXEL_ROWS; r++) {
      for (let c = 0; c < PIXEL_COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'phx-pixel-cell ' + ((r + c) % 2 === 0 ? 'phx-pixel-a' : 'phx-pixel-b');
        const jitter = ((r * 31 + c * 17) % 5) * (PIXEL_JITTER_MS / 4);
        cell.style.setProperty('--d', ((r + c) * PIXEL_STEP_MS + jitter) + 'ms');
        pixelWrap.appendChild(cell);
      }
    }
    document.body.appendChild(pixelWrap);

    return { curtain, pixelWrap };
  }

  function buildTrioArrows(here) {
    const prevName = trioNeighbor(here, -1);
    const nextName = trioNeighbor(here, 1);
    const mk = (name, side) => {
      const a = document.createElement('a');
      a.href = name;
      a.className = 'phx-trio-arrow phx-trio-' + side;
      a.setAttribute('aria-label', TRIO_LABELS[name]);
      a.innerHTML = `<span class="phx-trio-chevron">${side === 'left' ? '‹' : '›'}</span><span class="phx-trio-label">${TRIO_LABELS[name]}</span>`;
      document.body.appendChild(a);
    };
    if (prevName) mk(prevName, 'left');
    if (nextName) mk(nextName, 'right');
  }

  // ── Rejoue, au chargement, l'effet noté par la page précédente ──
  function playEntrance(curtain, pixelWrap) {
    if (reduceMotion) return;
    let raw;
    try { raw = sessionStorage.getItem(FLAG_KEY); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(FLAG_KEY); } catch (e) {}
    let info;
    try { info = JSON.parse(raw); } catch (e) { return; }

    if (info.type === 'curtain') {
      // Posé plein écran INSTANTANÉMENT (sans transition, pour ne jamais
      // laisser voir la page avant l'effet), puis ressort en continuant le
      // même sens de trajet qu'à l'arrivée (sensation d'un seul geste
      // continu à travers les deux pages).
      curtain.classList.add('phx-active', 'phx-instant', 'phx-cover');
      void curtain.offsetWidth; // force le navigateur à appliquer l'état avant de réactiver la transition
      curtain.classList.remove('phx-instant');
      requestAnimationFrame(() => {
        curtain.classList.remove('phx-cover');
        curtain.classList.add(info.dir === 'right' ? 'phx-exit-left' : 'phx-exit-right');
      });
      setTimeout(() => curtain.remove(), CURTAIN_MS + 80);
    } else if (info.type === 'pixel') {
      pixelWrap.classList.add('phx-active', 'phx-instant', 'phx-cover');
      void pixelWrap.offsetWidth;
      pixelWrap.classList.remove('phx-instant');
      requestAnimationFrame(() => pixelWrap.classList.remove('phx-cover'));
      setTimeout(() => pixelWrap.remove(), PIXEL_MS + 500);
    }
  }

  function interceptLinks(curtain, pixelWrap) {
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const hrefAttr = a.getAttribute('href') || '';
      if (!hrefAttr || hrefAttr.startsWith('#') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:') || a.target === '_blank') return;

      let dest;
      try { dest = new URL(hrefAttr, location.href); } catch (err) { return; }
      if (dest.origin !== location.origin) return; // liens externes intacts

      const destName = dest.pathname.split('/').pop() || 'index.html';
      const here = currentPage();
      if (destName === here) return;

      if (reduceMotion) return; // navigation normale, sans interception

      e.preventDefault();
      const target = dest.href;
      const bothTrio = isTrio(here) && isTrio(destName);

      if (bothTrio) {
        const dir = trioNeighbor(here, 1) === destName ? 'right' : 'left';
        try { sessionStorage.setItem(FLAG_KEY, JSON.stringify({ type: 'curtain', dir })); } catch (err) {}
        curtain.classList.add('phx-active', 'phx-instant', dir === 'right' ? 'phx-start-right' : 'phx-start-left');
        void curtain.offsetWidth;
        curtain.classList.remove('phx-instant');
        requestAnimationFrame(() => curtain.classList.add('phx-cover'));
        setTimeout(() => { location.href = target; }, CURTAIN_MS);
      } else {
        try { sessionStorage.setItem(FLAG_KEY, JSON.stringify({ type: 'pixel' })); } catch (err) {}
        pixelWrap.classList.add('phx-active');
        requestAnimationFrame(() => pixelWrap.classList.add('phx-cover'));
        setTimeout(() => { location.href = target; }, PIXEL_MS);
      }
    });
  }

  function init() {
    injectStyles();
    const { curtain, pixelWrap } = buildOverlays();
    const here = currentPage();
    if (isTrio(here)) buildTrioArrows(here);
    playEntrance(curtain, pixelWrap);
    interceptLinks(curtain, pixelWrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
