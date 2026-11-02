// RiderKaki for Even Realities G2: rain, motorbike parking and buses near you, at a glance.
//
// Runs inside the Even app on the phone. The glasses show one full-screen text panel:
//   swipe down / up  → next / previous screen (Rain → Parking → Bus)
//   tap              → refresh (on the Bus screen: the next nearest stop)
//   double tap       → close the app
// The phone page shows the same text, so it also works as a preview in any browser.

import * as SDK from '@evenrealities/even_hub_sdk';
import { SCREENS, rainText, parkText, busText, nearbyStops } from './screens.js';

const API = 'https://riderkaki.sg/api/';
const state = { screen: 'rain', here: null, weather: null, carparks: null, stops: null, arrival: null, pick: 0, shown: '' };
const fetchedAt = {};
let bridge = null;

const $ = (id) => document.getElementById(id);
const setStatus = (text) => { $('status').textContent = text; };

async function getJson(path) {
  const resp = await fetch(API + path, { cache: 'no-store' });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error || 'status ' + resp.status);
  return data;
}

// Fetch only when the data is older than maxAge
async function refresh(key, path, maxAge, read) {
  if (fetchedAt[key] && Date.now() - fetchedAt[key] < maxAge) return;
  fetchedAt[key] = Date.now();
  try {
    state[key] = read(await getJson(path));
    if (key === 'stops' && state.screen === 'bus') refreshBus(false);
  } catch (e) {
    fetchedAt[key] = Date.now() - maxAge + 30000;   // try again in 30 s
    console.warn('RiderKaki:', key, e.message);
  }
  render();
}

async function refreshBus(force) {
  const stops = nearbyStops(state.stops, state.here);
  if (!stops.length) return;
  const stop = stops[state.pick % stops.length];
  if (!force && state.arrival && state.arrival.stop === stop.code && Date.now() - (fetchedAt.arrival || 0) < 30000) return;
  fetchedAt.arrival = Date.now();
  try { state.arrival = await getJson('lta?kind=arrival&stop=' + stop.code); } catch (e) { console.warn('RiderKaki: bus', e.message); }
  render();
}

function tick(force) {
  if (force) for (const k of Object.keys(fetchedAt)) delete fetchedAt[k];
  refresh('weather', 'weather', 10 * 60000, (d) => d);
  refresh('carparks', 'lta?kind=carparks', 2 * 60000, (d) => d.carparks || []);
  refresh('stops', 'lta?kind=busstops', 24 * 3600000, (d) => d.busstops || []);
  if (state.screen === 'bus') refreshBus(force);
}

function screenText() {
  if (state.screen === 'rain') return rainText(state.weather, state.here);
  if (state.screen === 'park') return parkText(state.carparks, state.here);
  return busText(state.stops, state.arrival, state.here, state.pick, Date.now());
}

// Draw on the glasses (only when the text changed) and mirror it on the phone
function render() {
  const text = screenText();
  $('mirror').textContent = text;
  if (!bridge || text === state.shown) return;
  state.shown = text;
  bridge.textContainerUpgrade(new SDK.TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }));
}

function go(step) {
  const i = SCREENS.indexOf(state.screen);
  state.screen = SCREENS[(i + step + SCREENS.length) % SCREENS.length];
  if (bridge) bridge.setLocalStorage('screen', state.screen);
  render();
  if (state.screen === 'bus') refreshBus(false);
}

function tap() {
  if (state.screen === 'bus') { state.pick += 1; state.arrival = null; render(); refreshBus(true); return; }
  tick(true);
}

function gotLocation(loc) {
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return;
  const moved = !state.here || Math.abs(state.here.lat - loc.latitude) + Math.abs(state.here.lng - loc.longitude) > 0.0003;
  state.here = { lat: loc.latitude, lng: loc.longitude };
  setStatus('Location found · showing what is near you');
  if (moved) { state.pick = 0; render(); if (state.screen === 'bus') refreshBus(true); }
}

// ---------- phone buttons (also the way to try it without glasses) ----------
$('prev').addEventListener('click', () => go(-1));
$('next').addEventListener('click', () => go(1));
$('tap').addEventListener('click', tap);

// ---------- start ----------
async function start() {
  render();
  bridge = await Promise.race([
    SDK.waitForEvenAppBridge().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 4000))
  ]);

  if (bridge) {
    const saved = await bridge.getLocalStorage('screen').catch(() => '');
    if (SCREENS.includes(saved)) state.screen = saved;
    state.shown = screenText();
    const result = await bridge.createStartUpPageContainer(new SDK.CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new SDK.TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, borderColor: 0, paddingLength: 6,
        containerID: 1, containerName: 'main', content: state.shown, isEventCapture: 1
      })]
    }));
    setStatus(result === 0 ? 'Connected to your G2 · finding your location...' : 'Glasses screen could not start (code ' + result + ')');

    // Single tap arrives with no eventType (protobuf drops the 0), so read it inside each envelope
    const typeOf = (env) => (env ? (env.eventType ?? SDK.OsEventTypeList.CLICK_EVENT) : null);
    bridge.onEvenHubEvent((event) => {
      const sys = typeOf(event.sysEvent), txt = typeOf(event.textEvent);
      const T = SDK.OsEventTypeList;
      if (sys === T.DOUBLE_CLICK_EVENT || txt === T.DOUBLE_CLICK_EVENT) { bridge.shutDownPageContainer(1); return; }
      if (txt === T.SCROLL_BOTTOM_EVENT) { go(1); return; }
      if (txt === T.SCROLL_TOP_EVENT) { go(-1); return; }
      if (sys === T.CLICK_EVENT) { tap(); return; }
      if (sys === T.FOREGROUND_ENTER_EVENT) tick(false);
    });

    // Phone location through the Even app (needs the "location" permission)
    const High = (SDK.AppLocationAccuracy && SDK.AppLocationAccuracy.High) || 'high';
    bridge.onAppLocationChanged(gotLocation);
    bridge.getAppLocation({ accuracy: High, timeoutMs: 15000 }).then(gotLocation).catch(() => {});
    bridge.startAppLocationUpdates({ accuracy: High, intervalMs: 10000, distanceFilter: 25 }).catch(() => {});
  } else {
    setStatus('Preview mode (no glasses connected) · using this phone’s location');
    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition((p) => gotLocation(p.coords),
        () => setStatus('Allow location to see what is near you'), { enableHighAccuracy: true, maximumAge: 15000 });
    }
  }

  tick(false);
  setInterval(() => tick(false), 30000);
  setInterval(render, 15000);   // keeps "min" counts current between bus updates
}

start();
