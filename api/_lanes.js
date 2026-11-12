// Expressway exit numbers, road-sign directions ("towards Tampines / Changi") and lane arrows
// for each turn of a OneMap route, from OpenStreetMap data saved in data/sg-roads.json.
// Only what the map really has is added; nothing is guessed.

let DATA = null;
function data() {
  if (!DATA) {
    try { DATA = require('../data/sg-roads.json'); } catch (e) { DATA = { exits: [], links: [], signs: [], lanes: [] }; }
  }
  return DATA;
}

// Flat x/y in metres around Singapore
const toXY = ([lng, lat]) => [(lng - 103.8) * 111289, (lat - 1.35) * 110574];

// The route as a line in metres, with distance along it, for "how far from the route" and
// "how far along the route" questions
function routeLine(coords) {
  const pts = coords.map(toXY), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  // A coarse grid so each lookup only checks nearby route pieces
  const grid = new Map(), CELL = 200;
  const key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / CELL));
    for (let k = 0; k <= steps; k++) {
      const x = a[0] + (b[0] - a[0]) * k / steps, y = a[1] + (b[1] - a[1]) * k / steps;
      const kk = key(x, y);
      if (!grid.has(kk)) grid.set(kk, new Set());
      grid.get(kk).add(i);
    }
  }
  // Nearest point on the route: { off: metres from the route, along: metres from the start }
  function locate(lngLat) {
    const p = toXY(lngLat);
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best = { off: Infinity, along: 0 };
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const segs = grid.get((cx + dx) + ',' + (cy + dy));
      if (!segs) continue;
      for (const i of segs) {
        const a = pts[i - 1], b = pts[i];
        const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
        const x = a[0] + vx * t, y = a[1] + vy * t;
        const off = Math.hypot(p[0] - x, p[1] - y);
        if (off < best.off) best = { off, along: cum[i - 1] + t * Math.sqrt(len2) };
      }
    }
    return best;
  }
  return { locate, total: cum[cum.length - 1] };
}

// "Tampines;Changi" -> "Tampines / Changi"; with the road numbers first: "PIE / Changi"
function tidyDest(d) {
  return String(d || '').split(';').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' / ').slice(0, 80);
}
function towardText(dest, destRef) {
  const parts = [...String(destRef || '').split(';'), ...String(dest || '').split(';')].map((x) => x.trim()).filter(Boolean);
  return tidyDest([...new Set(parts)].join(';'));
}
// "through|through;slight_right|slight_right" -> [["through"], ["through", "slight_right"], ["slight_right"]]
function parseLanes(text) {
  const lanes = String(text || '').split('|').map((l) => l.split(';').map((a) => a.trim() || 'none'));
  return lanes.length >= 2 && lanes.length <= 8 ? lanes : null;
}

// Adds { exit, toward, lanes } to the steps it can, using the route line to see which slip
// road the route really takes and which lane arrows are on the way in
function addRoadSigns(steps, coords) {
  if (!Array.isArray(steps) || !steps.length || !Array.isArray(coords) || coords.length < 2) return steps;
  const d = data(), line = routeLine(coords);
  // Only the pieces of map data that lie on this route, placed along it (a box test first, for speed)
  let minX = 180, maxX = -180, minY = 90, maxY = -90;
  for (const [x, y] of coords) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const inBox = ([x, y]) => x > minX - 0.002 && x < maxX + 0.002 && y > minY - 0.002 && y < maxY + 0.002;
  const onRoute = (items, pick, maxOff) => items.filter((it) => inBox(pick(it)))
    .map((it) => ({ it, at: line.locate(pick(it)) })).filter((x) => x.at.off <= maxOff);
  const links = onRoute(d.links, (l) => l.in, 12)                            // slip roads the route drives along
    .map((x) => ({ ...x, start: line.locate(x.it.from) })).filter((x) => x.start.off <= 15 && x.start.along < x.at.along);
  const exits = onRoute(d.exits, (e) => e.at, 20);
  const signs = onRoute(d.signs, (s) => s.in, 12);
  const lanes = onRoute(d.lanes, (l) => l.end, 18)
    .map((x) => ({ ...x, before: line.locate(x.it.before) })).filter((x) => x.before.off <= 15 && x.before.along < x.at.along);

  const used = new Set();                 // each slip road or set of lane arrows goes to one turn only
  const fresh = (list) => list.filter((x) => !used.has(x));
  for (const step of steps) {
    if (!Number.isFinite(step.lat) || !Number.isFinite(step.lng)) continue;
    const here = line.locate([step.lng, step.lat]);
    if (here.off > 40) continue;
    const near = (x, before, after) => x.at.along >= here.along - before && x.at.along <= here.along + after;
    const closest = (list) => list.sort((a, b) => Math.abs(a.at.along - here.along) - Math.abs(b.at.along - here.along))[0];

    // The slip road taken at this turn: its start within 150 m before to 60 m after the turn
    const link = closest(fresh(links).filter((x) => x.start.along >= here.along - 150 && x.start.along <= here.along + 60)
      .map((x) => ({ ...x, at: x.start })));
    if (link) {
      used.add(links.find((x) => x.it === link.it));
      const exit = closest(exits.filter((x) => Math.abs(x.at.along - link.start.along) <= 60 && x.it.ref));
      const ref = (exit && exit.it.ref) || link.it.ref;
      if (ref && /^[0-9]{1,3}[A-Z]?$/i.test(ref)) step.exit = ref.toUpperCase();
      const toward = towardText(link.it.dest, link.it.destRef) || (exit ? tidyDest(exit.it.dest) : '');
      if (toward) step.toward = toward;
    } else {
      // Staying on the expressway at a fork: the sign over the main road, if mapped
      const sign = closest(signs.filter((x) => near(x, 60, 200)));
      if (sign) step.toward = towardText(sign.it.dest, sign.it.destRef);
    }
    // Lane arrows on the road leading up to the turn (they end 0-120 m before it)
    const lane = closest(fresh(lanes).filter((x) => near(x, 120, 30)));
    if (lane) {
      used.add(lane);
      const parsed = parseLanes(lane.it.lanes);
      if (parsed) step.lanes = parsed;
    }
  }
  return steps;
}

module.exports = { addRoadSigns, parseLanes, tidyDest, towardText, routeLine, _setData: (d) => { DATA = d; } };
