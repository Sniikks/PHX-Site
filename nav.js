// ==========================================================
// nav.js — Navigation partagée entre les pages du site
// Transforme le bouton "☰ Menu" existant (lien vers index.html)
// en menu déroulant listant toutes les sections, avec la page
// courante mise en évidence. Zéro dépendance, zéro impact layout :
// si le bouton n'existe pas ou si JS est désactivé, le lien
// vers l'accueil continue de fonctionner normalement.
// ==========================================================

(function () {
  const PAGES = [
    { href: 'index.html',                 label: '🏠 Accueil' },
    { href: 'proposition.html',           label: '💻 Proposition de Jeux' },
    { href: 'Sniikks_liste_de_jeux.html', label: '✋ Jeux de Sniikks' },
    { href: '369_liste_de_jeux.html',     label: '✋🏿 Jeux de 369' },
    { href: 'bracket-jeux.html',          label: '🏆 Bracket' },
    { href: 'zoomjeu.html',               label: '🔍 ZoomJeu' },
    { href: 'mot-cache.html',             label: '🎮 Jeu Caché' },
    { href: 'mot-francais.html',          label: '📚 Mot Français' },
    { href: 'pixels.html',                label: '🧩 Pixels' }
  ];

  function currentPage() {
    const path = location.pathname.split('/').pop() || 'index.html';
    return decodeURIComponent(path);
  }

  function injectStyles() {
    const css = `
      /* Accessibilité clavier : contour visible sur tous les éléments focusables */
      :focus-visible { outline: 2px solid var(--gold, #00f0ff); outline-offset: 2px; }

      .phx-nav-panel {
        position: fixed;
        min-width: 220px;
        background: var(--bg2, #12141d);
        border: 1px solid var(--border, #2a2d3a);
        border-radius: 4px;
        box-shadow: 0 16px 40px rgba(0,0,0,.55);
        padding: .45rem;
        z-index: 650;
        display: none;
        flex-direction: column;
        gap: 2px;
      }
      .phx-nav-panel.open { display: flex; }
      .phx-nav-panel a {
        display: block;
        padding: .55rem .75rem;
        border-radius: 2px;
        font-family: 'Exo 2', sans-serif;
        font-size: .85rem;
        color: var(--text, #f0f1f5);
        text-decoration: none;
        white-space: nowrap;
      }
      .phx-nav-panel a:hover { background: var(--bg3, #181a25); color: var(--gold, #00f0ff); }
      .phx-nav-panel a.current {
        color: var(--gold, #00f0ff);
        background: var(--bg3, #181a25);
        font-weight: 700;
      }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function init() {
    const btn = document.querySelector('a.menu-btn[href="index.html"], a.menu-btn[href="./index.html"]');
    if (!btn) return;

    injectStyles();

    const panel = document.createElement('nav');
    panel.className = 'phx-nav-panel';
    panel.setAttribute('aria-label', 'Navigation du site');

    const here = currentPage();
    PAGES.forEach(p => {
      const a = document.createElement('a');
      a.href = p.href;
      a.textContent = p.label;
      if (p.href === here) { a.classList.add('current'); a.setAttribute('aria-current', 'page'); }
      panel.appendChild(a);
    });
    document.body.appendChild(panel);

    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    function positionPanel() {
      const r = btn.getBoundingClientRect();
      const panelWidth = Math.max(220, panel.offsetWidth);
      // Sous le bouton, aligné à gauche, sans déborder de l'écran
      let left = Math.min(r.left, window.innerWidth - panelWidth - 8);
      panel.style.top = (r.bottom + 8) + 'px';
      panel.style.left = Math.max(8, left) + 'px';
    }

    function open() {
      panel.classList.add('open');
      positionPanel();
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggle() { panel.classList.contains('open') ? close() : open(); }

    // Le clic n'emmène plus directement à l'accueil : il ouvre le menu
    // (l'accueil reste la 1ʳᵉ entrée du menu). Sans JS, le lien marche toujours.
    btn.addEventListener('click', e => { e.preventDefault(); toggle(); });

    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', () => { if (panel.classList.contains('open')) positionPanel(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
