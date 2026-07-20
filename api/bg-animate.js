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
    // Enfant de <body> (et non plus de <html>) : body a maintenant son
    // propre contexte d'empilement (position:relative, voir cyber-theme.css),
    // donc son fond passe garanti derrière ce wrapper — plus besoin de
    // compter sur l'ordre de peinture au niveau racine, qui dépendait de
    // ce que chaque page mettait (ou pas) comme fond opaque sur <body>.
    // prepend plutôt qu'append : reste avant le vrai contenu dans le DOM,
    // en plus d'être déjà derrière lui grâce au z-index.
    document.body.prepend(wrap);
  }

  // ── Icônes en dérive (logos/émojis jeu vidéo, fond transparent) ──
  // Liste des fichiers dans assets/icons/. Pour en ajouter de nouveaux :
  // déposer le PNG dans ce dossier et ajouter son nom ici, rien d'autre
  // à toucher.
  const ICONS = [
    '1431-mk-lightning.png', '1734-vaultboy.png', '18173-gamecube.png',
    '1888-mk-mushroom.png', '1920-snorlax.png', '197187-plumbobmelt.png',
    '2072-gtav.png', '250291-playstation.png', '2581-gamecubecontroller.png',
    '26156-red-dead-redemption-2.png', '3335_rocket_league_logo.png',
    '4002_PS2_Controller.png', '423190-xbox.png', '43674-mariokart.png',
    '50459-wiimote-power-button.png', '52226-steam.png',
    '55912-wiimote-dpad.png', '63643-gameboy.png', '6438-warpstarkirby.png',
    '7183-mk-red-shell.png', '720020-minecraftheart.png',
    '738422-minecraftdiamond.png', '82816-classicsonic.png',
    'PS4Controller.png', 'XboxOneController.png'
  ];
  // Chemin relatif : fonctionne quelle que soit la page tant que
  // assets/icons/ est à la racine du site, à côté d'index.html.
  const ICONS_BASE = 'assets/icons/';

  function buildIconMotes() {
    const wrap = document.createElement('div');
    wrap.id = 'phx-bg-icons';
    wrap.setAttribute('aria-hidden', 'true');
    const count = isCoarsePointer || window.innerWidth < 640 ? 3 : 5;
    // Pioche sans répétition tant que la liste le permet, pour ne pas
    // voir deux fois le même logo en même temps à l'écran.
    const pool = [...ICONS].sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      const file = pool[i % pool.length];
      const img = document.createElement('img');
      img.className = 'phx-icon-mote';
      img.src = ICONS_BASE + file;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      const size = 22 + Math.random() * 18; // 22-40px : discret, jamais imposant
      const dx = (Math.random() * 120 - 60).toFixed(0) + 'px';
      const dy = -(320 + Math.random() * 360).toFixed(0) + 'px';
      const duration = 34 + Math.random() * 26; // lent, "de temps en temps"
      const delay = -Math.random() * duration;
      img.style.left = (Math.random() * 100) + '%';
      img.style.top = (Math.random() * 100) + '%';
      img.style.width = size + 'px';
      img.style.setProperty('--dx', dx);
      img.style.setProperty('--dy', dy);
      img.style.animationDuration = duration.toFixed(1) + 's';
      img.style.animationDelay = delay.toFixed(1) + 's';
      wrap.appendChild(img);
    }
    document.body.prepend(wrap);
  }

  function init() {
    buildParticles();
    buildIconMotes();
    // Position initiale de la grille (avant tout mouvement de souris)
    root.style.setProperty('--phx-py', scrollOffset().toFixed(1) + 'px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
