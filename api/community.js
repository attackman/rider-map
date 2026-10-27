// Vercel serverless function: /api/community
//   GET   -> places riders reported closed (with counts) and places riders added
//   POST  -> save one of:
//            { type: 'closed',   name, lat, lng }                    "Closed for good"
//            { type: 'missing',  name, category, note, lat, lng }    "Add a missing place"
//            { type: 'feedback', message, contact }                  "Send feedback"
//            { type: 'event',    event }                             anonymous feature count
// Stored in the free Supabase database "askgowhere" (SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY in Vercel).
// The database only allows adding rows: nobody can change or delete them through the app,
// and feedback and counts can only be read by the owner in the Supabase dashboard.

const CATEGORIES = ['Shop', 'Food', 'Office', 'Condo or HDB gate', 'Loading bay', 'Rider waiting area', 'Other'];

function inSingapore(lat, lng) {
  return lat > 1.15 && lat < 1.48 && lng > 103.59 && lng < 104.1;
}

// Plain text only: no control characters, single spaces, limited length
function clean(text, max) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function supabase(path, options = {}) {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!base || !key) {
    throw Object.assign(new Error('Community features are not set up yet.'), { status: 503 });
  }
  const headers = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, options.headers || {});
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // older-style keys need this too
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(base + '/rest/v1/' + path, Object.assign({}, options, { headers, signal: controller.signal }));
    if (!resp.ok) throw Object.assign(new Error('Database said no (status ' + resp.status + ')'), { status: 502 });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function simple(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function metresApart(a, b) {
  const dLat = (a.lat - b.lat) * 110574;
  const dLng = (a.lng - b.lng) * 111289;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Group reports of the same place (same name within 80 m) and count them
function group(rows) {
  const out = [];
  for (const r of rows) {
    const hit = out.find((g) => simple(g.name) === simple(r.name) && metresApart(g, r) < 80);
    if (hit) { hit.count++; continue; }
    out.push({ name: r.name, category: r.category || null, note: r.note || null,
               lat: r.lat, lng: r.lng, count: 1, last: r.created_at });
  }
  return out;
}

async function readCommunity(res) {
  const resp = await supabase('place_reports?select=kind,name,category,note,lat,lng,created_at'
    + '&created_at=gte.' + new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
    + '&order=created_at.desc&limit=3000');
  const rows = await resp.json();
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    closed: group(rows.filter((r) => r.kind === 'closed')).map(({ name, lat, lng, count, last }) => ({ name, lat, lng, count, last })),
    missing: group(rows.filter((r) => r.kind === 'missing'))
  });
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

async function save(req, res) {
  const b = readBody(req);
  if (b.website) return res.status(200).json({ ok: true }); // a hidden field only robots fill in

  let table, row;
  if (b.type === 'closed' || b.type === 'missing') {
    const lat = Number(b.lat), lng = Number(b.lng);
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Please give the place a name.' });
    if (!inSingapore(lat, lng)) return res.status(400).json({ error: 'That spot is not in Singapore.' });
    table = 'place_reports';
    row = { kind: b.type, name, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    if (b.type === 'missing') {
      row.category = CATEGORIES.includes(b.category) ? b.category : 'Other';
      row.note = clean(b.note, 200) || null;
    }
  } else if (b.type === 'feedback') {
    const message = clean(b.message, 2000);
    if (!message) return res.status(400).json({ error: 'Please write a message.' });
    table = 'feedback';
    row = { message, contact: clean(b.contact, 120) || null, app_version: clean(b.version, 40) || null };
  } else if (b.type === 'event') {
    const name = String(b.event || '');
    if (!/^[a-z_:]{2,40}$/.test(name)) return res.status(400).json({ error: 'Unknown event' });
    table = 'usage_events';
    row = { name };
  } else {
    return res.status(400).json({ error: 'Unknown request' });
  }

  await supabase(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') return await save(req, res);
    if (req.method === 'GET') return await readCommunity(res);
    return res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.name === 'AbortError' ? 'The database took too long to answer' : err.message
    });
  }
};

module.exports.CATEGORIES = CATEGORIES;
