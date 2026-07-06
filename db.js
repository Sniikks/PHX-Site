// ==========================================================
// RemoteStore — petit magasin clé/valeur JSON
// Stocke des blobs JSON dans la table Supabase "app_data"
// (id text primaire, data jsonb). Un cache mémoire + localStorage
// permet un rendu instantané pendant que la synchro réseau se fait.
//
// Nouveautés :
//  - File de retry : une écriture qui échoue (réseau coupé, etc.)
//    est rejouée automatiquement (backoff + retour en ligne),
//    au lieu d'être perdue silencieusement.
//  - subscribe(key, cb) : écoute en temps réel les modifications
//    faites par d'autres visiteurs sur une clé (évite d'écraser
//    les changements de l'autre avec un vieux cache).
// ==========================================================

const RemoteStore = {
  _cache: {},
  _ready: false,
  _statusEl: null,
  _pendingWrites: {},   // { key: value } — écritures en attente de retry
  _retryTimer: null,
  _retryDelay: 3000,    // backoff : 3s, 6s, 12s… plafonné à 60s
  _channels: {},        // { key: RealtimeChannel }

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

  // Écrit en cache immédiatement (synchrone) puis pousse vers Supabase.
  // En cas d'échec réseau, l'écriture est mise en file et rejouée automatiquement.
  set(key, value) {
    this._cache[key] = value;
    localStorage.setItem('cache_' + key, JSON.stringify(value));
    this._push(key, value);
  },

  _push(key, value) {
    supabaseClient
      .from('app_data')
      .upsert({ id: key, data: value, updated_at: new Date().toISOString() })
      .then(({ error }) => {
        if (error) {
          console.error('RemoteStore.set error:', error);
          this._queueRetry(key, value);
        } else {
          delete this._pendingWrites[key];
          this._retryDelay = 3000; // reset du backoff après un succès
          this._setStatus('● Connecté', true);
        }
      });
  },

  _queueRetry(key, value) {
    this._pendingWrites[key] = value;
    this._setStatus('● Sauvegarde en attente…', false);
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._retryDelay = Math.min(this._retryDelay * 2, 60000);
      this._flushPending();
    }, this._retryDelay);
  },

  _flushPending() {
    const entries = Object.entries(this._pendingWrites);
    if (entries.length === 0) return;
    // On rejoue toujours la valeur LA PLUS RÉCENTE du cache pour chaque clé
    // (si l'utilisateur a modifié entre-temps, on ne réécrit pas une vieille version).
    entries.forEach(([key]) => this._push(key, this._cache[key]));
  },

  // Écoute en temps réel les changements distants sur une clé.
  // callback(newValue) est appelé quand quelqu'un d'autre modifie la donnée.
  // Le cache local est mis à jour automatiquement avant l'appel du callback.
  subscribe(key, callback) {
    if (this._channels[key]) return; // déjà abonné
    this._channels[key] = supabaseClient
      .channel('app_data_' + key)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'app_data', filter: `id=eq.${key}` },
        payload => {
          const newData = payload.new && payload.new.data;
          if (newData === undefined) return;
          this._cache[key] = newData;
          localStorage.setItem('cache_' + key, JSON.stringify(newData));
          if (typeof callback === 'function') callback(newData);
        })
      .subscribe();
  },

  unsubscribe(key) {
    if (!this._channels[key]) return;
    supabaseClient.removeChannel(this._channels[key]);
    delete this._channels[key];
  }
};

// Rejoue les écritures en attente dès que la connexion revient.
window.addEventListener('online', () => RemoteStore._flushPending());
