// TEMPORARY: pulls Singapore road speed limits from OpenStreetMap (Overpass API) once, so
// they can be saved in the app as data/sg-speed.json. Removed again after the export.

const { quickLimit, tooMany } = require('./_security');

const BBOX = '1.15,103.59,1.475,104.1';
const QUERY = `[out:json][timeout:90];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary)$"](${BBOX});
);
out tags geom;`;

const toXY = (p) => [(p.lon - 103.8) * 111289, (p.lat - 1.35) * 110574];
// Fewer points, same shape (within `tol` metres)
function simplify(g, tol) {
  if (g.length <= 2) return g;
  const xy = g.map(toXY), keep = new Array(g.length).fill(false);
  keep[0] = keep[g.length - 1] = true;
  const stack = [[0, g.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / len;
      if (d > far) { far = d; worst = i; }
    }
    if (far > tol) { keep[worst] = true; stack.push([a, worst], [worst, b]); }
  }
  return g.filter((_, i) => keep[i]);
}

module.exports = async (req, res) => {
  if (!quickLimit(req, 'osm-export', 3, 60000)) return tooMany(res);
  try {
    let json = null; const tried = [];
    for (const server of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
                          'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
      try {
        const resp = await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RiderKaki/1.0 (https://riderkaki.sg)' },
          body: 'data=' + encodeURIComponent(QUERY)
        });
        tried.push(server + ' ' + resp.status);
        if (resp.ok) { json = await resp.json(); break; }
      } catch (e) { tried.push(server + ' ' + e.message); }
    }
    if (!json) return res.status(502).json({ error: 'Overpass failed', tried });
    const ways = [];
    const counts = {};
    for (const e of json.elements || []) {
      const t = e.tags || {}, g = e.geometry || [];
      if (g.length < 2) continue;
      const hw = t.highway;
      counts[hw] = counts[hw] || { all: 0, speed: 0 };
      counts[hw].all++;
      const speed = t.maxspeed || t['maxspeed:forward'] || t['maxspeed:backward'] || '';
      if (!speed) continue;
      counts[hw].speed++;
      ways.push({ hw, s: speed, f: t['maxspeed:forward'] || '', b: t['maxspeed:backward'] || '', o: t.oneway || '',
                  ref: t.ref || '', g: simplify(g, 4).map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]) });
    }
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({ at: new Date().toISOString(), counts, ways });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message) });
  }
};
