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
  return (data.results || []).map((r) => {
    // An HDB block or other building with no name: call it "BLK 298 TAMPINES STREET 22"
    const blk = String(r.BLK_NO || '').trim();
    const unnamed = !r.BUILDING || r.BUILDING === 'NIL' || r.SEARCHVAL === r.ADDRESS;
    const road = String(r.ROAD_NAME || '').trim();
    return {
      name: blk && road && unnamed ? 'BLK ' + blk + ' ' + road : r.SEARCHVAL,
      address: r.ADDRESS,
      category: null,
      blk: blk.toUpperCase(),
      lat: Number(r.LATITUDE),
      lng: Number(r.LONGITUDE)
    };
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// ---------- short forms Singaporeans use ----------
// "SNEC" -> "Singapore National Eye Centre". OneMap only knows most places by their full name.
const PLACE_ALIASES = {
  // hospitals and health
  sgh: 'singapore general hospital', snec: 'singapore national eye centre', nuh: 'national university hospital',
  ttsh: 'tan tock seng hospital', cgh: 'changi general hospital', ktph: 'khoo teck puat hospital',
  kkh: "kk women's and children's hospital", skh: 'sengkang general hospital', skgh: 'sengkang general hospital',
  ntfgh: 'ng teng fong general hospital', imh: 'institute of mental health', nccs: 'national cancer centre singapore',
  nhcs: 'national heart centre singapore', ndcs: 'national dental centre singapore', nni: 'national neuroscience institute',
  jch: 'jurong community hospital', ych: 'yishun community hospital', ojch: 'outram community hospital',
  // universities, polytechnics, schools
  nus: 'national university of singapore', ntu: 'nanyang technological university', smu: 'singapore management university',
  sutd: 'singapore university of technology and design', sit: 'singapore institute of technology',
  suss: 'singapore university of social sciences', np: 'ngee ann polytechnic', sp: 'singapore polytechnic',
  tp: 'temasek polytechnic', rp: 'republic polytechnic', nyp: 'nanyang polytechnic', nafa: 'nanyang academy of fine arts',
  // government offices
  ica: 'ica building', mom: 'ministry of manpower', cpf: 'cpf building', hdb: 'hdb hub', iras: 'revenue house',
  ura: 'ura centre', nlb: 'national library', scdf: 'scdf headquarters',
  // malls, attractions, landmarks
  mbs: 'marina bay sands', rws: 'resorts world sentosa', gbtb: 'gardens by the bay', plq: 'paya lebar quarter',
  jp: 'jurong point', cwp: 'causeway point', mbfc: 'marina bay financial centre', cq: 'clarke quay',
  hv: 'holland village', sbg: 'singapore botanic gardens', ecp: 'east coast park', wcp: 'west coast park',
  t1: 'changi airport terminal 1', t2: 'changi airport terminal 2', t3: 'changi airport terminal 3', t4: 'changi airport terminal 4',
  // towns
  amk: 'ang mo kio', tpy: 'toa payoh', cck: 'choa chu kang', bbt: 'bukit batok', bp: 'bukit panjang', jw: 'jurong west',
  je: 'jurong east', pr: 'pasir ris', sk: 'sengkang', pg: 'punggol', ys: 'yishun', wl: 'woodlands', ctrl: 'central'
};
// short forms that are also normal words in other searches: only expand when typed alone or first
const TOWN_ONLY_FIRST = new Set(['bp', 'jw', 'je', 'pr', 'sk', 'pg', 'ys', 'wl', 'ctrl', 'np', 'sp', 'tp', 'rp', 'jp', 'hv', 'cq', 'mom', 'sit', 'ica', 'cpf', 'hdb', 'ura']);

// Returns the search with short forms spelled out, or null if there's nothing to expand
function expandAliases(q) {
  const words = String(q).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let changed = false;
  const out = words.map((w, i) => {
    const full = PLACE_ALIASES[w];
    if (!full) return w;
    if (TOWN_ONLY_FIRST.has(w) && i > 0) return w;
    changed = true;
    return full;
  });
  return changed ? out.join(' ') : null;
}

// ---------- understanding how riders type addresses ----------
// "Tampines Blk 298", "blk 298 tampines", "Tampines 298", "298 tampines st 22 #05-123"
// all mean block 298 in Tampines. OneMap understands "298 TAMPINES STREET 22", so rewrite to that.
const ROAD_WORDS = {
  st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue', rd: 'road', road: 'road', dr: 'drive', drive: 'drive',
  cres: 'crescent', crescent: 'crescent', ctrl: 'central', central: 'central', nth: 'north', north: 'north',
  sth: 'south', south: 'south', east: 'east', west: 'west', jln: 'jalan', jalan: 'jalan', lor: 'lorong', lorong: 'lorong',
  bt: 'bukit', upp: 'upper', lwr: 'lower', pl: 'place', place: 'place', cl: 'close', close: 'close', ln: 'lane', lane: 'lane',
  lk: 'link', link: 'link', walk: 'walk', way: 'way', ter: 'terrace', terrace: 'terrace', vw: 'view', view: 'view',
  rise: 'rise', ring: 'ring', hts: 'heights', heights: 'heights', pk: 'park', sq: 'square', tg: 'tanjong', kg: 'kampong',
  amk: 'ang mo kio', tpy: 'toa payoh', cck: 'choa chu kang', bbt: 'bukit batok'
};
// a number straight after one of these is a street number ("street 22"), not a block
const NUMBERED_ROADS = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'cres', 'crescent', 'ctrl', 'central',
  'lor', 'lorong', 'north', 'nth', 'south', 'sth', 'east', 'west', 'link', 'lk', 'close', 'cl', 'lane', 'ln', 'way', 'walk',
  'place', 'pl', 'ring', 'view', 'terrace', 'ter', 'sector', 'level', 'lvl', 'floor', 'unit', 'no']);

function addressQuery(q) {
  let s = ' ' + String(q).toLowerCase() + ' ';
  s = s.replace(/#\s*[a-z]?\d{1,3}\s*-\s*\d{1,5}[a-z]?/g, ' ')   // unit numbers like #05-123
       .replace(/\bsingapore\b|\bs\(\d{6}\)/g, ' ')
       .replace(/[,.()]/g, ' ');
  let blk = null;
  const named = s.match(/\b(?:blk|block|bk|blok)\s*(\d{1,4}[a-z]?)\b/);
  if (named) {
    blk = named[1];
    s = s.replace(named[0], ' ');
  }
  let words = s.split(/\s+/).filter(Boolean);
  if (!blk) {
    const i = words.findIndex((w, k) => /^\d{1,4}[a-z]?$/.test(w) && !(k > 0 && NUMBERED_ROADS.has(words[k - 1])));
    if (i < 0 || words.length < 2) return null;
    blk = words[i];
    words.splice(i, 1);
  }
  words = words.filter((w) => !['blk', 'block', 'bk', 'hdb', 'flat'].includes(w)).map((w) => ROAD_WORDS[w] || w);
  return { blk: blk.toUpperCase(), area: words.join(' '), query: (blk + ' ' + words.join(' ')).trim() };
}

// Ask OneMap the rider's words and the rewritten address; matching blocks first,
// and with no area given ("blk 298"), the nearest ones first
async function searchPlaces(q, lat, lng) {
  const full = expandAliases(q);                 // "snec" -> "singapore national eye centre"
  const aq = addressQuery(full || q);            // "tampines blk 298" -> "298 tampines"
  const asks = [full, aq && aq.query].filter((x, i, a) => x && x !== q.toLowerCase().trim() && a.indexOf(x) === i);
  if (!asks.length) return searchOneMap(q);
  // Ask OneMap every reading at once: spelled-out name, then the block address, then the rider's own words
  const answers = await Promise.allSettled([...asks, q].map((x) => searchOneMap(x)));
  if (answers.every((a) => a.status === 'rejected')) throw answers[0].reason;
  const out = [];
  for (const a of answers) {
    if (a.status !== 'fulfilled') continue;
    for (const r of a.value) {
      if (!out.some((o) => o.address === r.address && Math.abs(o.lat - r.lat) < 1e-5)) out.push(r);
    }
  }
  if (full && !aq) {
    // The place itself before things inside it: "Singapore General Hospital" before "SGH Blk 4 (Taxi Stand)"
    const want = full.toUpperCase();
    const rank = (r) => (String(r.name).toUpperCase().startsWith(want) ? 0 : String(r.name).toUpperCase().includes(want) ? 1 : 2);
    return out.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i).map((x) => x.r);
  }
  if (!aq) return out;
  // A block address: the matching block first; with no area given ("blk 298"), the nearest first
  const here = lat != null && lng != null ? { lat, lng } : null;
  const score = (r) => (r.blk === aq.blk ? 0 : 1) * 1e7 + (here && !aq.area ? metresApart(r, here) : 0);
  return out.map((r, i) => ({ r, i })).sort((x, y) => score(x.r) - score(y.r) || x.i - y.i).map((x) => x.r);
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
    headers: { 'User-Agent': 'RiderKaki/1.0 (+https://rider-map-theta.vercel.app)' }
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

function merge(places, businesses, looksLikeAddress) {
  const uniqueBusinesses = [];
  for (const b of businesses) {
    if (places.some((p) => samePlace(p, b))) continue;
    if (uniqueBusinesses.some((u) => samePlace(u, b))) continue;
    uniqueBusinesses.push(b);
  }
  const placeCount = uniqueBusinesses.length ? (looksLikeAddress ? 6 : 4) : 8;
  return [...places.slice(0, placeCount), ...uniqueBusinesses.slice(0, looksLikeAddress ? 3 : 6)].slice(0, 10)
    .map(({ blk, ...r }) => r);
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
    isPostalCode ? searchOneMap(q) : searchPlaces(q, lat, lng),
    isPostalCode ? Promise.resolve([]) : searchPhoton(expandAliases(q) || q, lat, lng)
  ]);

  if (placesResult.status === 'rejected' && businessResult.status === 'rejected') {
    return res.status(502).json({ error: placesResult.reason.message });
  }

  const places = placesResult.status === 'fulfilled' ? placesResult.value : [];
  const businesses = businessResult.status === 'fulfilled' ? businessResult.value : [];

  // Keep full answers for a day; if a source failed, only briefly so it retries soon
  const allOk = placesResult.status === 'fulfilled' && businessResult.status === 'fulfilled';
  res.setHeader('Cache-Control', allOk ? 's-maxage=86400' : 's-maxage=60');
  const full = expandAliases(q);
  return res.status(200).json({ results: merge(places, businesses, !!addressQuery(q)), ...(full ? { searchedFor: full } : {}) });
};

module.exports.addressQuery = addressQuery;
module.exports.expandAliases = expandAliases;
