// What the G2 glasses show, as plain text. No SDK and no network here, so it can be tested on its own.
//
// The glasses use one built-in green font: proportional, no sizes, no emoji. Characters outside the
// font are skipped, so only plain letters and a few symbols are used (· ● ○ ━ ▲ ▼ ↑).
// About 9 short lines fit on the 576 × 288 screen; every screen here stays at 8 lines or fewer,
// so the text never scrolls and swipes always switch screens.

export const SCREENS = ['rain', 'park', 'bus'];
const TITLES = { rain: 'RAIN', park: 'MOTORBIKE PARKING', bus: 'BUS' };
const MAX_LINE = 38;

export function metres(a, b) {
  const dLat = (a.lat - b.lat) * 110574;
  const dLng = (a.lng - b.lng) * 111289;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export function nearestList(items, here, maxMetres, count) {
  if (!here || !Array.isArray(items)) return [];
  return items
    .map((item) => ({ item, d: metres(here, item) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= maxMetres)
    .sort((a, b) => a.d - b.d)
    .slice(0, count);
}

export function distance(m) {
  if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m';
  return (m / 1000).toFixed(1) + ' km';
}

// "4 pm" / "4:30 pm", always Singapore time
export function clock(iso) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' am' : ' pm');
}

export function minutesAway(iso, now) {
  const m = Math.round((Date.parse(iso) - now) / 60000);
  return m <= 0 ? 'Arr' : String(m);
}

// Keep to characters the glasses font has; shorten long names
export function plain(text, max = MAX_LINE) {
  const s = String(text == null ? '' : text)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^ -~ -ÿ←-↙─-▕■-◯]/g, '')
    .replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '.' : s;
}

// Title line with page dots, a rule, the body, then one hint line
export function frame(screen, body, hint) {
  const i = SCREENS.indexOf(screen);
  const dots = SCREENS.map((_, k) => (k === i ? '●' : '○')).join(' ');
  return [TITLES[screen] + '   ' + dots, '━━━━━━━━━━━━━━━━━━━━━━━━', ...body.slice(0, 5), hint].join('\n');
}

const SWIPE = '▲▼ swipe for more';

export function rainText(weather, here) {
  if (!here) return frame('rain', ['Finding your location...'], SWIPE);
  if (!weather) return frame('rain', ['Checking the weather...'], SWIPE);
  const body = [];
  const areas = (weather.forecast && weather.forecast.areas) || [];
  const [near] = nearestList(areas, here, 10000, 1);
  const till = weather.forecast && clock(weather.forecast.validUntil);
  if (near) {
    const a = near.item;
    if (a.rain) {
      body.push('RAIN COMING');
      body.push(plain(a.forecast));
      body.push(plain('around ' + a.name + (till ? ' till ' + till : '')));
    } else {
      body.push('No rain expected');
      body.push(plain(a.forecast + ' · ' + a.name));
      if (till) body.push('until ' + till);
    }
  } else {
    body.push('No forecast for this area');
  }
  const [wet] = nearestList((weather.raining || []).filter((r) => r.mm > 0), here, 3000, 1);
  if (wet) body.push(plain('Raining now ' + distance(wet.d) + ' away (' + wet.item.mm + ' mm)'));
  const [hot] = nearestList(weather.heat || [], here, 10000, 1);
  if (hot && /high/i.test(hot.item.level)) body.push('High heat · drink water');
  return frame('rain', body, SWIPE);
}

export function parkText(carparks, here) {
  if (!here) return frame('park', ['Finding your location...'], SWIPE);
  if (!carparks) return frame('park', ['Checking free lots...'], SWIPE);
  const moto = carparks.filter((c) => c.vehicle === 'motorcycle' && c.lots > 0);
  const near = nearestList(moto, here, 1500, 2);
  if (!near.length) return frame('park', ['No free motorbike lots', 'with a live count within 1.5 km'], SWIPE);
  const body = [];
  for (const { item, d } of near) {
    body.push(item.lots + ' free · ' + distance(d));
    body.push('  ' + plain(niceName(item.name), MAX_LINE - 2));
  }
  return frame('park', body, SWIPE);
}

// The nth nearest stop (tap cycles through the 3 nearest), with live buses
export function busText(stops, arrival, here, pick, now) {
  if (!here) return frame('bus', ['Finding your location...'], SWIPE);
  if (!stops) return frame('bus', ['Loading bus stops...'], SWIPE);
  const near = nearestList(stops, here, 600, 3);
  if (!near.length) return frame('bus', ['No bus stop within 600 m'], SWIPE);
  const { item: stop, d } = near[pick % near.length];
  const body = [plain(stop.name + ' · ' + stop.code + ' · ' + distance(d))];
  if (!arrival || arrival.stop !== stop.code) {
    body.push('Checking buses...');
  } else {
    const running = (arrival.services || []).filter((s) => s.next && s.next.length);
    if (!running.length) body.push('No buses running now');
    const parts = running.map((s) => {
      const t = s.next.slice(0, 2).map((b) => minutesAway(b.at, now));
      return s.no + ': ' + t.join(', ') + (t[t.length - 1] === 'Arr' ? '' : ' min');
    });
    for (let i = 0; i < parts.length && body.length < 5; i += 2) {
      body.push(parts.slice(i, i + 2).join('   '));
    }
    if (parts.length > 8) body[4] = body[4] + '  +' + (parts.length - 8);
  }
  const hint = near.length > 1 ? 'tap: next stop (' + ((pick % near.length) + 1) + '/' + near.length + ') · ▲▼' : SWIPE;
  return frame('bus', body, hint);
}

export function nearbyStops(stops, here) {
  return nearestList(stops || [], here, 600, 3).map((x) => x.item);
}

// "BLK 297 CAR PARK" → "Blk 297 Car Park"; leave mixed-case names alone
export function niceName(name) {
  const s = String(name || '');
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bMscp\b/g, 'MSCP').replace(/\bHdb\b/g, 'HDB').replace(/\bUra\b/g, 'URA');
}
