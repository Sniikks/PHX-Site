// api/steam.js
// Relais côté serveur vers l'API Steam (évite le blocage CORS côté navigateur).
// Appel : /api/steam?appid=1888930
// Réponse : { "name": "...", "src": "https://..." } déjà au format utilisé par le site.

export default async function handler(req, res) {
  const appid = String(req.query.appid || '').replace(/\D/g, '');

  if (!appid) {
    res.status(400).json({ error: 'Paramètre appid manquant ou invalide.' });
    return;
  }

  try {
    const steamRes = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}`
    );

    if (!steamRes.ok) {
      res.status(502).json({ error: 'Steam a répondu avec une erreur.' });
      return;
    }

    const json = await steamRes.json();
    const entry = json[appid];

    if (!entry || !entry.success || !entry.data) {
      res.status(404).json({ error: "Jeu introuvable sur Steam pour cet ID." });
      return;
    }

    res.status(200).json({
      name: entry.data.name,
      // Même format que le reste de ta liste de jeux.
      src: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur lors de la récupération des données Steam.' });
  }
}
