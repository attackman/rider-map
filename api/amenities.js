// Vercel serverless function: /api/amenities
// Toilets, drinking water and shelters across Singapore from OpenStreetMap (free, no key),
// fetched through the Overpass service. The list changes slowly, so one copy is kept
// for a day and shared by every rider.

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const QUERY = '[out:json][timeout:60];('
  + 'node["amenity"~"^(toilets|drinking_water|shelter)$"](1.15,103.59,1.48,104.10);'
  + 'way["amenity"~"^(toilets|shelter)$"](1.15,103.59,1.48,104.10);'
  + ');out center tags;';

async function ask(server) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const resp = await fetch(server, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AskGoWhere/1.0 (+https://rider-map-theta.vercel.app)'
      },
      body: 'data=' + encodeURIComponent(QUERY),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('Map data service failed (status ' + resp.status + ')');
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function read(json) {
  const out = [];
  for (const e of json.elements || []) {
    const tags = e.tags || {};
    const lat = Number(e.lat != null ? e.lat : e.center && e.center.lat);
    const lng = Number(e.lon != null ? e.lon : e.center && e.center.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const kind = tags.amenity === 'toilets' ? 'toilet' : tags.amenity === 'drinking_water' ? 'water' : 'shelter';
    out.push({
      kind,
      name: String(tags.name || tags['name:en'] || '').slice(0, 80),
      busStop: kind === 'shelter' && tags.shelter_type === 'public_transport',
      fee: tags.fee === 'yes' ? true : tags.fee === 'no' ? false : null,
      wheelchair: tags.wheelchair === 'yes',
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6))
    });
    if (out.length >= 12000) break;
  }
  return out;
}

module.exports = async (req, res) => {
  let lastError;
  for (const server of SERVERS) {
    try {
      const places = read(await ask(server));
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ places });
    } catch (err) {
      lastError = err;
    }
  }
  return res.status(502).json({
    error: lastError && lastError.name === 'AbortError' ? 'Map data service took too long' : (lastError ? lastError.message : 'Map data service failed')
  });
};
