// Vercel serverless function: /api/weather
// Free NEA data from data.gov.sg (no key needed; an optional DATAGOVSG_API_KEY in Vercel
// gives higher limits). Returns, in one small answer:
//   forecast: the 2-hour forecast for each of Singapore's 47 areas (and whether it is rainy)
//   raining:  rain gauges recording rain in the last 5 minutes
//   heat:     heat stress (WBGT) readings by station: Low / Moderate / High
// If one feed is down, the others are still returned.

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api/';

async function getFeed(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { accept: 'application/json' };
    if (process.env.DATAGOVSG_API_KEY) headers['x-api-key'] = process.env.DATAGOVSG_API_KEY;
    const resp = await fetch(BASE + path, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error('Weather data failed (status ' + resp.status + ')');
    const json = await resp.json();
    if (!json || !json.data) throw new Error('Weather data was empty');
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function isRainy(text) {
  return /rain|shower|thunder|drizzle/i.test(String(text || ''));
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function readForecast(data) {
  const places = {};
  for (const a of data.area_metadata || []) {
    const loc = a.label_location || {};
    places[a.name] = { lat: num(loc.latitude), lng: num(loc.longitude) };
  }
  const item = (data.items || [])[0] || {};
  const period = item.valid_period || {};
  const areas = (item.forecasts || []).map((f) => ({
    name: f.area,
    forecast: f.forecast,
    rain: isRainy(f.forecast),
    lat: places[f.area] ? places[f.area].lat : null,
    lng: places[f.area] ? places[f.area].lng : null
  })).filter((a) => a.lat !== null && a.lng !== null);
  return { validUntil: period.end || null, validText: period.text || null, areas };
}

function readRainfall(data) {
  const stations = {};
  for (const s of data.stations || []) {
    const loc = s.location || {};
    stations[s.id] = { name: s.name, lat: num(loc.latitude), lng: num(loc.longitude) };
  }
  const reading = (data.readings || [])[0] || {};
  return (reading.data || [])
    .filter((r) => num(r.value) > 0 && stations[r.stationId])
    .map((r) => ({ ...stations[r.stationId], mm: num(r.value) }))
    .filter((r) => r.lat !== null && r.lng !== null);
}

function readHeat(data) {
  const record = (data.records || [])[0] || {};
  const readings = (record.item && record.item.readings) || [];
  return readings.map((r) => ({
    name: (r.station && (r.station.townCenter || r.station.name)) || 'Weather station',
    lat: num(r.location && r.location.latitude),
    lng: num(r.location && r.location.longitude),
    wbgt: num(r.wbgt),
    level: r.heatStress || null
  })).filter((r) => r.lat !== null && r.lng !== null && r.level);
}

module.exports = async (req, res) => {
  const [forecast, rainfall, heat] = await Promise.allSettled([
    getFeed('two-hr-forecast'),
    getFeed('rainfall'),
    getFeed('weather?api=wbgt')
  ]);

  if ([forecast, rainfall, heat].every((r) => r.status === 'rejected')) {
    return res.status(502).json({ error: forecast.reason.message });
  }

  const out = {
    forecast: forecast.status === 'fulfilled' ? readForecast(forecast.value) : null,
    raining: rainfall.status === 'fulfilled' ? readRainfall(rainfall.value) : [],
    heat: heat.status === 'fulfilled' ? readHeat(heat.value) : []
  };

  // NEA updates these every 5 to 30 minutes; keep a copy for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json(out);
};
