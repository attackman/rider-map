// Vercel serverless function: /api/search?q=mcdonalds bedok&lat=1.35&lng=103.94
// Searches two free sources at the same time and merges the answers:
//   1. OneMap (Singapore government): addresses, postal codes, buildings, malls.
//      Logs in with ONEMAP_EMAIL / ONEMAP_PASSWORD from Vercel environment variables.
//   2. Photon (OpenStreetMap data, no key): shops, food places and other businesses,
//      favouring ones near lat/lng (the middle of the map on the phone).
// If one source fails, results from the other are still returned.

let cachedToken = null;
let tokenExpiresAt = 0; // milliseconds

async function getToken(forceNew = false) {
  const now = Date.now();
  if (!forceNew && cachedToken && now < tokenExpiresAt - 60 * 60 * 1000) {
    return cachedToken;
  }
  const email = process.env.ONEMAP_EMAIL;
  const password = process.env.ONEMAP_PASSWORD;
  if (!email || !password) {
    throw new Error('ONEMAP_EMAIL or ONEMAP_PASSWORD is not set in Vercel');
  }
  const resp = await fetch('https://www.onemap.gov.sg/api/auth/post/getToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!resp.ok) {
    throw new Error('OneMap login failed (status ' + resp.status + '). Check the email and password in Vercel.');
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  const expirySeconds = Number(data.expiry_timestamp);
  tokenExpiresAt = expirySeconds ? expirySeconds * 1000 : now + 2 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

// Give up on a slow source after a few seconds so search never hangs
async function fetchWithTimeout(url, options = {}, ms = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 1. OneMap: places and addresses ----------
async function searchOneMap(query) {
  const url = 'https://www.onemap.gov.sg/api/common/elastic/search'
    + '?searchVal=' + encodeURIComponent(query)
    + '&returnGeom=Y&getAddrDetails=Y&pageNum=1';
  let token = await getToken();
  let resp = await fetchWithTimeout(url, { headers: { Authorization: token } });
  if (resp.status === 401 || resp.status === 403) {
    token = await getToken(true);
    resp = await fetchWithTimeout(url, { headers: { Authorization: token } });
  }
  if (!resp.ok) throw new Error('OneMap search failed (status ' + resp.status + ')');
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    name: r.SEARCHVAL,
    address: r.ADDRESS,
    category: null,
    lat: Number(r.LATITUDE),
    lng: Number(r.LONGITUDE)
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// ---------- 2. Photon: shops, food and businesses ----------
const BUSINESS_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare'];
const NOT_BUSINESSES = [
  'parking', 'parking_entrance', 'parking_space', 'bicycle_parking', 'motorcycle_parking',
  'bench', 'waste_basket', 'waste_disposal', 'recycling', 'toilets', 'shelter',
  'drinking_water', 'fountain', 'clock', 'telephone', 'post_box', 'grave_yard', 'picnic_table'
];
const NICE_NAMES = {
  mall: 'Shopping centre', department_store: 'Department store', supermarket: 'Supermarket',
  convenience: 'Convenience store', fast_food: 'Fast food', food_court: 'Food court / hawker',
  restaurant: 'Restaurant', cafe: 'Cafe', bakery: 'Bakery', marketplace: 'Market',
  pharmacy: 'Pharmacy', chemist: 'Pharmacy', bank: 'Bank', atm: 'ATM', fuel: 'Petrol station',
  clinic: 'Clinic', doctors: 'Clinic', hospital: 'Hospital', hotel: 'Hotel',
  mobile_phone: 'Phone shop', hairdresser: 'Hairdresser', bubble_tea: 'Bubble tea'
};

function niceCategory(value) {
  if (!value) return 'Business';
  if (NICE_NAMES[value]) return NICE_NAMES[value];
  const words = String(value).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function searchPhoton(query, lat, lng) {
  let url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(query)
    + '&limit=15&lang=en&bbox=103.59,1.15,104.10,1.48';
  if (lat != null && lng != null) url += '&lat=' + lat + '&lon=' + lng;
  const resp = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'RiderMapSG/1.0 (+https://rider-map-theta.vercel.app)' }
  });
  if (!resp.ok) throw new Error('Business search failed (status ' + resp.status + ')');
  const data = await resp.json();

  const out = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const coords = f.geometry && f.geometry.coordinates;
    if (!p.name || !coords) continue;
    if (p.countrycode && p.countrycode !== 'SG') continue;
    if (!BUSINESS_KEYS.includes(p.osm_key) || NOT_BUSINESSES.includes(p.osm_value)) continue;

    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const address = [street, p.postcode ? 'Singapore ' + p.postcode : (p.district || p.city || '')]
      .filter(Boolean).join(', ');
    out.push({
      name: p.name,
      address: address || 'Singapore',
      category: niceCategory(p.osm_value),
      lat: Number(coords[1]),
      lng: Number(coords[0])
    });
  }
  return out.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// ---------- merging ----------
function metresApart(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function simple(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function samePlace(a, b) {
  const x = simple(a.name), y = simple(b.name);
  return metresApart(a, b) < 80 && x && y && (x.includes(y) || y.includes(x));
}

function merge(places, businesses) {
  const uniqueBusinesses = [];
  for (const b of businesses) {
    if (places.some((p) => samePlace(p, b))) continue;
    if (uniqueBusinesses.some((u) => samePlace(u, b))) continue;
    uniqueBusinesses.push(b);
  }
  const placeCount = uniqueBusinesses.length ? 4 : 8;
  return [...places.slice(0, placeCount), ...uniqueBusinesses.slice(0, 6)].slice(0, 10);
}

function readCoord(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > min && n < max ? Number(n.toFixed(2)) : null;
}

module.exports = async (req, res) => {
  const query = req.query || {};
  const q = String(query.q || '').trim().slice(0, 100);
  if (q.length < 2) {
    return res.status(200).json({ results: [] });
  }
  const lat = readCoord(query.lat, 1.1, 1.5);
  const lng = readCoord(query.lng, 103.5, 104.2);
  const isPostalCode = /^\d{6}$/.test(q);

  const [placesResult, businessResult] = await Promise.allSettled([
    searchOneMap(q),
    isPostalCode ? Promise.resolve([]) : searchPhoton(q, lat, lng)
  ]);

  if (placesResult.status === 'rejected' && businessResult.status === 'rejected') {
    return res.status(502).json({ error: placesResult.reason.message });
  }

  const places = placesResult.status === 'fulfilled' ? placesResult.value : [];
  const businesses = businessResult.status === 'fulfilled' ? businessResult.value : [];

  // Keep full answers for a day; if a source failed, only briefly so it retries soon
  const allOk = placesResult.status === 'fulfilled' && businessResult.status === 'fulfilled';
  res.setHeader('Cache-Control', allOk ? 's-maxage=86400' : 's-maxage=60');
  return res.status(200).json({ results: merge(places, businesses) });
};
