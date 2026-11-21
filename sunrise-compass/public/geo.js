'use strict';
// Location-based data: place name, live weather, and the real terrain horizon.
(function (global) {
  const R_EARTH = 6371000, REFRACTION_K = 0.13;
  const cacheGet = k => { try { const v = JSON.parse(localStorage.getItem(k)); return v && v.exp > Date.now() ? v.data : null; } catch (_) { return null; } };
  const cacheSet = (k, data, ttlMs) => { try { localStorage.setItem(k, JSON.stringify({ data, exp: Date.now() + ttlMs })); } catch (_) {} };
  const key = (p, lat, lng, prec = 2) => `${p}:${lat.toFixed(prec)},${lng.toFixed(prec)}`;

  async function place(lat, lng) {
    const k = key('place', lat, lng); const c = cacheGet(k); if (c) return c;
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
    const j = await r.json();
    const name = j.city || j.locality || j.principalSubdivision || j.countryName || '';
    const region = j.city || j.locality ? (j.principalSubdivisionCode?.split('-')[1] || j.principalSubdivision || j.countryName || '') : (j.countryName || '');
    const out = { name, region: region && region !== name ? region : '' };
    cacheSet(k, out, 7 * 864e5);
    return out;
  }

  async function weather(lat, lng) {
    const k = key('wx', lat, lng); const c = cacheGet(k); if (c) return c;
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&current=temperature_2m,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code,visibility` +
      `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,visibility` +
      `&forecast_days=7&timezone=auto`;
    const j = await (await fetch(u)).json();
    cacheSet(k, j, 20 * 60000);
    return j;
  }

  // Horizon elevation angle (deg) for each whole-degree azimuth, from a 90 m DEM.
  async function horizon(lat, lng) {
    const k = key('hz2', lat, lng, 3); const c = cacheGet(k); if (c) return c;
    const BEARINGS = 72, DISTS = [250, 600, 1200, 2500, 5000, 9000, 15000, 25000, 40000, 60000];
    const pts = [[lat, lng]];
    for (let b = 0; b < BEARINGS; b++) for (const d of DISTS) pts.push(dest(lat, lng, b * 360 / BEARINGS, d));
    const elev = [];
    const chunks = [];
    for (let i = 0; i < pts.length; i += 100) chunks.push(pts.slice(i, i + 100));
    const res = await Promise.all(chunks.map(ch => fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${ch.map(p => p[0].toFixed(5)).join(',')}&longitude=${ch.map(p => p[1].toFixed(5)).join(',')}`
    ).then(r => r.json())));
    for (const r of res) { if (!r.elevation) throw new Error('elevation'); elev.push(...r.elevation); }
    const h0 = elev[0] + 2;
    const coarse = [];
    for (let b = 0; b < BEARINGS; b++) {
      let best = -2;
      DISTS.forEach((d, j) => {
        const h = elev[1 + b * DISTS.length + j];
        const drop = d * d / (2 * R_EARTH) * (1 - REFRACTION_K);
        best = Math.max(best, Math.atan2(h - h0 - drop, d) * 180 / Math.PI);
      });
      coarse.push(Math.min(30, best));
    }
    const out = [];
    for (let a = 0; a < 360; a++) {
      const x = a / 360 * BEARINGS, i = Math.floor(x) % BEARINGS, f = x - Math.floor(x);
      out.push(+(coarse[i] * (1 - f) + coarse[(i + 1) % BEARINGS] * f).toFixed(2));
    }
    const data = { angles: out, elevation: elev[0] };
    cacheSet(k, data, 30 * 864e5);
    return data;
  }
  function dest(lat, lng, brg, d) {
    const p1 = lat * Math.PI / 180, l1 = lng * Math.PI / 180, b = brg * Math.PI / 180, dr = d / R_EARTH;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
  }

  // Rough "how good will the colour be" rating for a sunrise/sunset hour.
  function quality(lo, mid, hi, precip) {
    if (lo == null) return null;
    const upper = Math.max(mid, hi);
    if (precip >= 60 || lo >= 85) return { label: 'Hidden', tone: 'bad', note: 'Heavy low cloud' };
    if (lo < 45 && upper >= 25 && upper <= 85) return { label: 'Vivid', tone: 'great', note: 'High clouds to catch the colour' };
    if (Math.max(lo, upper) < 15) return { label: 'Clear', tone: 'good', note: 'Clean, bright sun' };
    if (lo >= 60) return { label: 'Muted', tone: 'meh', note: 'Low clouds on the horizon' };
    return { label: 'Good', tone: 'good', note: 'Some cloud colour likely' };
  }

  const WX = {
    0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Drizzle', '🌦️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'],
  };
  const precipKind = code => (code >= 71 && code <= 77) || code === 85 || code === 86 ? 'snow'
    : (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95 ? 'rain' : null;

  global.Geo = { place, weather, horizon, quality, WX, precipKind };
})(self);
