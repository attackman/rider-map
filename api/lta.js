// Vercel serverless function:
//   /api/lta?kind=incidents   accidents, breakdowns, road works, road blocks...
//   /api/lta?kind=carparks    live free lots at HDB, URA and LTA car parks (cars and motorcycles)
//   /api/lta?kind=busstops    every bus stop: 5-digit code, name ("Opp Blk 123"), road, location
//   /api/lta?kind=arrival&stop=84011   live arrival times of every bus service at one stop
//   /api/lta?kind=traffic     how fast expressways and major roads are moving now (speed bands)
//   /api/lta?kind=cameras     live traffic camera photos (expressways, Woodlands and Tuas Checkpoints)
//   /api/lta?kind=floods      PUB flash flood alerts in force now
// Uses LTA DataMall with the free key stored in Vercel as LTA_ACCOUNT_KEY.

const { quickLimit, tooMany } = require('./_security');
const { readCameras, readGovCameras, mergeCameras, readSpeedBands, readFloods } = require('./_roads');

const BASE = 'https://datamall2.mytransport.sg/ltaodataservice/';

function inSingapore(lat, lng) {
  return lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2;
}

// One page (500 records) of a DataMall dataset
async function fetchPage(endpoint, key, page) {
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
  if (resp.status === 404) throw Object.assign(new Error('LTA dataset not found: ' + endpoint), { status: 502, notFound: true });
  if (!resp.ok) throw Object.assign(new Error('LTA data failed (status ' + resp.status + ')'), { status: 502 });
  const json = await resp.json();
  return Array.isArray(json.value) ? json.value : [];
}

// DataMall returns 500 records at a time; keep asking until a short page comes back
async function fetchAll(endpoint, key, maxPages) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(endpoint, key, page);
    all.push(...rows);
    if (rows.length < 500) break;
  }
  return all;
}

// Same, for big datasets (speed bands are tens of thousands of road stretches): several pages
// at a time, stopping at the first short page
async function fetchAllFast(endpoint, key, maxPages, together = 8) {
  const all = [];
  for (let first = 0; first < maxPages; first += together) {
    const pages = [];
    for (let p = first; p < Math.min(first + together, maxPages); p++) pages.push(fetchPage(endpoint, key, p));
    const results = await Promise.all(pages);
    for (const rows of results) all.push(...rows);
    if (results.some((rows) => rows.length < 500)) break;
  }
  return all;
}

// Traffic camera photos from data.gov.sg (no key needed)
async function fetchGovCameras() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch('https://api.data.gov.sg/v1/transport/traffic-images', { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!resp.ok) throw new Error('data.gov.sg cameras failed (status ' + resp.status + ')');
    return readGovCameras(await resp.json());
  } finally {
    clearTimeout(timer);
  }
}

// The newest LTA address first, older ones if LTA hasn't got it
async function firstFound(endpoints, get) {
  let lastError;
  for (const e of endpoints) {
    try { return await get(e); } catch (err) { if (!err.notFound) throw err; lastError = err; }
  }
  throw lastError;
}

// A copy kept inside the function between requests, so extra words in the address (which skip
// Vercel's cache) can't make RiderKaki ask LTA for the same big dataset again and again
const memo = {};
async function remembered(name, maxAgeMs, load) {
  const entry = memo[name] || (memo[name] = { at: 0, value: undefined, pending: null });
  if (entry.value !== undefined && Date.now() - entry.at < maxAgeMs) return entry.value;
  if (entry.pending) return entry.pending;          // someone else is already fetching it
  entry.pending = load()
    .then((value) => { entry.value = value; entry.at = Date.now(); return value; })
    .finally(() => { entry.pending = null; });
  return entry.pending;
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
  // at the end, so "Opp Int'l Business Pk" isn't one; stops near one ("Opp Punggol Int") and
  // ferry or cargo terminals ("Tanah Merah Ferry Ter") are ordinary stops
  return /\b(int|interchange|ter|terminal)$/i.test(name)
    && !/^(opp|aft|bef)\b/i.test(name) && !/\b(ferry|cargo|marine)\b/i.test(name);
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

// One stop's live bus arrivals. LTA's current address first, the older one if that isn't there.
async function fetchArrival(stop, key) {
  for (const path of ['v3/BusArrival', 'BusArrivalv2']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let resp;
    try {
      resp = await fetch(BASE + path + '?BusStopCode=' + stop, { headers: { AccountKey: key, accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 404) continue;
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('LTA rejected the key (status ' + resp.status + ')'), { status: 502 });
    }
    if (!resp.ok) throw Object.assign(new Error('LTA bus arrival failed (status ' + resp.status + ')'), { status: 502 });
    const json = await resp.json();
    json.__source = path;                    // which LTA address answered (shown in a response header)
    return json;
  }
  throw Object.assign(new Error('LTA bus arrival not found'), { status: 502 });
}

const LOADS = { SEA: 'seats', SDA: 'standing', LSD: 'full' };
// Buses whose time is more than a minute ago have left. LTA sometimes sends stale times
// when its live feed has a problem, so those are dropped rather than shown as "Arr".
function readArrival(json, now = Date.now()) {
  const services = (Array.isArray(json && json.Services) ? json.Services : []).map((s) => ({
    no: String(s.ServiceNo || '').trim().slice(0, 6),
    next: [s.NextBus, s.NextBus2, s.NextBus3]
      .filter((b) => b && b.EstimatedArrival && Date.parse(b.EstimatedArrival) > now - 60000)
      .map((b) => ({ at: String(b.EstimatedArrival), load: LOADS[b.Load] || null, live: Number(b.Monitored) === 1 }))
  })).filter((s) => s.no);
  // 2, 14, 14e, 25, 222, 228, then night and special services (NR7, CT8) at the end
  const rank = (no) => /^\d/.test(no) ? parseInt(no, 10) : 100000;
  services.sort((a, b) => rank(a.no) - rank(b.no) || a.no.localeCompare(b.no));
  return services;
}

module.exports = async (req, res) => {
  const kind = (req.query && req.query.kind) || '';
  // Ignore stray spaces, line breaks or quotes picked up when the key was pasted
  const key = String(process.env.LTA_ACCOUNT_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) {
    return res.status(503).json({ error: 'Add your LTA DataMall key in Vercel as LTA_ACCOUNT_KEY.', needsKey: true });
  }
  // Limits per visitor. Extra words in the address skip Vercel's cache, so without these one
  // person could make RiderKaki call LTA over and over and use up the daily quota.
  if (kind !== 'arrival' && !quickLimit(req, 'lta-' + (kind === 'busstops' ? 'busstops' : 'live'), kind === 'busstops' ? 6 : 30, 60000)) {
    return tooMany(res);
  }
  if (kind === 'traffic' && !quickLimit(req, 'lta-traffic', 6, 60000)) return tooMany(res);
  try {
    if (kind === 'incidents') {
      const rows = await fetchAll('TrafficIncidents', key, 4);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ incidents: readIncidents(rows) });
    }
    if (kind === 'arrival') {
      const stop = String((req.query && req.query.stop) || '');
      if (!/^\d{5}$/.test(stop)) return res.status(400).json({ error: 'Bus stop code must be 5 digits' });
      if (!quickLimit(req, 'arrival', 90, 60000)) return tooMany(res);
      const raw = await fetchArrival(stop, key);
      const services = readArrival(raw);
      res.setHeader('X-LTA-Source', raw.__source || '');
      if (!services.some((s) => s.next.length)) console.warn('bus arrival: no times', stop, raw.__source, JSON.stringify(raw).slice(0, 300));
      res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=20');   // LTA updates about every 20 s
      return res.status(200).json({ stop, services });
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
    if (kind === 'traffic') {
      // LTA updates speeds every 5 minutes
      const links = await remembered('traffic', 120000, async () => readSpeedBands(
        await firstFound(['v4/TrafficSpeedBands', 'v3/TrafficSpeedBands', 'TrafficSpeedBandsv2'], (e) => fetchAllFast(e, key, 200))));
      res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');
      return res.status(200).json({ links });
    }
    if (kind === 'cameras') {
      // Photo links stop working after 5 minutes, so keep copies short
      const cameras = await remembered('cameras', 50000, async () => {
        const [lta, gov] = await Promise.all([
          firstFound(['Traffic-Imagesv2', 'Traffic-Images'], (e) => fetchAll(e, key, 2)).then(readCameras).catch(() => []),
          fetchGovCameras().catch((e) => { console.warn('data.gov.sg cameras:', e.name === 'AbortError' ? 'timed out' : e.message); return []; })]);
        if (gov.length < 30) console.warn('data.gov.sg cameras: only', gov.length);
        if (!lta.length && !gov.length) throw Object.assign(new Error('no traffic cameras'), { status: 502 });
        return mergeCameras(lta, gov);
      });
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
      return res.status(200).json({ cameras });
    }
    if (kind === 'floods') {
      const floods = await remembered('floods', 50000, async () => readFloods(await fetchAll('PubFloodAlerts', key, 2)));
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({ floods });
    }
    return res.status(400).json({ error: 'Ask for kind=incidents, kind=carparks, kind=busstops, kind=arrival, kind=traffic, kind=cameras or kind=floods' });
  } catch (err) {
    console.error('lta error', err && err.message);   // details stay in the Vercel logs
    return res.status(err.status || 500).json({ error: err.name === 'AbortError' ? 'LTA took too long to answer' : 'Live data is not available right now. Please try again.' });
  }
};
module.exports.readBusStops = readBusStops;
module.exports.readArrival = readArrival;
