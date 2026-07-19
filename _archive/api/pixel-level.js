import { getAdmin, verifyUser, pickGame, gameYear, imgCover2x, seedFrom, norm } from "./_lib/util.js";

const inflight = new Map(); // un seul joueur génère un niveau donné à la fois

export default async function handler(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: "connexion requise" });

    const level = Math.max(1, Math.min(100000, parseInt(req.query.level, 10) || 1));
    const admin = getAdmin();

    const { data: existing } = await admin.from("pixel_levels").select("*").eq("level", level).maybeSingle();
    if (existing) return res.status(200).json(existing);

    if (!inflight.has(level)) {
      inflight.set(level, buildLevel(admin, level).finally(() => inflight.delete(level)));
    }
    await inflight.get(level);

    const { data: fresh } = await admin.from("pixel_levels").select("*").eq("level", level).maybeSingle();
    if (!fresh) return res.status(503).json({ error: "niveau en cours de génération — réessaie dans quelques secondes" });
    return res.status(200).json(fresh);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "génération du niveau impossible", detail: String(e.message || e) });
  }
}

async function buildLevel(admin, level) {
  const rand = seedFrom(`phx-pixel-${level}`);
  const g = await pickGame(rand);
  if (!g) return;

  const row = {
    level,
    titre: g.name,
    titre_norm: norm(g.name),
    annee: gameYear(g),
    igdb_id: g.id,
    image_url: imgCover2x(g.cover.image_id), // jaquette, comme le site de référence
    meta: {},
  };
  // idempotent : deux joueurs peuvent demander le même niveau en même temps
  await admin.from("pixel_levels").upsert(row, { onConflict: "level", ignoreDuplicates: true });
}
