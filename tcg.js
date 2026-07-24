// ==========================================================
// PHX — TCG — Logique front (boosters + collection)
// Nécessite : config.js (supabaseClient) chargé AVANT ce fichier,
// et un utilisateur déjà connecté (redirection gérée par nav.js
// comme sur le reste du site).
// ==========================================================

let nextSlotAt = null; // Date JS du prochain créneau, pour le countdown

async function authHeader() {
  const { data } = await supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('not-authenticated');
  return { Authorization: `Bearer ${token}` };
}

// ---------- Statut boosters ----------

async function refreshStatus() {
  try {
    const headers = await authHeader();
    const res = await fetch('/api/tcg?action=status', { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');

    document.getElementById('unopenedCount').textContent = data.unopenedCount;
    document.getElementById('unopenedPlural').textContent = data.unopenedCount > 1 ? 's' : '';

    const openBtn = document.getElementById('openBoosterBtn');
    openBtn.disabled = data.unopenedCount <= 0;

    const claimBtn = document.getElementById('claimBtn');
    const claimText = document.getElementById('claimStatusText');
    const boosterCard = document.getElementById('boosterCardTop');

    if (data.currentSlotClaimed) {
      claimBtn.disabled = true;
      claimText.textContent = `Booster de ${data.slotTime} déjà récupéré ✓`;
      boosterCard.classList.remove('pulse');
    } else {
      claimBtn.disabled = false;
      claimText.textContent = `Booster de ${data.slotTime} disponible !`;
      boosterCard.classList.add('pulse');
    }

    // "2026-07-24T12:00:00" est en heure de Paris ; on laisse le
    // navigateur l'interpréter tel quel (assez proche pour un simple
    // countdown, l'écart heure d'été/hiver éventuel est de l'ordre de
    // la minute et sans impact réel ici).
    nextSlotAt = new Date(data.nextSlotLocalStr);
  } catch (e) {
    console.error('refreshStatus error:', e);
    document.getElementById('claimStatusText').textContent = 'Connecte-toi pour voir tes boosters.';
  }
}

function tickCountdown() {
  const el = document.getElementById('countdown');
  if (!nextSlotAt) return;
  const diff = nextSlotAt.getTime() - Date.now();
  if (diff <= 0) {
    el.textContent = 'Nouveau créneau disponible !';
    refreshStatus();
    return;
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  el.textContent = `Prochain créneau dans ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
setInterval(tickCountdown, 1000);

// ---------- Claim ----------

document.getElementById('claimBtn').addEventListener('click', async () => {
  const btn = document.getElementById('claimBtn');
  btn.disabled = true;
  try {
    const headers = await authHeader();
    const res = await fetch('/api/tcg?action=claim', { method: 'POST', headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    await refreshStatus();
  } catch (e) {
    console.error('claim error:', e);
    alert("Impossible de récupérer le booster : " + e.message);
    btn.disabled = false;
  }
});

// ---------- Ouverture de booster ----------

const RARITY_LABELS = {
  rare: 'Rare',
  rare_holo: 'Rare Holo',
  ultra_double: 'Ultra/Double Rare',
  secret_special: 'Rare Secrète',
};

document.getElementById('openBoosterBtn').addEventListener('click', async () => {
  const btn = document.getElementById('openBoosterBtn');
  btn.disabled = true;
  try {
    const headers = await authHeader();
    const res = await fetch('/api/tcg?action=open', { method: 'POST', headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    showOpening(data.cards);
    await refreshStatus();
  } catch (e) {
    console.error('open error:', e);
    alert("Impossible d'ouvrir de booster : " + e.message);
  } finally {
    btn.disabled = false;
  }
});

function showOpening(cards) {
  const overlay = document.getElementById('openingOverlay');
  const stage = document.getElementById('openingStage');
  stage.innerHTML = '';

  cards.forEach((card, i) => {
    const wrap = document.createElement('div');
    wrap.className = `reveal-card${card.tier ? ' tier-' + card.tier : ''}`;
    wrap.innerHTML = `
      <div class="face back">📦</div>
      <div class="face front">
        <img src="${card.imageLarge || card.imageSmall || ''}" alt="${card.name}" loading="lazy">
      </div>
    `;
    wrap.title = `${card.name} — ${card.rarity || ''}`;
    stage.appendChild(wrap);

    // Révélation en cascade, légèrement décalée par carte
    setTimeout(() => wrap.classList.add('flipped'), 300 + i * 220);
  });

  overlay.classList.add('active');
}

document.getElementById('openingClose').addEventListener('click', () => {
  document.getElementById('openingOverlay').classList.remove('active');
});

// ---------- Collection ----------

async function loadSets() {
  const select = document.getElementById('setSelect');
  try {
    const res = await fetch('/api/tcg?action=sets');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    (data.sets || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.series})`;
      select.appendChild(opt);
    });
  } catch (e) {
    console.error('loadSets error:', e);
    const opt = document.createElement('option');
    opt.textContent = 'Erreur de chargement des sets — vérifie POKEMON_TCG_API_KEY';
    opt.disabled = true;
    select.appendChild(opt);
  }
}

document.getElementById('setSelect').addEventListener('change', async (e) => {
  const setId = e.target.value;
  const grid = document.getElementById('cardGrid');
  const progress = document.getElementById('collectionProgress');
  if (!setId) { grid.innerHTML = ''; progress.textContent = ''; return; }

  grid.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Chargement…</p>';
  try {
    const headers = await authHeader();
    const res = await fetch(`/api/tcg?action=collection&setId=${encodeURIComponent(setId)}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');

    const owned = data.cards.filter(c => c.quantity > 0).length;
    progress.innerHTML = `<strong>${owned}</strong> / ${data.cards.length} cartes`;

    grid.innerHTML = '';
    data.cards.forEach(card => {
      const div = document.createElement('div');
      div.className = `tcg-card${card.quantity > 0 ? '' : ' missing'}`;
      div.innerHTML = `
        <img src="${card.imageSmall || ''}" alt="${card.name}" loading="lazy">
        ${card.quantity > 1 ? `<span class="qty-badge">x${card.quantity}</span>` : ''}
      `;
      div.title = card.name;
      grid.appendChild(div);
    });
  } catch (e) {
    console.error('load collection error:', e);
    grid.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Erreur de chargement.</p>';
  }
});

// ---------- Init ----------

refreshStatus();
loadSets();
