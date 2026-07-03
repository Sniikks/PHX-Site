// ==========================================================
// RemoteStore — petit magasin clé/valeur JSON
// Stocke des blobs JSON dans la table Supabase "app_data"
// (id text primaire, data jsonb). Un cache mémoire + localStorage
// permet un rendu instantané pendant que la synchro réseau se fait.
// ==========================================================

const RemoteStore = {
  _cache: {},
  _ready: false,
  _statusEl: null,

  setStatusElement(el) { this._statusEl = el; },

  _setStatus(text, ok) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? '#4a9a4a' : '#c94040';
  },

  // Précharge une liste de clés en une seule requête réseau.
  async init(keys) {
    // 1. Lecture immédiate du cache local (pour affichage instantané hors-ligne)
    keys.forEach(k => {
      const local = localStorage.getItem('cache_' + k);
      if (local) {
        try { this._cache[k] = JSON.parse(local); } catch (e) {}
      }
    });

    // 2. Synchro avec Supabase (source de vérité)
    try {
      const { data, error } = await supabaseClient
        .from('app_data')
        .select('*')
        .in('id', keys);

      if (error) throw error;

      keys.forEach(k => {
        const row = data && data.find(r => r.id === k);
        if (row) {
          this._cache[k] = row.data;
          localStorage.setItem('cache_' + k, JSON.stringify(row.data));
        }
      });
      this._setStatus('● Connecté', true);
    } catch (e) {
      console.error('RemoteStore.init error:', e);
      this._setStatus('● Hors-ligne (cache local)', false);
    }

    this._ready = true;
  },

  get(key, fallback) {
    return this._cache[key] !== undefined ? this._cache[key] : fallback;
  },

  // Écrit en cache immédiatement (synchrone) puis pousse vers Supabase (async, fire-and-forget)
  set(key, value) {
    this._cache[key] = value;
    localStorage.setItem('cache_' + key, JSON.stringify(value));

    supabaseClient
      .from('app_data')
      .upsert({ id: key, data: value, updated_at: new Date().toISOString() })
      .then(({ error }) => {
        if (error) {
          console.error('RemoteStore.set error:', error);
          this._setStatus('● Erreur de sauvegarde', false);
        } else {
          this._setStatus('● Connecté', true);
        }
      });
  }
};
