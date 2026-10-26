// Vercel serverless function:
//   /api/lta?kind=incidents   accidents, breakdowns, road works, road blocks...
//   /api/lta?kind=carparks    live free lots at HDB, URA and LTA car parks (cars and motorcycles)
// Uses LTA DataMall with the free key stored in Vercel as LTA_ACCOUNT_KEY.

const BASE = 'https://datamall2.mytransport.sg/ltaodataservice/';

function inSingapore(lat, lng) {
  return lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2;
}

// DataMall returns 500 records at a time; keep asking until a short page comes back
async function fetchAll(endpoint, key, maxPages) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const url = BASE + endpoint + (page ? '?$skip=' + page * 500 : '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let resp;
    try {
      resp = await fetch(url, { headers: { AccountKey: key, accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('LTA rejected the key. Check LTA_ACCOUNT_KEY in Vercel.'), { status: 502 });
    }
    if (!resp.ok) throw Object.assign(new Error('LTA data failed (status ' + resp.status + ')'), { status: 502 });
    const json = await resp.json();
    const rows = Array.isArray(json.value) ? json.value : [];
    all.push(...rows);
    if (rows.length < 500) break;
  }
  return all;
}

function readIncidents(rows) {
  return rows.map((r) => ({
    type: String(r.Type || 'Incident'),
    message: String(r.Message || '').slice(0, 300),
    lat: Number(r.Latitude),
    lng: Number(r.Longitude)
  })).filter((r) => inSingapore(r.lat, r.lng));
}

function readCarparks(rows) {
  const out = [];
  for (const r of rows) {
    if (r.LotType !== 'Y' && r.LotType !== 'C') continue;   // motorcycles and cars only
    const [lat, lng] = String(r.Location || '').trim().split(/\s+/).map(Number);
    if (!inSingapore(lat, lng)) continue;
    out.push({
      id: String(r.CarParkID || ''),
      name: String(r.Development || r.Area || 'Car park').slice(0, 120),
      vehicle: r.LotType === 'Y' ? 'motorcycle' : 'car',
      lots: Number(r.AvailableLots) || 0,
      agency: String(r.Agency || ''),
      lat,
      lng
    });
  }
  return out;
}

module.exports = async (req, res) => {
  const kind = (req.query && req.query.kind) || '';
  const key = process.env.LTA_ACCOUNT_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Add your LTA DataMall key in Vercel as LTA_ACCOUNT_KEY.', needsKey: true });
  }
  try {
    if (kind === 'incidents') {
      const rows = await fetchAll('TrafficIncidents', key, 4);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ incidents: readIncidents(rows) });
    }
    if (kind === 'carparks') {
      const rows = await fetchAll('CarParkAvailabilityv2', key, 12);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ carparks: readCarparks(rows) });
    }
    return res.status(400).json({ error: 'Ask for kind=incidents or kind=carparks' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.name === 'AbortError' ? 'LTA took too long to answer' : err.message });
  }
};
