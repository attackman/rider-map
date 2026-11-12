// Speed limits along a route, from OpenStreetMap data saved in data/sg-speed.json.
// The route is checked every 25 m against the mapped roads going the same way; the answer is
// a short list of stretches: [[from metres, to metres, km/h], ...]. Unknown stretches are left out.

let DATA = null, GRID = null;
const CELL = 100;
const toXY = ([lng, lat]) => [(lng - 103.8) * 111289, (lat - 1.35) * 110574];
const key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);

// "90" -> 90, "70 km/h" -> 70; anything else (e.g. "SG:urban") isn't used
function kmh(text) {
  const m = /^\s*(\d{2,3})\s*(km\/h|kmh|kph)?\s*$/i.exec(String(text || '').split(';')[0]);
  const v = m ? Number(m[1]) : NaN;
  return v >= 10 && v <= 120 ? v : null;
}

function load() {
  if (GRID) return GRID;
  if (!DATA) {
    try { DATA = require('../data/sg-speed.json'); } catch (e) { DATA = { ways: [] }; }
  }
  GRID = new Map();
  for (const w of DATA.ways || []) {
    const both = kmh(w.s), fwd = kmh(w.f) || both, back = kmh(w.b) || both;
    if (!fwd && !back) continue;
    const oneway = w.o === 'yes' || w.o === '1' || /motorway/.test(w.hw);
    const pts = (w.g || []).map(toXY);
    for (let i = 1; i < pts.length; i++) {
      const seg = { a: pts[i - 1], b: pts[i], fwd, back: oneway ? null : back };
      const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
      const n = Math.max(1, Math.ceil(len / (CELL / 2)));
      const cells = new Set();
      for (let k = 0; k <= n; k++) {
        const x = seg.a[0] + (seg.b[0] - seg.a[0]) * k / n, y = seg.a[1] + (seg.b[1] - seg.a[1]) * k / n;
        cells.add(key(x, y));
      }
      for (const c of cells) { if (!GRID.has(c)) GRID.set(c, []); GRID.get(c).push(seg); }
    }
  }
  return GRID;
}

// The limit at point p, going in direction (dx, dy): the nearest mapped road within 12 m that
// runs the same way (within 35 degrees)
function limitAt(p, dx, dy) {
  const grid = load();
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  const dlen = Math.hypot(dx, dy) || 1;
  let best = null, bestOff = 12;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const s of grid.get((cx + i) + ',' + (cy + j)) || []) {
      const vx = s.b[0] - s.a[0], vy = s.b[1] - s.a[1], len = Math.hypot(vx, vy) || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * vx + (p[1] - s.a[1]) * vy) / (len * len)));
      const off = Math.hypot(p[0] - (s.a[0] + vx * t), p[1] - (s.a[1] + vy * t));
      if (off > bestOff) continue;
      const cos = (vx * dx + vy * dy) / (len * dlen);
      const v = cos > 0.82 ? s.fwd : cos < -0.82 ? s.back : null;
      if (!v) continue;
      best = v; bestOff = off;
    }
  }
  return best;
}

function speedLimits(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const pts = coords.map(toXY);
  const samples = [];                       // [metres along, km/h or null]
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    for (let d = (samples.length ? (25 - (along % 25)) % 25 : 0); d <= len; d += 25) {
      const t = d / len;
      samples.push([along + d, limitAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], b[0] - a[0], b[1] - a[1])]);
    }
    along += len;
  }
  // Runs of the same limit; very short runs (under 75 m, e.g. crossing a junction) are dropped
  const runs = [];
  for (const [d, v] of samples) {
    const last = runs[runs.length - 1];
    if (last && last[2] === v) last[1] = d; else runs.push([d, d, v]);
  }
  const kept = runs.filter((r) => r[2] && r[1] - r[0] >= 75);
  const out = [];
  for (const r of kept) {
    const last = out[out.length - 1];
    if (last && last[2] === r[2] && r[0] - last[1] < 150) last[1] = r[1];   // bridge small gaps
    else out.push([Math.round(r[0]), Math.round(r[1] + 12), r[2]]);
  }
  for (const r of out) r[1] = Math.round(r[1]);
  return out.slice(0, 200);
}

module.exports = { speedLimits, kmh, _setData: (d) => { DATA = d; GRID = null; } };
