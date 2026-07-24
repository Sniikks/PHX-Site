// ==========================================================
// PHX — TCG — GET /api/tcg-status
// ==========================================================
// Renvoie l'état courant pour affichage : nombre de boosters non
// ouverts, et si le créneau en cours (00h00 ou 12h00) a déjà été
// récupéré ou non. Le front calcule lui-même le countdown jusqu'au
// prochain créneau à partir de nextSlotAt.
// ==========================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function currentSlotInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find(p => p.type === type).value;
  const year = get('year'), month = get('month'), day = get('day');
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;

  const slotDate = `${year}-${month}-${day}`;
  const slotTime = hour < 12 ? '00h00' : '12h00';

  // Prochain créneau, en ISO UTC, pour le countdown côté client.
  // On construit la date en heure de Paris "naïve" puis on laisse le
  // client afficher le delta — plus simple et robuste que de gérer
  // soi-même les décalages horaires/heure d'été côté serveur.
  const nextHourLocal = hour < 12 ? 12 : 24; // 24 = minuit du jour suivant
  const nextSlotLocalStr = `${year}-${month}-${day}T${String(nextHourLocal).padStart(2, '0')}:00:00`;

  return { slotDate, slotTime, nextSlotLocalStr };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide.' });
  }
  const userId = userData.user.id;

  const { slotDate, slotTime, nextSlotLocalStr } = currentSlotInfo();

  const [{ data: inv }, { data: claim }] = await Promise.all([
    supabaseAdmin.from('tcg_inventory').select('unopened_count').eq('user_id', userId).maybeSingle(),
    supabaseAdmin.from('tcg_claims').select('id').eq('user_id', userId).eq('slot_date', slotDate).eq('slot_time', slotTime).maybeSingle(),
  ]);

  return res.status(200).json({
    unopenedCount: inv?.unopened_count || 0,
    currentSlotClaimed: !!claim,
    slotDate,
    slotTime,
    nextSlotLocalStr, // ex. "2026-07-24T12:00:00" — heure de Paris, sans offset
  });
};
