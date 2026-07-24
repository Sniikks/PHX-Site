// ==========================================================
// PHX — TCG — POST /api/tcg-claim
// ==========================================================
// Récupère le booster du créneau en cours (00h00 ou 12h00, heure de
// Paris) si il n'a pas déjà été pris. Incrémente l'inventaire de
// boosters non ouverts. Un créneau non récupéré avant le suivant
// est simplement perdu (aucune récupération rétroactive possible,
// par design).
// ==========================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Renvoie { slotDate: 'YYYY-MM-DD', slotTime: '00h00'|'12h00' } pour
// le créneau actuellement en cours, en heure de Paris.
function currentSlot() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type).value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // certains environnements renvoient "24" pour minuit

  return {
    slotDate: `${year}-${month}-${day}`,
    slotTime: hour < 12 ? '00h00' : '12h00',
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide.' });
  }
  const userId = userData.user.id;

  const { slotDate, slotTime } = currentSlot();

  // Le créneau a-t-il déjà été pris ?
  const { data: existing, error: checkError } = await supabaseAdmin
    .from('tcg_claims')
    .select('id')
    .eq('user_id', userId)
    .eq('slot_date', slotDate)
    .eq('slot_time', slotTime)
    .maybeSingle();

  if (checkError) {
    console.error('tcg-claim check error:', checkError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
  if (existing) {
    return res.status(200).json({ claimed: false, alreadyClaimed: true, slotDate, slotTime });
  }

  const { error: insertError } = await supabaseAdmin
    .from('tcg_claims')
    .insert({ user_id: userId, slot_date: slotDate, slot_time: slotTime });

  if (insertError) {
    // Conflit unique = quelqu'un a déjà claim entre-temps (double clic, etc.)
    if (insertError.code === '23505') {
      return res.status(200).json({ claimed: false, alreadyClaimed: true, slotDate, slotTime });
    }
    console.error('tcg-claim insert error:', insertError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  // Incrémente l'inventaire (upsert avec valeur de départ à 0 si 1re fois)
  const { data: inv, error: invReadError } = await supabaseAdmin
    .from('tcg_inventory')
    .select('unopened_count')
    .eq('user_id', userId)
    .maybeSingle();

  if (invReadError) {
    console.error('tcg-claim inventory read error:', invReadError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  const newCount = (inv?.unopened_count || 0) + 1;
  const { error: invWriteError } = await supabaseAdmin
    .from('tcg_inventory')
    .upsert({ user_id: userId, unopened_count: newCount, updated_at: new Date().toISOString() });

  if (invWriteError) {
    console.error('tcg-claim inventory write error:', invWriteError);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }

  return res.status(200).json({ claimed: true, slotDate, slotTime, unopenedCount: newCount });
};
