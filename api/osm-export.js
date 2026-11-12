// TEMPORARY: pulls Singapore expressway exits, road-sign destinations and lane arrows from
// OpenStreetMap (Overpass API) once, so they can be saved in the app as data/sg-roads.json.
// Removed again after the export.

const { quickLimit, tooMany } = require('./_security');

const BBOX = '1.15,103.59,1.475,104.1';
const QUERY = `[out:json][timeout:50];
(
  node["highway"="motorway_junction"](${BBOX});
  way["highway"~"^(motorway_link|trunk_link)$"](${BBOX});
  way["highway"~"^(motorway|trunk)$"]["destination"](${BBOX});
  way["turn:lanes"](${BBOX});
  way["turn:lanes:forward"](${BBOX});
  way["turn:lanes:backward"](${BBOX});
);
out tags geom;`;

const r5 = (x) => Number(Number(x).toFixed(5));
function metres(a, b) {
  const dy = (a.lat - b.lat) * 110574, dx = (a.lon - b.lon) * 111289;
  return Math.hypot(dx, dy);
}
// The point about `d` metres along a line from its start
function along(geom, d) {
  let acc = 0;
  for (let i = 1; i < geom.length; i++) {
    const seg = metres(geom[i - 1], geom[i]);
    if (acc + seg >= d) { const t = (d - acc) / (seg || 1); return { lat: geom[i - 1].lat + (geom[i].lat - geom[i - 1].lat) * t, lon: geom[i - 1].lon + (geom[i].lon - geom[i - 1].lon) * t }; }
    acc += seg;
  }
  return geom[geom.length - 1];
}
const pt = (p) => [r5(p.lon), r5(p.lat)];

module.exports = async (req, res) => {
  if (!quickLimit(req, 'osm-export', 3, 60000)) return tooMany(res);
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RiderKaki/1.0 (https://riderkaki.sg)' },
      body: 'data=' + encodeURIComponent(QUERY)
    });
    if (!resp.ok) return res.status(502).json({ error: 'Overpass status ' + resp.status });
    const json = await resp.json();
    const exits = [], links = [], signs = [], lanes = [];
    for (const e of json.elements || []) {
      const t = e.tags || {};
      if (e.type === 'node') {
        exits.push({ at: pt(e), ref: t.ref || '', name: t.name || '', dest: t.destination || '' });
        continue;
      }
      const g = e.geometry || [];
      if (g.length < 2) continue;
      const hw = t.highway || '';
      const dest = t.destination || t['destination:forward'] || '';
      if (/_link$/.test(hw)) {
        // where the slip road starts, a point 40 m in (to tell which way the route went), its signs
        links.push({ from: pt(g[0]), in: pt(along(g, 40)), to: pt(g[g.length - 1]), hw, dest,
                     destRef: t['destination:ref'] || '', destStreet: t['destination:street'] || '',
                     ref: t['junction:ref'] || '', name: t.name || '', oneway: t.oneway || '' });
      } else if (dest) {
        signs.push({ from: pt(g[0]), in: pt(along(g, 40)), hw, dest, destRef: t['destination:ref'] || '' });
      }
      // Lane arrows apply where the way ends (forward), or where it starts (backward)
      const fwd = t['turn:lanes'] || t['turn:lanes:forward'];
      if (fwd) {
        const n = g.length;
        lanes.push({ end: pt(g[n - 1]), before: pt(along(g.slice().reverse(), 40)), lanes: fwd, hw, name: t.name || '', ref: t.ref || '' });
      }
      const back = t['turn:lanes:backward'];
      if (back) lanes.push({ end: pt(g[0]), before: pt(along(g, 40)), lanes: back, hw, name: t.name || '', ref: t.ref || '' });
    }
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({ at: new Date().toISOString(), counts: { exits: exits.length, links: links.length, signs: signs.length, lanes: lanes.length }, exits, links, signs, lanes });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message) });
  }
};
