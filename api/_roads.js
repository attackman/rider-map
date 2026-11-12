// Live road data for the map: traffic speeds, traffic cameras and PUB flood alerts (LTA DataMall).
// Shared by api/lta.js. Files starting with _ are not web addresses on Vercel.

function inSingapore(lat, lng) {
  return lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2;
}

// Camera names, as LTA's OneMotoring traffic camera pages caption them (DataMall only gives the ID)
const CAMERAS = {
  '2701': ['Woodlands Checkpoint', 'Woodlands Causeway (Towards Johor)'],
  '2702': ['Woodlands Checkpoint', 'Woodlands Checkpoint (Towards BKE)'],
  '4713': ['Tuas Checkpoint', 'Tuas Checkpoint'],
  '4703': ['Tuas Checkpoint', 'Second Link at Tuas'],
  '4798': ['Sentosa Gateway', 'Sentosa Gateway (Towards Telok Blangah)'],
  '4799': ['Sentosa Gateway', 'Sentosa Gateway (Towards Sentosa)'],
  '2703': ['BKE', 'Chantek Flyover'],
  '2704': ['BKE', 'Woodlands Flyover (Towards Checkpoint)'],
  '2705': ['BKE', 'Dairy Farm Flyover'],
  '2706': ['BKE', 'After KJE Exit'],
  '2707': ['BKE', 'Mandai Rd Entrance'],
  '2708': ['BKE', 'Exit 5 to KJE (Towards Checkpoint)'],
  '9701': ['SLE', 'Lentor Flyover'],
  '9702': ['SLE', 'Upp Thomson Flyover'],
  '9703': ['SLE', 'SLE(BKE) Exit'],
  '9704': ['SLE', 'Ulu Sembawang Flyover'],
  '9705': ['SLE', 'Marsiling Flyover'],
  '9706': ['SLE', 'Mandai Flyover'],
  '8701': ['KJE', 'Choa Chu Kang West Flyover'],
  '8702': ['KJE', 'Exit To BKE'],
  '8704': ['KJE', 'Entrance From Choa Chu Kang Dr'],
  '8706': ['KJE', 'Tengah Flyover'],
  '4701': ['AYE', 'Towards Alexandra Rd'],
  '4702': ['AYE', 'Keppel Viaduct'],
  '4704': ['AYE', 'Lower Delta Road'],
  '4705': ['AYE', 'Entrance from Yuan Ching Rd'],
  '4706': ['AYE', 'Near NUS'],
  '4707': ['AYE', 'Entrance from Jln Ahmad Ibrahim'],
  '4708': ['AYE', 'Near Dover Drive'],
  '4709': ['AYE', 'Clementi Ave 6 Entrance'],
  '4710': ['AYE', 'Towards Pandan Gardens'],
  '4712': ['AYE', 'After Tuas West Road'],
  '4714': ['AYE', 'Near West Coast Walk'],
  '4716': ['AYE', 'Entrance from Benoi Rd'],
  '1701': ['CTE', 'Moulmein Flyover'],
  '1702': ['CTE', 'Braddell Flyover'],
  '1703': ['CTE', 'St George Road'],
  '1704': ['CTE', 'Entrance from Chin Swee Road'],
  '1705': ['CTE', 'Ang Mo Kio Ave 5 Flyover'],
  '1706': ['CTE', 'Yio Chu Kang Flyover'],
  '1707': ['CTE', 'Bukit Merah Flyover'],
  '1709': ['CTE', 'Exit 6 to Bukit Timah Road'],
  '1711': ['CTE', 'Ang Mo Kio Ave 1 Flyover'],
  '1501': ['MCE', 'Maxwell Road'],
  '1502': ['MCE', 'Marina Boulevard/Marina Coastal Drive'],
  '1503': ['MCE', 'MCE 1.02km'],
  '1504': ['MCE', 'MCE/ECP'],
  '1505': ['MCE', 'Marina Boulevard'],
  '3702': ['ECP', 'Entrance from PIE'],
  '3704': ['ECP', 'Entrance from MCE'],
  '3705': ['ECP', 'Exit 2A to Changi Coast Road'],
  '3793': ['ECP', 'Laguna Flyover'],
  '3795': ['ECP', 'Marine Parade Flyover'],
  '3796': ['ECP', 'Tanjong Katong Flyover'],
  '3797': ['ECP', 'Tanjong Rhu'],
  '3798': ['ECP', 'Benjamin Sheares Bridge'],
  '1001': ['KPE', 'KPE/ECP'],
  '1002': ['KPE', 'Kallang Bahru'],
  '1003': ['KPE', 'KPE/PIE'],
  '1004': ['KPE', 'Kallang Way Flyover'],
  '1005': ['KPE', 'Defu Flyover'],
  '1006': ['KPE', 'Tampines Flyover'],
  '7791': ['TPE', 'Upp Changi Flyover Towards PIE'],
  '7793': ['TPE', 'Tampines Ave 10 Entrance'],
  '7794': ['TPE', 'TPE(KPE) Exit'],
  '7795': ['TPE', 'Entrance To Tampines Flyover'],
  '7796': ['TPE', 'Exit to Punggol Flyover'],
  '7797': ['TPE', 'Seletar West Link'],
  '7798': ['TPE', 'Seletar Flyover'],
  '5794': ['PIE', 'Bedok North'],
  '5795': ['PIE', 'Eunos Flyover'],
  '5797': ['PIE', 'Paya Lebar Flyover'],
  '5798': ['PIE', 'Kallang Way'],
  '5799': ['PIE', 'Woodsville Flyover'],
  '6701': ['PIE', 'Kim Keat Link'],
  '6703': ['PIE', 'Thomson Flyover'],
  '6704': ['PIE', 'Mount Pleasant'],
  '6705': ['PIE', 'Adam Road'],
  '6706': ['PIE', 'Bukit Timah Expressway'],
  '6708': ['PIE', 'Nanyang Flyover'],
  '6710': ['PIE', 'Entrance from Jalan Anak Bukit'],
  '6711': ['PIE', 'Entrance to PIE from ECP Changi'],
  '6712': ['PIE', 'Exit 27 to Clementi Ave 6'],
  '6713': ['PIE', 'Entrance from Simei Ave'],
  '6714': ['PIE', 'Exit 35 to KJE'],
  '6715': ['PIE', 'Hong Kah Flyover'],
  '6716': ['PIE', 'Tuas Flyover']
};

// ".../2026-11-12/22-20/2701_2210_20261112142020_E8CB5B.jpg?..." → when the photo was taken.
// The folder is Singapore time; the time in the file name is UTC.
function photoTime(link) {
  const m = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(String(link || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : '';
}

function readCameras(rows) {
  const out = [];
  for (const r of rows) {
    const lat = Number(r.Latitude), lng = Number(r.Longitude);
    const id = String(r.CameraID || '').trim();
    const img = String(r.ImageLink || '');
    if (!/^\d{3,5}$/.test(id) || !inSingapore(lat, lng) || !/^https:\/\//.test(img)) continue;
    const [road, name] = CAMERAS[id] || ['', 'Traffic camera'];
    const taken = Date.parse(r.at || '');
    out.push({ id, road, name, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), img,
               at: Number.isNaN(taken) ? photoTime(img) : new Date(taken).toISOString() });
  }
  // Checkpoints first, so they are easy to find in lists
  return out.sort((a, b) => (/Checkpoint/.test(b.road) - /Checkpoint/.test(a.road)) || a.id.localeCompare(b.id));
}

// The same cameras from data.gov.sg (LTA's feed sometimes lists only the checkpoint cameras):
// { items: [{ cameras: [{ camera_id, image, timestamp, location: { latitude, longitude } }] }] }
function readGovCameras(json) {
  const cams = (json && Array.isArray(json.items) && json.items[0] && Array.isArray(json.items[0].cameras)) ? json.items[0].cameras : [];
  return readCameras(cams.map((c) => ({
    CameraID: c.camera_id, Latitude: c.location && c.location.latitude, Longitude: c.location && c.location.longitude,
    ImageLink: c.image, at: c.timestamp })));
}

// LTA's cameras first; data.gov.sg fills in any it left out
function mergeCameras(lta, gov) {
  const seen = new Set(lta.map((c) => c.id));
  return [...lta, ...gov.filter((c) => !seen.has(c.id))]
    .sort((a, b) => (/Checkpoint/.test(b.road) - /Checkpoint/.test(a.road)) || a.id.localeCompare(b.id));
}

// Road types: A expressways, B major roads, C other main roads... (older feeds used 1, 2, 3...)
const CATEGORY = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E', 6: 'F', 8: 'G' };
// How busy a stretch is: 0 moving well, 1 slow, 2 jammed. Speed bands: 1 = under 10 km/h,
// 2 = 10-19 ... 8 = 70 and over. Expressways count as slow under 50 km/h and jammed under 30.
// Major roads have traffic lights, so only under 20 km/h (slow) and under 10 (jammed) count.
function trafficLevel(category, band) {
  if (category === 'A') return band <= 3 ? 2 : band <= 5 ? 1 : 0;
  if (category === 'B') return band <= 1 ? 2 : band <= 2 ? 1 : 0;
  return -1;
}

// Each stretch as [startLng, startLat, endLng, endLat, level]. Every expressway stretch is kept
// (green too, so riders see the whole picture). On major roads only real queues are kept: at least
// 3 slow or jammed stretches in a row (about 300 m or more), not one red light at a junction.
function readSpeedBands(rows) {
  const out = [], major = [];
  for (const r of rows) {
    const raw = String(r.RoadCategory == null ? '' : r.RoadCategory).trim().toUpperCase();
    const category = CATEGORY[raw] || raw;
    const band = Number(r.SpeedBand);
    if (!(band >= 1 && band <= 8)) continue;
    const level = trafficLevel(category, band);
    if (level < 0 || (category !== 'A' && level === 0)) continue;
    const c = [r.StartLon, r.StartLat, r.EndLon, r.EndLat].map(Number);
    if (!inSingapore(c[1], c[0]) || !inSingapore(c[3], c[2])) continue;
    const link = [...c.map((v) => Number(v.toFixed(5))), level];
    (category === 'A' ? out : major).push(link);
  }
  out.push(...queues(major, 3));
  return out.sort((a, b) => a[4] - b[4]);    // jams last, so they are drawn on top
}

// Stretches that join end to start, grouped; groups smaller than `min` are dropped
function queues(links, min) {
  const parent = links.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const at = new Map();
  links.forEach((l, i) => {
    for (const key of [l[0] + ',' + l[1], l[2] + ',' + l[3]]) {
      if (at.has(key)) parent[find(i)] = find(at.get(key)); else at.set(key, i);
    }
  });
  const size = new Map();
  links.forEach((_, i) => { const r = find(i); size.set(r, (size.get(r) || 0) + 1); });
  return links.filter((_, i) => size.get(find(i)) >= min);
}

// PUB flash flood alerts. A "Cancel" message ends the earlier alert for the same place, and every
// alert has an expiry time. "circle" is "lat,lng radius" or "lat,lng,radius" (radius in km).
function readFloods(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };
  const where = (r) => String(r.areaDesc || r.description || '').toLowerCase().trim();
  const cancelled = list.filter((r) => /cancel/i.test(r.msgType || ''));
  const out = [];
  for (const r of list) {
    if (!/alert|update/i.test(r.msgType || '') || (r.status && !/actual/i.test(r.status))) continue;
    const issued = time(r.dateTime || r.sent);
    const expires = time(r.expires);
    if (expires && expires < now) continue;
    if (cancelled.some((c) => where(c) === where(r) && time(c.dateTime || c.sent) >= issued)) continue;
    const [lat, lng] = String(r.circle || '').trim().split(/[\s,]+/).map(Number);
    if (!inSingapore(lat, lng)) continue;
    const text = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    out.push({
      id: text(r.alertId, 120),
      headline: text(r.headline, 80) || 'Flash flood',
      text: text(r.description, 300),
      instruction: text(r.instruction, 200),
      area: text(r.areaDesc, 120).replace(/,\s*Singapore$/i, ''),
      severity: text(r.severity, 20),
      at: issued ? new Date(issued).toISOString() : '',
      lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5))
    });
  }
  return out;
}

module.exports = { readCameras, readGovCameras, mergeCameras, readSpeedBands, readFloods, trafficLevel, photoTime, CAMERAS };
