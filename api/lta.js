// Vercel serverless function:
//   /api/lta?kind=incidents   accidents, breakdowns, road works, road blocks...
//   /api/lta?kind=carparks    live free lots at HDB, URA and LTA car parks (cars and motorcycles)
//   /api/lta?kind=busstops    every bus stop: 5-digit code, name ("Opp Blk 123"), road, location
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
      throw Object.assign(new Error('LTA rejected the key (status ' + resp.status + '). Check LTA_ACCOUNT_KEY in Vercel.'), { status: 502 });
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

// URA's names arrive cut at 22 characters with a stray space ("BEDOK RD FOOD CENTRE O FF ST")
// and end in "OFF ST" (off-street). Rejoin the word, drop "OFF ST", and say it is a car park.
function tidyUraName(name) {
  let n = String(name || '');
  if (n.length > 23 && n[22] === ' ') n = n.slice(0, 22) + n.slice(23);
  n = n.replace(/\s*\bOFF\s+ST\b/ig, '').replace(/\s+/g, ' ').trim();
  if (!/CAR\s*PARK/i.test(n)) n += ' CAR PARK';
  return n;
}

function readCarparks(rows) {
  const out = [];
  for (const r of rows) {
    if (r.LotType !== 'Y' && r.LotType !== 'C') continue;   // motorcycles and cars only
    const [lat, lng] = String(r.Location || '').trim().split(/\s+/).map(Number);
    if (!inSingapore(lat, lng)) continue;
    out.push({
      id: String(r.CarParkID || ''),
      name: (r.Agency === 'URA' ? tidyUraName(r.Development || r.Area) : String(r.Development || r.Area || 'Car park')).slice(0, 120),
      vehicle: r.LotType === 'Y' ? 'motorcycle' : 'car',
      lots: Number(r.AvailableLots) || 0,
      agency: String(r.Agency || ''),
      lat,
      lng
    });
  }
  return out;
}

// Bus interchanges and terminals ("Bedok Int", "Changi Village Ter") get a bigger dot on the map
function isInterchange(name) {
  return /\b(int|interchange|ter|terminal)$/i.test(name);        // at the end, so "Opp Int'l Business Pk" isn't one
}

function readBusStops(rows) {
  const out = [];
  for (const r of rows) {
    const lat = Number(r.Latitude), lng = Number(r.Longitude);
    const code = String(r.BusStopCode || '').trim();
    if (!/^\d{5}$/.test(code) || !inSingapore(lat, lng)) continue;
    const name = String(r.Description || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Bus stop';
    out.push({ code, name, road: String(r.RoadName || '').replace(/\s+/g, ' ').trim().slice(0, 80),
               int: isInterchange(name) ? 1 : 0, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) });
  }
  return out;
}

module.exports = async (req, res) => {
  const kind = (req.query && req.query.kind) || '';
  // Ignore stray spaces, line breaks or quotes picked up when the key was pasted
  const key = String(process.env.LTA_ACCOUNT_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) {
    return res.status(503).json({ error: 'Add your LTA DataMall key in Vercel as LTA_ACCOUNT_KEY.', needsKey: true });
  }
  try {
    if (kind === 'incidents') {
      const rows = await fetchAll('TrafficIncidents', key, 4);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ incidents: readIncidents(rows) });
    }
    if (kind === 'busstops') {
      const rows = await fetchAll('BusStops', key, 14);           // about 5,200 stops, 500 a page
      // Bus stops hardly change: keep a copy for a day, and keep serving it for a week if LTA is down
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ busstops: readBusStops(rows) });
    }
    if (kind === 'carparks') {
      const rows = await fetchAll('CarParkAvailabilityv2', key, 12);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ carparks: readCarparks(rows) });
    }
    return res.status(400).json({ error: 'Ask for kind=incidents, kind=carparks or kind=busstops' });
  } catch (err) {
    console.error('lta error', err && err.message);   // details stay in the Vercel logs
    return res.status(err.status || 500).json({ error: err.name === 'AbortError' ? 'LTA took too long to answer' : 'Live data is not available right now. Please try again.' });
  }
};
module.exports.readBusStops = readBusStops;
