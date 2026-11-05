// Vercel serverless function: /api/community
//   GET   -> places riders reported closed (with counts) and places riders added
//   POST  -> save one of:
//            { type: 'closed',   name, lat, lng }                    "Closed for good"
//            { type: 'missing',  name, category, note, lat, lng }    "Add a missing place"
//            { type: 'tip',      name, note, lat, lng }              pickup tip on a place ("side door")
//            { type: 'tipflag',  id }                                flag a tip as wrong or rude
//            { type: 'feedback', message, contact }                  "Send feedback"
//            { type: 'event',    event }                             anonymous feature count
// Stored in the free Supabase database "askgowhere" (SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY in Vercel).
// The database only allows adding rows: nobody can change or delete them through the app,
// and feedback and counts can only be read by the owner in the Supabase dashboard.
// Each visitor is limited (see _security.js) and stored only as a one-way scrambled code.

const { visitorCode, dbLimit, tooMany } = require('./_security');

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

// Group reports of the same place (same name within 80 m) and count the different riders.
// Each rider is a scrambled code (never their address); old reports without one count once each.
function group(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const who = r.reporter || 'row' + i;
    const hit = out.find((g) => simple(g.name) === simple(r.name) && metresApart(g, r) < 80);
    if (hit) { hit.riders.add(who); return; }
    out.push({ name: r.name, category: r.category || null, note: r.note || null,
               lat: r.lat, lng: r.lng, riders: new Set([who]), last: r.created_at });
  });
  return out.map(({ riders, ...g }) => Object.assign(g, { count: riders.size }));
}

// "Closed for good" only shows once two different riders say so, so one person can't
// mark a shop closed on everyone's map.
const CLOSED_NEEDS = 2;

// Pickup tips: short, plain and safe to show to every rider
const RUDE = /\b(fuck\w*|shit\w*|bitch\w*|knn|kanina\w*|lanjiao|pukimak|cheebai|chibai)\b/i;
function tipProblem(text) {
  if (text.length < 4) return 'Please write a little more.';
  if (/(https?:\/\/|www\.|\.(com|sg|net|org|io|ly)\b)/i.test(text)) return 'Please leave out links.';
  if (/\S+@\S+\.\S+/.test(text)) return 'Please leave out email addresses.';
  if (/(\+?65[\s-]?)?\b[689]\d{3}[\s-]?\d{4}\b/.test(text)) return 'Please leave out phone numbers.';
  if (RUDE.test(text)) return 'Please keep tips friendly.';
  return null;
}

const TIP_HIDE_FLAGS = 2;   // hidden once 2 different riders flag it
const TIPS_PER_PLACE = 5;

// Tips grouped by place (same name within 80 m), newest first, flagged ones left out
function groupTips(rows) {
  const flaggers = new Map();
  for (const r of rows.filter((x) => x.kind === 'tipflag')) {
    const set = flaggers.get(String(r.note)) || new Set();
    set.add(r.reporter || 'row' + r.id);
    flaggers.set(String(r.note), set);
  }
  const places = [];
  for (const r of rows.filter((x) => x.kind === 'tip' && x.note)) {
    if ((flaggers.get(String(r.id)) || new Set()).size >= TIP_HIDE_FLAGS) continue;
    let place = places.find((g) => simple(g.name) === simple(r.name) && metresApart(g, r) < 80);
    if (!place) { place = { name: r.name, lat: r.lat, lng: r.lng, tips: [] }; places.push(place); }
    if (place.tips.length >= TIPS_PER_PLACE || place.tips.some((t) => simple(t.text) === simple(r.note))) continue;
    place.tips.push({ id: r.id, text: r.note, at: r.created_at });
  }
  return places;
}

async function readCommunity(res) {
  const resp = await supabase('place_reports?select=id,kind,name,category,note,lat,lng,created_at,reporter'
    + '&created_at=gte.' + new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
    + '&order=created_at.desc&limit=3000');
  const rows = await resp.json();
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    closed: group(rows.filter((r) => r.kind === 'closed')).filter((g) => g.count >= CLOSED_NEEDS).map(({ name, lat, lng, count, last }) => ({ name, lat, lng, count, last })),
    missing: group(rows.filter((r) => r.kind === 'missing')),
    tips: groupTips(rows)
  });
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

async function save(req, res) {
  const b = readBody(req);
  if (b.website) return res.status(200).json({ ok: true }); // a hidden field only robots fill in

  // Limits per visitor, so nobody can flood the map or the feedback inbox
  const who = visitorCode(req);
  // A tip is checked before it counts towards the limits, so a rejected one costs nothing
  let tipText = '';
  if (b.type === 'tip') {
    tipText = clean(b.note, 120);
    const problem = tipProblem(tipText);
    if (problem) return res.status(400).json({ error: problem });
  }
  const limits = { closed: [[6, 3600], [20, 86400]], missing: [[6, 3600], [20, 86400]],
                   tip: [[6, 3600], [20, 86400]], tipflag: [[10, 3600], [30, 86400]],
                   feedback: [[5, 3600], [15, 86400]], event: [[150, 3600]] }[b.type];
  if (limits) {
    const group = ['missing', 'closed', 'tip'].includes(b.type) ? 'report' : b.type;
    for (const [limit, seconds] of limits) {
      if (!(await dbLimit(who, group + seconds, limit, seconds))) {
        if (b.type === 'event') return res.status(200).json({ ok: true });   // quietly skip extra counts
        return tooMany(res, seconds > 3600
          ? 'You have sent a lot today. Please try again tomorrow.'
          : 'You have sent a lot just now. Please try again in a while.');
      }
    }
  }

  let table, row;
  if (b.type === 'closed' || b.type === 'missing') {
    const lat = Number(b.lat), lng = Number(b.lng);
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Please give the place a name.' });
    if (!inSingapore(lat, lng)) return res.status(400).json({ error: 'That spot is not in Singapore.' });
    table = 'place_reports';
    row = { kind: b.type, name, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), reporter: who };
    if (b.type === 'missing') {
      row.category = CATEGORIES.includes(b.category) ? b.category : 'Other';
      row.note = clean(b.note, 200) || null;
    }
  } else if (b.type === 'tip') {
    const lat = Number(b.lat), lng = Number(b.lng);
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Which place is this tip for?' });
    if (!inSingapore(lat, lng)) return res.status(400).json({ error: 'That spot is not in Singapore.' });
    table = 'place_reports';
    row = { kind: 'tip', name, note: tipText, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), reporter: who };
  } else if (b.type === 'tipflag') {
    const id = Number(b.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown tip' });
    table = 'place_reports';
    // the flag sits at the tip's own place, so the map data stays in Singapore
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!inSingapore(lat, lng)) return res.status(400).json({ error: 'Unknown tip' });
    row = { kind: 'tipflag', name: clean(b.name, 80) || 'tip', note: String(id), lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), reporter: who };
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
    console.error('community error', err && err.message);
    return res.status(err.status || 500).json({
      error: err.name === 'AbortError' ? 'The database took too long to answer. Please try again.'
        : err.status === 503 ? err.message : 'Something went wrong. Please try again.'
    });
  }
};

module.exports.CATEGORIES = CATEGORIES;
module.exports.tipProblem = tipProblem;
module.exports.groupTips = groupTips;
