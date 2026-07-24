// ==========================================================
// auth.js — Comptes utilisateurs (Supabase Auth)
// Remplace le système de code partagé : inscription/connexion par
// email + mot de passe, pseudo obligatoire, email de confirmation
// géré nativement par Supabase (Authentication > Sign In / Providers
// > Email > "Confirm email" doit être activé côté dashboard).
//
// Ne fait AUCUNE hypothèse sur l'UI : ce fichier expose juste des
// fonctions + un système d'écoute (PHXAuth.onChange). L'affichage
// (pastille pseudo, modal connexion/inscription) est dans auth-ui.js.
//
// Charger APRÈS config.js (a besoin de supabaseClient).
// ==========================================================

const PHXAuth = {
  _listeners: [],
  _profile: null, // { username, role } du compte connecté, une fois chargé

  // S'abonner aux changements d'état (connexion, déconnexion, profil chargé).
  // callback reçoit { session, profile } — profile peut être null un court
  // instant après la connexion, le temps de la requête vers la table profiles.
  onChange(callback) {
    this._listeners.push(callback);
  },

  _emit(session) {
    this._listeners.forEach(cb => {
      try { cb({ session, profile: this._profile }); } catch (e) { console.error(e); }
    });
  },

  async _loadProfile(userId) {
    if (!userId) { this._profile = null; return; }
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('username, role')
        .eq('id', userId)
        .single();
      if (error) throw error;
      this._profile = data;
    } catch (e) {
      console.error('PHXAuth: chargement du profil impossible', e);
      this._profile = null;
    }
  },

  isCurator() {
    return this._profile?.role === 'curator';
  },

  // Vérifie si un pseudo est déjà pris (pré-vérification, confort UI —
  // la vraie garantie d'unicité vient de la contrainte SQL "unique").
  async isUsernameTaken(username) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();
    if (error) { console.error(error); return false; }
    return !!data;
  },

  // Inscription. Après appel, Supabase envoie un email de confirmation ;
  // la connexion reste bloquée tant que le lien n'a pas été cliqué.
  async signUp(email, password, username) {
    username = (username || '').trim();
    if (username.length < 3) throw new Error('Le pseudo doit faire au moins 3 caractères.');
    if (!/^[a-zA-Z0-9_\-À-ÿ ]+$/.test(username)) throw new Error('Pseudo invalide (lettres, chiffres, espaces, - et _ uniquement).');

    const taken = await this.isUsernameTaken(username);
    if (taken) throw new Error('Ce pseudo est déjà pris.');

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: window.location.origin + '/index.html'
      }
    });
    if (error) throw new Error(this._friendlyError(error));
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error(this._friendlyError(error));
    await this._loadProfile(data.user?.id);
    this._emit(data.session);
    return data;
  },

  async signOut() {
    await supabaseClient.auth.signOut();
    this._profile = null;
    this._emit(null);
  },

  async resendConfirmation(email) {
    const { error } = await supabaseClient.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin + '/index.html' }
    });
    if (error) throw new Error(this._friendlyError(error));
  },

  _friendlyError(error) {
    const msg = error.message || '';
    if (/already registered|already exists/i.test(msg)) return 'Un compte existe déjà avec cet email.';
    if (/Email not confirmed/i.test(msg)) return "Email pas encore confirmé — clique sur le lien reçu par mail avant de te connecter.";
    if (/Invalid login credentials/i.test(msg)) return 'Email ou mot de passe incorrect.';
    if (/Password should be at least/i.test(msg)) return 'Mot de passe trop court (6 caractères minimum).';
    if (/rate limit/i.test(msg)) return "Trop de tentatives, réessaie dans quelques minutes.";
    return msg || 'Erreur inconnue.';
  },

  async init() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    await this._loadProfile(session?.user?.id);
    this._emit(session);

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      await this._loadProfile(session?.user?.id);
      this._emit(session);
    });
  }
};

PHXAuth.init();
