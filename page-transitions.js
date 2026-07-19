// ==========================================================
// page-transitions.js — Transition de page, tout le site
// ==========================================================
// Le site est multi-pages (pas une single-page app) : la transition se
// joue donc en 2 temps qui ne partagent que sessionStorage pour se
// transmettre la direction :
//   1. Sur la page qu'on QUITTE : on intercepte le clic sur un lien
//      interne, on joue l'animation de "sortie" (le rideau recouvre
//      l'écran), on note la direction dans sessionStorage, PUIS on navigue.
//   2. Sur la page qui S'AFFICHE : on lit la direction au chargement, on
//      pose le rideau déjà en position "couverte" SANS transition (pour
//      éviter un flash du contenu avant l'effet), puis on le fait glisser
//      pour révéler la page — en continuant le même sens de trajet, pour
//      que ça se lise comme un seul geste continu à travers les 2 pages.
//
// Un seul effet pour tout le site (rideau cyberpunk directionnel). La
// direction n'a de sens défini que pour le trio Sniikks / 369 /
// Proposition (boucle cyclique : chacune a une voisine "à droite" et une
// "à gauche" — validé : Sniikks→369 à droite, →Proposition à gauche ; 369→
// Proposition à droite, →Sniikks à gauche ; Proposition→Sniikks à droite,
// →369 à gauche). Pour toute autre navigation, la direction "à droite" est
// utilisée par défaut — même effet visuel, juste sans logique de sens.
//
// Ces 3 pages du trio ont en plus des boutons ‹ › fixés sur les bords pour
// naviguer directement entre elles sans passer par le menu — mêmes petites
// pastilles rondes sur desktop, tablette et mobile (pas de version "large"
// différente).
//
// Si JS/sessionStorage est indisponible, ou si la personne a activé
// "réduire les animations", les liens restent de simples liens, sans
// aucun effet — jamais bloquant.
// ==========================================================

(function () {
  const TRIO = ['Sniikks_liste_de_jeux.html', '369_liste_de_jeux.html', 'proposition.html'];
  const TRIO_LABELS = {
    'Sniikks_liste_de_jeux.html': 'Sniikks',
    '369_liste_de_jeux.html': '369',
    'proposition.html': 'Proposition'
  };

  const FLAG_KEY = 'phxPageTransition';
  // Ralenti + bordure lumineuse (voir CSS) pour que le sens du glissement
  // se voie clairement, plutôt qu'un aller-retour trop rapide pour être lu
  // comme un vrai "slide".
  const CURTAIN_MS = 560;
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
  // Direction du trajet : logique de boucle si les 2 pages sont dans le
  // trio, sinon "à droite" par défaut (aucun ordre défini hors du trio).
  function directionFor(here, dest) {
    if (isTrio(here) && isTrio(dest) && trioNeighbor(here, -1) === dest) return 'left';
    return 'right';
  }

  function injectStyles() {
    const css = `
      #phx-curtain {
        position:fixed; inset:0; z-index:99999; pointer-events:none; display:none;
        background:
          repeating-linear-gradient(0deg, color-mix(in srgb, var(--gold, #00f0ff) 6%, transparent) 0px, transparent 1px, transparent 3px),
          linear-gradient(135deg, #0d0e14 0%, #12141d 55%, #0d0e14 100%);
        box-shadow: inset 0 0 90px color-mix(in srgb, var(--gold, #00f0ff) 22%, transparent);
        transform: translateX(100%);
        transition: transform ${CURTAIN_MS}ms cubic-bezier(.65,0,.2,1);
      }
      /* Bordures lumineuses sur les 2 bords : le bord "actif" (celui qui
         avance dans l'écran) est ainsi toujours marqué clairement, quel
         que soit le sens du glissement. */
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

      /* ── Boutons de navigation directe (trio) — pastille ronde minimale,
         identique sur desktop/tablette/mobile. ── */
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

  function buildCurtain() {
    const curtain = document.createElement('div');
    curtain.id = 'phx-curtain';
    document.body.appendChild(curtain);
    return curtain;
  }

  function buildTrioArrows(here) {
    const prevName = trioNeighbor(here, -1);
    const nextName = trioNeighbor(here, 1);
    const mk = (name, side) => {
      const a = document.createElement('a');
      a.href = name;
      a.className = 'phx-trio-arrow phx-trio-' + side;
      a.setAttribute('aria-label', TRIO_LABELS[name]);
      a.title = TRIO_LABELS[name];
      a.textContent = side === 'left' ? '‹' : '›';
      document.body.appendChild(a);
    };
    if (prevName) mk(prevName, 'left');
    if (nextName) mk(nextName, 'right');
  }

  // ── Rejoue, au chargement, l'effet noté par la page précédente ──
  function playEntrance(curtain) {
    if (reduceMotion) return;
    let raw;
    try { raw = sessionStorage.getItem(FLAG_KEY); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(FLAG_KEY); } catch (e) {}
    let info;
    try { info = JSON.parse(raw); } catch (e) { return; }
    if (!info || info.type !== 'curtain') return;

    // Posé plein écran INSTANTANÉMENT (sans transition, pour ne jamais
    // laisser voir la page avant l'effet), puis ressort en continuant le
    // même sens de trajet qu'à l'arrivée.
    curtain.classList.add('phx-active', 'phx-instant', 'phx-cover');
    void curtain.offsetWidth; // force le navigateur à appliquer l'état avant de réactiver la transition
    curtain.classList.remove('phx-instant');
    requestAnimationFrame(() => {
      curtain.classList.remove('phx-cover');
      curtain.classList.add(info.dir === 'right' ? 'phx-exit-left' : 'phx-exit-right');
    });
    setTimeout(() => curtain.remove(), CURTAIN_MS + 80);
  }

  function interceptLinks(curtain) {
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
      const dir = directionFor(here, destName);

      try { sessionStorage.setItem(FLAG_KEY, JSON.stringify({ type: 'curtain', dir })); } catch (err) {}
      curtain.classList.add('phx-active', 'phx-instant', dir === 'right' ? 'phx-start-right' : 'phx-start-left');
      void curtain.offsetWidth;
      curtain.classList.remove('phx-instant');
      requestAnimationFrame(() => curtain.classList.add('phx-cover'));
      setTimeout(() => { location.href = target; }, CURTAIN_MS);
    });
  }

  function init() {
    injectStyles();
    const curtain = buildCurtain();
    const here = currentPage();
    if (isTrio(here)) buildTrioArrows(here);
    playEntrance(curtain);
    interceptLinks(curtain);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
