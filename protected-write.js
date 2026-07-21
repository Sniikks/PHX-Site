// ==========================================================
// protected-write.js — Passerelle d'écriture protégée (client)
// Toute écriture sur 369_games / sniikks_games / proposition /
// bracket_data passe par /api/protected-write, qui vérifie un code
// partagé côté serveur avant d'écrire. Le code est demandé une seule
// fois par navigateur (popup), puis mémorisé dans localStorage.
// ==========================================================

const ProtectedWrite = {
  _codeKey: 'phx_site_code',

  getCode() {
    try { return localStorage.getItem(this._codeKey) || ''; } catch (e) { return ''; }
  },
  setCode(code) {
    try { localStorage.setItem(this._codeKey, code); } catch (e) {}
  },
  clearCode() {
    try { localStorage.removeItem(this._codeKey); } catch (e) {}
  },

  // Popup minimaliste — ne dépend d'aucune classe CSS propre à une page,
  // pour fonctionner à l'identique sur les 4 pages concernées.
  promptCode(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:"Exo 2",sans-serif;padding:20px;';
      overlay.innerHTML = `
        <div style="background:#12141d;border:1px solid #2a2d3a;border-radius:10px;padding:24px;max-width:320px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5);">
          <div style="color:#f0f1f5;font-size:14px;margin-bottom:14px;line-height:1.4;">${message}</div>
          <input type="password" id="pwCodeInput" placeholder="Code d'accès" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:6px;border:1px solid #2a2d3a;background:#181a25;color:#fff;font-size:14px;margin-bottom:12px;font-family:inherit;" autocomplete="off">
          <div style="display:flex;gap:8px;">
            <button id="pwCodeCancel" style="flex:1;padding:9px;border-radius:6px;border:1px solid #2a2d3a;background:transparent;color:#939ab0;cursor:pointer;font-family:inherit;font-size:13px;">Annuler</button>
            <button id="pwCodeOk" style="flex:1;padding:9px;border-radius:6px;border:none;background:#00f0ff;color:#0d0e14;font-weight:700;cursor:pointer;font-family:inherit;font-size:13px;">Valider</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#pwCodeInput');
      requestAnimationFrame(() => input.focus());
      const cleanup = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('#pwCodeOk').addEventListener('click', () => cleanup(input.value.trim()));
      overlay.querySelector('#pwCodeCancel').addEventListener('click', () => cleanup(null));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') cleanup(input.value.trim());
        if (e.key === 'Escape') cleanup(null);
      });
    });
  },

  // Envoie une écriture protégée. Redemande le code s'il est absent ou
  // refusé (mauvais code) — jusqu'à 3 essais, ou annulation.
  async call(payload) {
    let code = this.getCode();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!code) {
        code = await this.promptCode("Cette modification nécessite le code d'accès du site :");
        if (code === null) throw new Error('Annulé.');
      }
      const res = await fetch('/api/protected-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, code })
      });
      if (res.status === 401) {
        this.clearCode();
        code = await this.promptCode('Code incorrect, réessaie :');
        if (code === null) throw new Error('Annulé.');
        continue;
      }
      if (res.status === 429) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Trop de tentatives, réessaie plus tard.');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Erreur serveur.');
      }
      this.setCode(code);
      return await res.json().catch(() => ({}));
    }
    throw new Error('Trop de tentatives, réessaie plus tard.');
  }
};
