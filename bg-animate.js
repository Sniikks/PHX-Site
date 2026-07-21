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
    'PS4Controller.png', 'XboxOneController.png',
    '6108-ryu-hmm.png', '16392-goku.png', '2759_geralt.png',
    '788129-umbrella.png', '62625-butterfly.png', '2754-a2laugh.png',
    '4898-tekken-kazuya.png', '11639-rebeccasalute.png',
    '6074-orisahappy.png', '8212-bastioncap.png', '7588-the-last-of-us.png',
    '1018_Witcher3.png', '1355-rust.png', '1642_vault_blTPS.png',
    '1986_SpiderMan.png', '205621-worldofwarcraft.png',
    '208924-btd6-dart-monkey.png', '24367-pubgsteam.png', '27174-camera.png',
    '2874-baldursgate.png', '3051-assassin-mission.png',
    '32558-pacman-showsyou.png', '3495-rockstar-launcher.png',
    '3692-pikachusmug.png', '4858-platinum-trophy.png',
    '521028-phasmo-ids.png', '555182-hrclub14days.png',
    '57291-alta-recycling-cude.png', '6707-lol.png', '6844-deadbydaylight.png',
    '7445-callofdutyblackops3.png', '7694-gameover.png', '7863-skyrimicon.png',
    '824551-masterchief.png', '8403-gaben.png', '90202-targetacquired.png',
    '940605-legostarwarsclassiclogo.png', '95962-supermansymbolclassic.png',
    '969490-csgo.png', 'MadSmashBayonetta.png', 'Metroid.png',
    'borderlands2.png', 'gmod.png'
  ];
  // Chemin relatif : fonctionne quelle que soit la page tant que
  // assets/icons/ est à la racine du site, à côté d'index.html.
  const ICONS_BASE = 'assets/icons/';

  // ── Icônes en dérive : fait réapparaître une nouvelle icône
  // régulièrement (au lieu d'un lot fixe qui compte sur une animation
  // CSS "infinite" pour boucler indéfiniment — plus fragile sur la
  // durée : un onglet mis en arrière-plan, un throttling navigateur,
  // etc. peuvent la figer sans redémarrage possible). Chaque icône a
  // un cycle de vie fini (une seule traversée), puis est retirée du
  // DOM et remplacée par une nouvelle — ça ne peut donc jamais
  // "s'arrêter" au bout d'un moment.
  function spawnIconMote(wrap) {
    const file = ICONS[Math.floor(Math.random() * ICONS.length)];
    const img = document.createElement('img');
    img.className = 'phx-icon-mote';
    img.src = ICONS_BASE + file;
    img.alt = '';
    img.decoding = 'async';
    const size = 22 + Math.random() * 18; // 22-40px : discret, jamais imposant
    const dx = (Math.random() * 120 - 60).toFixed(0) + 'px';
    const dy = -(320 + Math.random() * 360).toFixed(0) + 'px';
    const duration = 22 + Math.random() * 16; // durée d'une traversée complète
    img.style.left = (Math.random() * 100) + '%';
    img.style.top = (Math.random() * 100) + '%';
    img.style.width = size + 'px';
    img.style.setProperty('--dx', dx);
    img.style.setProperty('--dy', dy);
    img.style.animationDuration = duration.toFixed(1) + 's';
    img.style.animationIterationCount = '1';
    // Filet de sécurité : si "animationend" ne se déclenche pas pour une
    // raison quelconque (onglet resté en arrière-plan, etc.), on retire
    // quand même l'élément après la durée prévue + marge.
    const cleanup = () => img.remove();
    img.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, (duration + 2) * 1000);
    wrap.appendChild(img);
  }

  function buildIconMotes() {
    const wrap = document.createElement('div');
    wrap.id = 'phx-bg-icons';
    wrap.setAttribute('aria-hidden', 'true');
    document.body.prepend(wrap);

    const maxConcurrent = isCoarsePointer || window.innerWidth < 640 ? 2 : 4;
    const spawnEveryMs = 7000; // tente une nouvelle icône environ toutes les 7s

    // Amorçage : quelques icônes déjà présentes au chargement, pour ne pas
    // attendre 7s avant la toute première.
    const initialCount = isCoarsePointer || window.innerWidth < 640 ? 1 : 3;
    for (let i = 0; i < initialCount; i++) spawnIconMote(wrap);

    setInterval(() => {
      if (wrap.children.length < maxConcurrent) spawnIconMote(wrap);
    }, spawnEveryMs);
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
