// ==========================================================
// curator-gate.js — Réserve une page aux comptes curateurs
// (Sniikks / 369). À charger UNIQUEMENT sur les 6 pages concernées :
// proposition.html, Sniikks_liste_de_jeux.html, 369_liste_de_jeux.html,
// zoomjeu.html, mot-cache.html, mot-francais.html.
//
// Cache le contenu de la page tant que le statut curateur n'est pas
// confirmé — c'est un garde-fou visuel côté client. La vraie sécurité
// vient des policies RLS (lecture) et de la vérification serveur JWT
// (écriture, api/guess.js, api/motcache.js, api/motfrancais.js,
// api/protected-write.js) : même en désactivant ce script, personne
// de non-curateur ne peut lire ni écrire les données de ces pages.
//
// Charger APRÈS auth.js et auth-ui.js.
// ==========================================================

(function () {
  const style = document.createElement('style');
  style.textContent = `
    body.phx-gate-pending > *:not(.phx-gate-panel) { visibility: hidden !important; }
    .phx-gate-panel {
      position: fixed; inset: 0; z-index: 900; display: none;
      align-items: center; justify-content: center; padding: 24px;
      background: var(--bg, #0d0e14); font-family: 'Exo 2', sans-serif; text-align: center;
    }
    .phx-gate-panel.show { display: flex; }
    .phx-gate-box { max-width: 360px; }
    .phx-gate-box h1 {
      font-family: 'Rajdhani', sans-serif; font-size: 1.3rem; color: var(--gold, #00f0ff);
      letter-spacing: .08em; text-transform: uppercase; margin-bottom: .8rem;
    }
    .phx-gate-box p { color: var(--text2, #939ab0); font-size: 13.5px; line-height: 1.5; margin-bottom: 1.4rem; }
    .phx-gate-actions { display: flex; gap: 10px; justify-content: center; }
    .phx-gate-box button, .phx-gate-box a {
      padding: 10px 20px; border-radius: 6px; border: 1px solid transparent; cursor: pointer;
      font-weight: 700; font-size: 13.5px; font-family: inherit; text-decoration: none;
    }
    .phx-gate-box button {
      background: var(--gold, #00f0ff); color: #0d0e14;
    }
    .phx-gate-box a {
      background: transparent; color: var(--text2, #939ab0); border-color: var(--border, #2a2d3a);
    }
  `;
  document.head.appendChild(style);
  document.body.classList.add('phx-gate-pending');

  const panel = document.createElement('div');
  panel.className = 'phx-gate-panel';
  panel.innerHTML = `
    <div class="phx-gate-box">
      <h1>Accès réservé</h1>
      <p>Cette page est réservée aux comptes curateurs du site (Sniikks / 369).</p>
      <div class="phx-gate-actions">
        <button type="button" data-gate-login>Se connecter</button>
        <a href="index.html">Retour à l'accueil</a>
      </div>
    </div>`;

  function mount() {
    document.body.appendChild(panel);
    panel.querySelector('[data-gate-login]').addEventListener('click', () => {
      if (window.PHXAuthUI) window.PHXAuthUI.open();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  PHXAuth.onChange(({ session, profile }) => {
    const ok = !!session && !!profile && profile.role === 'curator';
    document.body.classList.toggle('phx-gate-pending', !ok);
    panel.classList.toggle('show', !ok);
  });
})();
