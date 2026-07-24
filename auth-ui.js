// ==========================================================
// auth-ui.js — Pastille "Connexion" / pseudo + modal inscription/
// connexion, injectée en haut à droite sur toutes les pages.
// Zéro dépendance à nav.js ou au bouton "☰ Menu" : fonctionne même
// sur index.html qui n'a pas de nav.js.
// Charger APRÈS auth.js (utilise PHXAuth).
// ==========================================================

(function () {
  function injectStyles() {
    const css = `
      .phx-auth-pill {
        position: fixed; top: max(14px, env(safe-area-inset-top));
        right: max(14px, env(safe-area-inset-right));
        z-index: 700;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        min-width: 100px; box-sizing: border-box;
        padding: 8px 14px;
        background: rgba(255,255,255,.04);
        border: 1px solid var(--border, #2a2d3a);
        border-radius: 999px;
        color: var(--text, #e5e5e5);
        font-family: 'Exo 2', sans-serif;
        font-size: 12.5px; font-weight: 600; letter-spacing: .02em;
        cursor: pointer; white-space: nowrap;
        transition: all .15s ease;
      }
      .phx-auth-pill:hover { background: rgba(255,255,255,.09); border-color: var(--gold, #00f0ff); }
      .phx-auth-pill .crown { color: var(--gold, #00f0ff); }
      @media (max-width: 640px) {
        .phx-auth-pill { padding: 6px 11px; font-size: 11px; top: 10px; right: 10px; }
      }

      .phx-auth-menu {
        position: fixed; z-index: 701; min-width: 160px;
        background: var(--bg2, #12141d); border: 1px solid var(--border, #2a2d3a);
        border-radius: 8px; padding: .4rem; display: none; flex-direction: column; gap: 2px;
        box-shadow: 0 16px 40px rgba(0,0,0,.55);
      }
      .phx-auth-menu.open { display: flex; }
      .phx-auth-menu button {
        all: unset; cursor: pointer; padding: .55rem .7rem; border-radius: 4px;
        font-family: 'Exo 2', sans-serif; font-size: 13px; color: var(--text, #f0f1f5);
      }
      .phx-auth-menu button:hover { background: var(--bg3, #181a25); color: var(--gold, #00f0ff); }

      .phx-auth-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.72); z-index: 950;
        display: none; align-items: center; justify-content: center; padding: 20px;
        font-family: 'Exo 2', sans-serif;
      }
      .phx-auth-overlay.open { display: flex; }
      .phx-auth-box {
        background: var(--bg2, #12141d); border: 1px solid var(--border, #2a2d3a);
        border-radius: 12px; padding: 44px 24px 24px; max-width: 340px; width: 100%;
        box-shadow: 0 10px 40px rgba(0,0,0,.5);
      }
      .phx-auth-tabs { display: flex; gap: 4px; margin-bottom: 18px; }
      .phx-auth-tab {
        flex: 1; text-align: center; padding: 9px; border-radius: 6px; cursor: pointer;
        color: var(--text2, #939ab0); font-size: 13px; font-weight: 700; letter-spacing: .02em;
        border: 1px solid var(--border, #2a2d3a); background: transparent;
      }
      .phx-auth-tab.active { color: var(--gold, #00f0ff); border-color: var(--gold, #00f0ff); background: rgba(255,255,255,.03); }
      .phx-auth-field { margin-bottom: 12px; }
      .phx-auth-field input {
        width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 6px;
        border: 1px solid var(--border, #2a2d3a); background: var(--bg3, #181a25);
        color: #fff; font-size: 14px; font-family: inherit;
      }
      .phx-auth-field input:focus { outline: none; border-color: var(--gold, #00f0ff); }
      .phx-auth-msg { font-size: 12.5px; margin-bottom: 12px; line-height: 1.4; min-height: 1px; }
      .phx-auth-remember {
        display: flex; align-items: center; gap: 7px; margin-bottom: 14px;
        color: var(--text2, #939ab0); font-size: 12.5px; cursor: pointer; user-select: none;
      }
      .phx-auth-remember input { margin: 0; accent-color: var(--gold, #00f0ff); cursor: pointer; }
      .phx-auth-msg.err { color: #ff6b6b; }
      .phx-auth-msg.ok { color: #4ade80; }
      .phx-auth-submit {
        width: 100%; padding: 10px; border-radius: 6px; border: none; cursor: pointer;
        background: var(--gold, #00f0ff); color: #0d0e14; font-weight: 700; font-size: 13.5px;
        font-family: inherit;
      }
      .phx-auth-submit:disabled { opacity: .5; cursor: default; }
      .phx-auth-close {
        all: unset; position: absolute; top: 12px; right: 12px; cursor: pointer;
        width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
        color: var(--text2, #939ab0); font-size: 18px; line-height: 1; border-radius: 50%;
        box-sizing: border-box;
      }
      .phx-auth-close:hover { background: rgba(255,255,255,.08); color: var(--text, #f0f1f5); }
      .phx-auth-box { position: relative; }
      .phx-auth-resend { background: none; border: none; color: var(--gold, #00f0ff); text-decoration: underline; cursor: pointer; font: inherit; padding: 0; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function build() {
    // Pastille
    const pill = document.createElement('div');
    pill.className = 'phx-auth-pill';
    pill.textContent = 'Connexion';
    document.body.appendChild(pill);

    // Menu déroulant (affiché quand connecté)
    const menu = document.createElement('div');
    menu.className = 'phx-auth-menu';
    menu.innerHTML = `<button type="button" data-logout>Déconnexion</button>`;
    document.body.appendChild(menu);

    // Overlay modal
    const overlay = document.createElement('div');
    overlay.className = 'phx-auth-overlay';
    overlay.innerHTML = `
      <div class="phx-auth-box">
        <button type="button" class="phx-auth-close" data-close>&times;</button>
        <div class="phx-auth-tabs">
          <button type="button" class="phx-auth-tab active" data-tab="login">Connexion</button>
          <button type="button" class="phx-auth-tab" data-tab="register">Inscription</button>
        </div>
        <div class="phx-auth-msg" data-msg></div>
        <form data-form>
          <div class="phx-auth-field" data-field-username style="display:none">
            <input type="text" placeholder="Pseudo" data-username autocomplete="off">
          </div>
          <div class="phx-auth-field">
            <input type="email" placeholder="Email" data-email autocomplete="email" required>
          </div>
          <div class="phx-auth-field">
            <input type="password" placeholder="Mot de passe" data-password autocomplete="current-password" required>
          </div>
          <label class="phx-auth-remember" data-remember-field>
            <input type="checkbox" data-remember checked>
            <span>Rester connecté</span>
          </label>
          <button type="submit" class="phx-auth-submit" data-submit>Se connecter</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    return { pill, menu, overlay };
  }

  function init() {
    injectStyles();
    const { pill, menu, overlay } = build();

    const msgEl = overlay.querySelector('[data-msg]');
    const form = overlay.querySelector('[data-form]');
    const usernameField = overlay.querySelector('[data-field-username]');
    const usernameInput = overlay.querySelector('[data-username]');
    const emailInput = overlay.querySelector('[data-email]');
    const passwordInput = overlay.querySelector('[data-password]');
    const rememberField = overlay.querySelector('[data-remember-field]');
    const rememberInput = overlay.querySelector('[data-remember]');
    const submitBtn = overlay.querySelector('[data-submit]');
    const tabs = overlay.querySelectorAll('.phx-auth-tab');

    let mode = 'login';
    let pendingConfirmEmail = null; // email en attente de confirmation, pour proposer un renvoi

    function setMsg(text, kind) {
      msgEl.textContent = text || '';
      msgEl.className = 'phx-auth-msg' + (kind ? ' ' + kind : '');
      if (kind !== 'confirm') pendingConfirmEmail = null;
    }

    function setMode(m) {
      mode = m;
      pendingConfirmEmail = null;
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === m));
      usernameField.style.display = m === 'register' ? 'block' : 'none';
      usernameInput.required = m === 'register';
      rememberField.style.display = m === 'register' ? 'none' : 'flex';
      submitBtn.textContent = m === 'register' ? "S'inscrire" : 'Se connecter';
      passwordInput.autocomplete = m === 'register' ? 'new-password' : 'current-password';
      setMsg('');
    }

    tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.tab)));

    function openModal() {
      overlay.classList.add('open');
      setMode('login');
      form.reset();
      requestAnimationFrame(() => emailInput.focus());
    }
    function closeModal() { overlay.classList.remove('open'); }

    overlay.querySelector('[data-close]').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      submitBtn.disabled = true;
      setMsg('');
      try {
        if (mode === 'register') {
          await PHXAuth.signUp(email, password, usernameInput.value);
          setMsg("Compte créé ! Vérifie ta boîte mail et clique sur le lien de confirmation avant de te connecter.", 'ok');
          setMode('login');
          emailInput.value = email;
        } else {
          await PHXAuth.signIn(email, password, rememberInput.checked);
          closeModal();
        }
      } catch (err) {
        setMsg(err.message, 'err');
        if (/pas encore confirmé/i.test(err.message)) pendingConfirmEmail = email;
      } finally {
        submitBtn.disabled = false;
      }
    });

    // Lien "renvoyer l'email" affiché quand l'erreur est "email non confirmé"
    msgEl.addEventListener('click', async e => {
      if (e.target.dataset.resend === undefined) return;
      if (!pendingConfirmEmail) return;
      try {
        await PHXAuth.resendConfirmation(pendingConfirmEmail);
        setMsg('Email de confirmation renvoyé.', 'ok');
      } catch (err) {
        setMsg(err.message, 'err');
      }
    });

    // Réaffiche le message avec un lien "renvoyer" cliquable si applicable
    const observer = new MutationObserver(() => {
      if (pendingConfirmEmail && /pas encore confirmé/i.test(msgEl.textContent) && !msgEl.querySelector('[data-resend]')) {
        msgEl.innerHTML = msgEl.textContent + ' <button type="button" class="phx-auth-resend" data-resend>Renvoyer l\'email</button>';
      }
    });
    observer.observe(msgEl, { childList: true, characterData: true, subtree: true });

    // Pastille : ouvre le menu si connecté, sinon la modal
    let connected = false;
    pill.addEventListener('click', () => {
      if (connected) {
        const opening = !menu.classList.contains('open');
        menu.classList.toggle('open');
        const r = pill.getBoundingClientRect();
        menu.style.top = (r.bottom + 8) + 'px';
        menu.style.right = (window.innerWidth - r.right) + 'px';
        if (opening) document.dispatchEvent(new CustomEvent('phx-menu-open', { detail: { source: 'auth' } }));
      } else {
        openModal();
      }
    });
    document.addEventListener('click', e => {
      if (!menu.contains(e.target) && e.target !== pill) menu.classList.remove('open');
    });
    document.addEventListener('phx-menu-open', e => {
      if (e.detail?.source !== 'auth') menu.classList.remove('open');
    });
    menu.querySelector('[data-logout]').addEventListener('click', async () => {
      menu.classList.remove('open');
      await PHXAuth.signOut();
    });

    // Réagit aux changements de session (connexion/déconnexion/profil chargé)
    PHXAuth.onChange(({ session, profile, isAnonymous }) => {
      connected = !!session && !isAnonymous;
      if (!session || isAnonymous) {
        pill.textContent = 'Connexion';
      } else if (profile) {
        pill.innerHTML = (profile.role === 'curator' ? '<span class="crown">👑</span> ' : '') + profile.username;
      } else {
        pill.textContent = 'Connexion…';
      }
    });

    // Expose une API minimale pour que d'autres scripts (curator-gate.js)
    // puissent ouvrir la modal de connexion sans dupliquer sa logique.
    window.PHXAuthUI = { open: openModal };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
