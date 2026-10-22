// Vercel serverless function: /api/search?q=tampines mall
// Logs in to OneMap with credentials stored in Vercel environment variables
// (ONEMAP_EMAIL, ONEMAP_PASSWORD), caches the token, and returns search results.
// The password never reaches the phone.

let cachedToken = null;
let tokenExpiresAt = 0; // milliseconds

async function getToken(forceNew = false) {
  const now = Date.now();
  if (!forceNew && cachedToken && now < tokenExpiresAt - 60 * 60 * 1000) {
    return cachedToken; // reuse until 1 hour before expiry
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

async function searchOneMap(query, token) {
  const url = 'https://www.onemap.gov.sg/api/common/elastic/search'
    + '?searchVal=' + encodeURIComponent(query)
    + '&returnGeom=Y&getAddrDetails=Y&pageNum=1';
  return fetch(url, { headers: { Authorization: token } });
}

module.exports = async (req, res) => {
  const q = String((req.query && req.query.q) || '').trim().slice(0, 100);
  if (q.length < 2) {
    return res.status(200).json({ results: [] });
  }

  try {
    let token = await getToken();
    let resp = await searchOneMap(q, token);

    // Token rejected: log in again once and retry
    if (resp.status === 401 || resp.status === 403) {
      token = await getToken(true);
      resp = await searchOneMap(q, token);
    }
    if (!resp.ok) {
      return res.status(502).json({ error: 'OneMap search failed (status ' + resp.status + ')' });
    }

    const data = await resp.json();
    const results = (data.results || []).slice(0, 8).map((r) => ({
      name: r.SEARCHVAL,
      address: r.ADDRESS,
      postal: r.POSTAL,
      lat: Number(r.LATITUDE),
      lng: Number(r.LONGITUDE)
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));

    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
