// Vercel serverless function:
//   /api/route?start=1.3525,103.9447&end=1.3000,103.8550&type=cycle
// Logs in to OneMap with ONEMAP_EMAIL / ONEMAP_PASSWORD (Vercel environment
// variables), asks OneMap for a route, and returns the line plus distance and time.

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

// Decode an encoded polyline into [lng, lat] pairs for the map
function decodePolyline(str, precision) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

function inSingapore([lng, lat]) {
  return lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2;
}

// Try the usual precision first; fall back if the points land outside Singapore
function decodeRoute(str) {
  for (const p of [5, 6]) {
    const coords = decodePolyline(str, p);
    if (coords.length >= 2 && inSingapore(coords[0]) && inSingapore(coords[coords.length - 1])) {
      return coords;
    }
  }
  return null;
}

function parsePoint(text) {
  const parts = String(text || '').split(',').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  const [lat, lng] = parts;
  if (!inSingapore([lng, lat])) return null;
  return lat.toFixed(6) + ',' + lng.toFixed(6);
}

async function fetchRoute(start, end, type, token) {
  const url = 'https://www.onemap.gov.sg/api/public/routingsvc/route'
    + '?start=' + encodeURIComponent(start)
    + '&end=' + encodeURIComponent(end)
    + '&routeType=' + encodeURIComponent(type);
  return fetch(url, { headers: { Authorization: token } });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const start = parsePoint(q.start);
  const end = parsePoint(q.end);
  const type = ['cycle', 'drive', 'walk'].includes(q.type) ? q.type : 'cycle';

  if (!start || !end) {
    return res.status(400).json({ error: 'Start and end must both be places in Singapore' });
  }

  try {
    let token = await getToken();
    let resp = await fetchRoute(start, end, type, token);
    if (resp.status === 401 || resp.status === 403) {
      token = await getToken(true);
      resp = await fetchRoute(start, end, type, token);
    }
    if (!resp.ok) {
      return res.status(502).json({ error: 'OneMap route failed (status ' + resp.status + ')' });
    }

    const data = await resp.json();
    const coords = data.route_geometry ? decodeRoute(data.route_geometry) : null;
    if (!coords) {
      return res.status(404).json({ error: data.status_message || 'No route found between these places' });
    }

    const summary = data.route_summary || {};
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({
      type,
      distance_m: Number(summary.total_distance) || null,
      time_s: Number(summary.total_time) || null,
      coordinates: coords
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
