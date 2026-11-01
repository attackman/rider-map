// Shared protection for the server functions (files starting with "_" are not public endpoints).
//
// - visitorCode(req): a one-way scrambled code for the visitor's internet address, so we can
//   limit abuse without ever storing anyone's IP address.
// - quickLimit(): a fast in-memory limit for busy endpoints (search, routes). Each server copy
//   keeps its own count, so it stops floods from one source without slowing normal riders.
// - dbLimit(): a firm limit kept in the database, for anything that writes (reports, feedback).

const crypto = require('crypto');

function clientIp(req) {
  const h = (req && req.headers) || {};
  const forwarded = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(h['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function visitorCode(req) {
  const salt = process.env.RATE_SALT || process.env.SUPABASE_PUBLISHABLE_KEY || 'riderkaki';
  return crypto.createHash('sha256').update(salt + '|' + clientIp(req)).digest('hex').slice(0, 32);
}

// ---------- in-memory: e.g. 90 searches a minute per visitor ----------
const buckets = new Map();
function quickLimit(req, name, limit, windowMs) {
  const now = Date.now();
  const key = name + ':' + visitorCode(req);
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 5000) {            // keep memory small
    for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  }
  return b.count <= limit;
}

// ---------- in the database: survives across server copies ----------
async function dbLimit(code, name, limit, windowSeconds) {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!base || !key) return true;                       // not set up: don't block riders
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const resp = await fetch(base + '/rest/v1/rpc/allow_hit', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ p_key: name + ':' + code, p_limit: limit, p_window_seconds: windowSeconds })
    });
    if (!resp.ok) { console.error('rate limit check failed', resp.status); return true; }   // fail open: keep the app working
    return (await resp.json()) === true;
  } catch (e) {
    console.error('rate limit check error', e && e.message);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function tooMany(res, message) {
  res.setHeader('Retry-After', '60');
  return res.status(429).json({ error: message || 'Too many requests. Please wait a minute and try again.' });
}

module.exports = { clientIp, visitorCode, quickLimit, dbLimit, tooMany };
