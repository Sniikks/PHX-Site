// ==========================================================
// PHX — TCG — GET /api/tcg-sets
// ==========================================================
// Liste tous les sets Pokémon (pour le sélecteur de la page
// collection). Route publique (pas besoin d'auth), fortement
// cachée côté CDN car ces données changent rarement (nouveau set
// tous les 2-3 mois).
// ==========================================================

module.exports = async function handler(req, res) {
  try {
    const response = await fetch('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250', {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
    });
    if (!response.ok) throw new Error(`pokemontcg.io ${response.status}`);
    const data = await response.json();

    const sets = (data.data || []).map(s => ({
      id: s.id,
      name: s.name,
      series: s.series,
      releaseDate: s.releaseDate,
      total: s.total,
      symbol: s.images?.symbol || null,
      logo: s.images?.logo || null,
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ sets });
  } catch (e) {
    console.error('tcg-sets error:', e);
    return res.status(502).json({ error: 'Impossible de récupérer les sets.' });
  }
};
