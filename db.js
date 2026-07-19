// ==========================================================
// RemoteStore — petit magasin clé/valeur JSON
// Stocke des blobs JSON dans une table Supabase dédiée par page
// (id text primaire, data jsonb, updated_at) — chaque appel précise
// SA table (2e argument de init/set/subscribe/unsubscribe). Plus de
// table "app_data" fourre-tout partagée entre toutes les pages.
// Un cache mémoire + localStorage permet un rendu instantané pendant
// que la synchro réseau se fait.
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

  // Table Supabase interrogée par défaut si aucune n'est précisée à l'appel
  // (chaque page appelle désormais init/set/subscribe avec SA propre table —
  // voir le mapping en tête de chaque fichier HTML/API. Ce défaut ne sert
  // que de filet, il ne devrait plus jamais être utilisé en pratique).
  _defaultTable: 'app_data',

  setStatusElement(el) { this._statusEl = el; },

  _setStatus(text, ok) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.style.color = ok ? '#4a9a4a' : '#c94040';
  },

  // Précharge une liste de clés en une seule requête réseau, depuis la
  // table Supabase `table` (une table dédiée par page depuis la migration
  // "une table par page" — plus de fourre-tout "app_data").
  async init(keys, table) {
    table = table || this._defaultTable;
    // 1. Lecture immédiate du cache local (pour affichage instantané hors-ligne)
    keys.forEach(k => {
      const local = localStorage.getItem('cache_' + table + '_' + k);
      if (local) {
        try { this._cache[k] = JSON.parse(local); } catch (e) {}
      }
    });

    // 2. Synchro avec Supabase (source de vérité)
    try {
      const { data, error } = await supabaseClient
        .from(table)
        .select('*')
        .in('id', keys);

      if (error) throw error;

      keys.forEach(k => {
        const row = data && data.find(r => r.id === k);
        if (row) {
          this._cache[k] = row.data;
          localStorage.setItem('cache_' + table + '_' + k, JSON.stringify(row.data));
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
  set(key, value, table) {
    table = table || this._defaultTable;
    this._cache[key] = value;
    localStorage.setItem('cache_' + table + '_' + key, JSON.stringify(value));
    this._push(key, value, table);
  },

  _push(key, value, table) {
    table = table || this._defaultTable;
    supabaseClient
      .from(table)
      .upsert({ id: key, data: value, updated_at: new Date().toISOString() })
      .then(({ error }) => {
        if (error) {
          console.error('RemoteStore.set error:', error);
          this._queueRetry(key, value, table);
        } else {
          delete this._pendingWrites[table + '::' + key];
          this._retryDelay = 3000; // reset du backoff après un succès
          this._setStatus('● Connecté', true);
        }
      });
  },

  _queueRetry(key, value, table) {
    this._pendingWrites[table + '::' + key] = { key, value, table };
    this._setStatus('● Sauvegarde en attente…', false);
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._retryDelay = Math.min(this._retryDelay * 2, 60000);
      this._flushPending();
    }, this._retryDelay);
  },

  _flushPending() {
    const entries = Object.values(this._pendingWrites);
    if (entries.length === 0) return;
    // On rejoue toujours la valeur LA PLUS RÉCENTE du cache pour chaque clé
    // (si l'utilisateur a modifié entre-temps, on ne réécrit pas une vieille version).
    entries.forEach(({ key, table }) => this._push(key, this._cache[key], table));
  },

  // Écoute en temps réel les changements distants sur une clé, dans `table`.
  // callback(newValue) est appelé quand quelqu'un d'autre modifie la donnée.
  // Le cache local est mis à jour automatiquement avant l'appel du callback.
  subscribe(key, callback, table) {
    table = table || this._defaultTable;
    const chanKey = table + '::' + key;
    if (this._channels[chanKey]) return; // déjà abonné
    this._channels[chanKey] = supabaseClient
      .channel(table + '_' + key)
      .on('postgres_changes',
        { event: '*', schema: 'public', table, filter: `id=eq.${key}` },
        payload => {
          const newData = payload.new && payload.new.data;
          if (newData === undefined) return;
          this._cache[key] = newData;
          localStorage.setItem('cache_' + table + '_' + key, JSON.stringify(newData));
          if (typeof callback === 'function') callback(newData);
        })
      .subscribe();
  },

  unsubscribe(key, table) {
    table = table || this._defaultTable;
    const chanKey = table + '::' + key;
    if (!this._channels[chanKey]) return;
    supabaseClient.removeChannel(this._channels[chanKey]);
    delete this._channels[chanKey];
  }
};

// Rejoue les écritures en attente dès que la connexion revient.
window.addEventListener('online', () => RemoteStore._flushPending());
