'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const canvas = $('overlay'), ctx = canvas.getContext('2d');
  const video = $('cam');
  const FONT = 'Inter, -apple-system, system-ui, sans-serif';

  const state = {
    lat: null, lng: null, acc: null,
    X: [1, 0, 0], Y: [0, 0, 1], Z: [0, -1, 0], // device axes in world (East, North, Up)
    sensor: false, manual: { heading: 110, pitch: 6 },
    view: 'sky', camOn: false, live: false,
    dayOffset: 0, scrubMin: null,
    fovLong: 66 * D2R,
    day: null, place: null, wx: null, hz: null,
    shownAt: 0,
  };

  // ---------- helpers ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap180 = d => ((d % 360) + 540) % 360 - 180;
  const wrap360 = d => ((d % 360) + 360) % 360;
  const ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const dirVec = (az, alt) => {
    const a = az * D2R, e = alt * D2R;
    return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  };
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compassName = az => DIRS[Math.round(wrap360(az) / 22.5) % 16];
  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  const fmtShort = d => d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '').toLowerCase();
  const fmtDur = m => { m = Math.abs(Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
  const horizonAt = az => {
    if (!state.hz) return 0;
    const a = wrap360(az), i = Math.floor(a), f = a - i;
    return state.hz[i % 360] * (1 - f) + state.hz[(i + 1) % 360] * f;
  };

  // ---------- sky renderer ----------
  let sky = null;
  try { sky = new Sky($('sky'), 0.65); $('skyFallback').hidden = true; } catch (e) { $('sky').hidden = true; }

  // ---------- orientation ----------
  function setFromEuler(alpha, beta, gamma) {
    const cA = Math.cos(alpha * D2R), sA = Math.sin(alpha * D2R);
    const cB = Math.cos(beta * D2R), sB = Math.sin(beta * D2R);
    const cG = Math.cos(gamma * D2R), sG = Math.sin(gamma * D2R);
    const X = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
    const Z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
    smoothAxes(X, Z, 0.16);
  }
  function smoothAxes(X, Z, k) {
    const z = norm(lerp(state.Z, Z, k));
    let x = lerp(state.X, X, k);
    x = norm([x[0] - dot(x, z) * z[0], x[1] - dot(x, z) * z[1], x[2] - dot(x, z) * z[2]]);
    state.Z = z; state.X = x; state.Y = cross(z, x);
  }
  function poseFromHeading(h, p) {
    h *= D2R; p *= D2R;
    const f = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
    const Y = [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)];
    const Z = [-f[0], -f[1], -f[2]];
    return { X: cross(Y, Z), Y, Z };
  }
  function setFromManual() { Object.assign(state, poseFromHeading(state.manual.heading, state.manual.pitch)); }
  const screenAngle = () => ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * D2R;
  function screenBasis(pose = state) {
    const th = screenAngle(), c = Math.cos(th), s = Math.sin(th);
    return {
      right: [c * pose.X[0] - s * pose.Y[0], c * pose.X[1] - s * pose.Y[1], c * pose.X[2] - s * pose.Y[2]],
      up: [s * pose.X[0] + c * pose.Y[0], s * pose.X[1] + c * pose.Y[1], s * pose.X[2] + c * pose.Y[2]],
      fwd: [-pose.Z[0], -pose.Z[1], -pose.Z[2]],
    };
  }
  function cameraHeading() {
    const f = [-state.Z[0], -state.Z[1], -state.Z[2]];
    if (Math.hypot(f[0], f[1]) < 0.15) {
      const y = f[2] < 0 ? state.Y : state.Y.map(v => -v);
      return wrap360(Math.atan2(y[0], y[1]) * R2D);
    }
    return wrap360(Math.atan2(f[0], f[1]) * R2D);
  }
  const cameraPitch = () => Math.asin(clamp(-state.Z[2], -1, 1)) * R2D;

  let gotEvent = false;
  function onOrient(e) {
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) alpha = 360 - e.webkitCompassHeading;
    else if (e.type === 'deviceorientation' && e.absolute !== true && 'ondeviceorientationabsolute' in window) return;
    if (alpha == null || e.beta == null || e.gamma == null) return;
    if (!gotEvent) { gotEvent = true; state.sensor = true; hideToast(); updateFoot(); }
    setFromEuler(alpha, e.beta, e.gamma);
  }
  async function startSensors() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch (_) {}
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
    setTimeout(() => { if (!gotEvent) toast('No compass on this device — drag to look around', 4500); }, 2200);
  }

  // ---------- location & local data ----------
  function startLocation() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve(false); return; }
      let first = true;
      navigator.geolocation.watchPosition(p => {
        const moved = state.lat == null || Math.abs(p.coords.latitude - state.lat) > 0.01 || Math.abs(p.coords.longitude - state.lng) > 0.01;
        state.lat = p.coords.latitude; state.lng = p.coords.longitude; state.acc = p.coords.accuracy;
        try { localStorage.setItem('lastLoc', JSON.stringify([state.lat, state.lng])); } catch (_) {}
        if (moved) { state.day = null; loadLocal(); }
        updateFoot();
        if (first) { first = false; resolve(true); }
      }, err => {
        if (!first) return;
        first = false;
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('lastLoc')); } catch (_) {}
        if (saved) { state.lat = saved[0]; state.lng = saved[1]; loadLocal(); resolve(true); }
        else resolve(err);
      }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 });
    });
  }
  function loadLocal() {
    const { lat, lng } = state;
    Geo.place(lat, lng).then(p => { state.place = p; renderPlace(); }).catch(() => {});
    Geo.weather(lat, lng).then(w => { state.wx = w; renderWx(); lastPanel = 0; }).catch(() => {});
    Geo.horizon(lat, lng).then(h => {
      state.hz = h.angles; state.elevation = h.elevation; state.day = null;
      if (sky) sky.setHorizon(h.angles);
      updateFoot();
    }).catch(() => {});
  }
  function renderPlace() {
    const p = state.place;
    $('place').textContent = p && p.name ? p.name + (p.region ? ', ' + p.region : '') : coordText();
    if (p && p.name) $('introPlace').textContent = `Your sky over ${p.name}`;
  }
  const coordText = () => `${Math.abs(state.lat).toFixed(3)}°${state.lat >= 0 ? 'N' : 'S'} ${Math.abs(state.lng).toFixed(3)}°${state.lng >= 0 ? 'E' : 'W'}`;
  function renderWx() {
    const c = state.wx && state.wx.current; if (!c) return;
    const [, icon] = Geo.WX[c.weather_code] || ['', '🌡️'];
    const unitF = /US|LR|MM/.test(navigator.language.split('-')[1] || '');
    const t = unitF ? Math.round(c.temperature_2m * 9 / 5 + 32) + '°' : Math.round(c.temperature_2m) + '°';
    $('wxChip').innerHTML = `<span>${icon}</span><span>${t}</span>`;
    $('wxChip').title = (Geo.WX[c.weather_code] || ['Weather'])[0];
    $('wxChip').hidden = false;
    initParticles();
  }
  function updateFoot() {
    if (state.lat == null) return;
    const parts = [coordText()];
    if (state.acc) parts.push(`±${Math.round(state.acc)} m`);
    if (state.elevation != null) parts.push(`${Math.round(state.elevation)} m elevation`);
    if (state.view === 'map') parts.push('Imagery © Esri, Maxar, Earthstar Geographics');
    else parts.push(state.hz ? 'Real terrain horizon' : 'Weather: Open-Meteo');
    if (!state.sensor) parts.push('drag to look around');
    $('foot').textContent = parts.join(' · ');
    if (!state.place) renderPlace();
  }

  // ---------- camera ----------
  async function setCamera(on) {
    if (on) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = s; await video.play().catch(() => {});
        video.classList.add('on'); state.camOn = true;
      } catch (_) { state.camOn = false; toast('Camera not available'); }
    } else {
      const s = video.srcObject; if (s) s.getTracks().forEach(t => t.stop());
      video.srcObject = null; video.classList.remove('on'); state.camOn = false;
    }
    $('btnCam').classList.toggle('active', state.camOn);
    try { localStorage.setItem('cam', state.camOn ? '1' : '0'); } catch (_) {}
  }

  // ---------- sun data ----------
  function selectedBaseDate() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + state.dayOffset); return d; }
  function selectedTime() {
    const base = selectedBaseDate();
    if (state.scrubMin == null) { const n = new Date(); base.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()); }
    else base.setMinutes(state.scrubMin);
    return base;
  }
  function dayData() {
    const base = selectedBaseDate();
    if (state.day && state.day.key === base.getTime()) return state.day;
    state.day = computeDay(base);
    return state.day;
  }
  function nextDayData() {
    const base = selectedBaseDate(); base.setDate(base.getDate() + 1);
    if (state.day2 && state.day2.key === base.getTime() && state.day2.hz === !!state.hz) return state.day2;
    state.day2 = computeDay(base); state.day2.hz = !!state.hz;
    return state.day2;
  }
  function computeDay(base) {
    const { lat, lng } = state;
    const times = Sun.times(base, lat, lng);
    const samples = [];
    for (let m = 0; m <= 1440; m += 4) {
      const t = new Date(base.getTime() + m * 60000), p = Sun.position(t, lat, lng);
      samples.push({ t, m, az: p.azimuth, alt: p.altitude, v: dirVec(p.azimuth, p.altitude) });
    }
    const pos = d => d ? Sun.position(d, lat, lng) : null;
    let peak = samples[0];
    for (const s of samples) if (s.alt > peak.alt) peak = s;
    // when the sun's upper edge clears / drops behind the real terrain
    let tRise = null, tSet = null;
    if (state.hz) {
      for (let m = 0; m < 1440; m++) {
        const t = new Date(base.getTime() + m * 60000), t2 = new Date(t.getTime() + 60000);
        const a = Sun.position(t, lat, lng), b = Sun.position(t2, lat, lng);
        const ua = a.altitude + 0.27 - horizonAt(a.azimuth), ub = b.altitude + 0.27 - horizonAt(b.azimuth);
        if (!tRise && ua < 0 && ub >= 0 && t < times.solarNoon) tRise = { t: t2, az: b.azimuth };
        if (ua >= 0 && ub < 0 && t > times.solarNoon) tSet = { t, az: a.azimuth };
        m += Math.abs(ua) > 3 ? 4 : 0;
      }
    }
    return {
      key: base.getTime(), times, samples, peak,
      rise: pos(times.sunrise), set: pos(times.sunset), noon: pos(times.solarNoon),
      tRise, tSet,
    };
  }
  // Next time the (visible) sun is in compass direction hdg, looking from the selected time forward.
  function nextSunAt(hdg, day, tSel) {
    const pick = d => crossingsAt(hdg, d).filter(c => c.alt > horizonAt(hdg) - 0.3 && c.t >= tSel - 5 * 60000);
    let c = pick(day);
    if (c.length) return { ...c[0], when: 'today' };
    c = pick(nextDayData());
    if (c.length) return { ...c[0], when: 'tomorrow' };
    return null;
  }
  function crossingsAt(hdg, day) {
    const out = [], S = day.samples;
    for (let i = 1; i < S.length; i++) {
      const a = wrap180(S[i - 1].az - hdg), b = wrap180(S[i].az - hdg);
      if (Math.abs(a) > 90 || Math.abs(b) > 90) continue;
      if (a === 0 || (a < 0) !== (b < 0)) {
        const f = a === b ? 0 : a / (a - b);
        const alt = S[i - 1].alt + (S[i].alt - S[i - 1].alt) * f;
        if (alt < -1) continue;
        out.push({ t: new Date(S[i - 1].t.getTime() + (S[i].t - S[i - 1].t) * f), alt });
      }
    }
    return out;
  }
  function nearestPathPoint(fwd, day) {
    let best = null, bd = -2;
    for (const s of day.samples) {
      if (s.alt < -1) continue;
      const d = dot(fwd, s.v);
      if (d > bd) { bd = d; best = s; }
    }
    return best ? { s: best, ang: Math.acos(Math.min(1, bd)) * R2D } : null;
  }
  function hourlyIndex(date) {
    const h = state.wx && state.wx.hourly; if (!h) return -1;
    const d = new Date(date.getTime() + 30 * 60000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;
    return h.time.indexOf(k);
  }
  function qualityAt(date) {
    if (!date) return null;
    const i = hourlyIndex(date); if (i < 0) return null;
    const h = state.wx.hourly;
    return Geo.quality(h.cloud_cover_low[i], h.cloud_cover_mid[i], h.cloud_cover_high[i], h.precipitation_probability[i] || 0);
  }

  // ---------- canvas & projection ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initParticles();
  }
  window.addEventListener('resize', resize);
  const focal = () => (Math.max(W, H) / 2) / Math.tan(state.fovLong / 2);
  let basis = null;
  function project(v) {
    const b = basis, dz = dot(b.fwd, v), sx = dot(b.right, v), sy = dot(b.up, v), f = focal();
    if (dz < 0.02) return { behind: true, sx, sy };
    return { x: W / 2 + f * sx / dz, y: H / 2 - f * sy / dz, sx, sy, behind: false };
  }
  const onScreen = (p, m = 0) => !p.behind && p.x >= m && p.x <= W - m && p.y >= m && p.y <= H - m;

  function tracePath(points) {
    ctx.beginPath();
    let pen = false, last = null;
    for (const v of points) {
      const p = project(v);
      if (p.behind || Math.abs(p.x) > W * 4 || Math.abs(p.y) > H * 4) { pen = false; last = null; continue; }
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > Math.max(W, H)) pen = false;
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
      last = p;
    }
  }
  function text(str, x, y, { color = '#fff', size = 13, weight = 600, align = 'center', shadow = true } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 6; }
    ctx.fillStyle = color; ctx.fillText(str, x, y);
    ctx.shadowBlur = 0;
  }
  function badge(lines, x, y, accent, alpha = 1) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.font = `700 14px ${FONT}`;
    const w1 = ctx.measureText(lines[0]).width;
    ctx.font = `500 12px ${FONT}`;
    const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
    const w = Math.max(w1, w2) + 22, h = lines[1] ? 42 : 26;
    const ax = x; x = clamp(x, w / 2 + 8, W - w / 2 - 8);
    const bx = x - w / 2, by = y - h;
    ctx.fillStyle = 'rgba(12,14,28,.62)';
    ctx.beginPath(); ctx.roundRect(bx, by, w, h, 12); ctx.fill();
    ctx.strokeStyle = accent; ctx.globalAlpha = alpha * .7; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = alpha;
    const tx = clamp(ax, bx + 14, bx + w - 14); ctx.beginPath(); ctx.moveTo(tx - 6, by + h); ctx.lineTo(tx, by + h + 7); ctx.lineTo(tx + 6, by + h); ctx.fillStyle = 'rgba(12,14,28,.62)'; ctx.fill();
    text(lines[0], x, by + 14, { color: accent, size: 14, weight: 700, shadow: false });
    if (lines[1]) text(lines[1], x, by + 30, { color: 'rgba(255,255,255,.9)', size: 12, weight: 500, shadow: false });
    ctx.restore();
  }
  function sunGlow(x, y, r, a = 1) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, `rgba(255,250,225,${a})`);
    g.addColorStop(0.22, `rgba(255,214,120,${a * .95})`);
    g.addColorStop(0.3, `rgba(255,170,70,${a * .4})`);
    g.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
  }
  function drawMoon(x, y, r, frac, sunDirScreen) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(sunDirScreen[1], sunDirScreen[0]));
    const glow = ctx.createRadialGradient(0, 0, r, 0, 0, r * 3.5);
    glow.addColorStop(0, `rgba(220,228,255,${0.18 * frac + 0.04})`); glow.addColorStop(1, 'rgba(220,228,255,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, r * 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(40,44,60,.55)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(-r * .3, -r * .3, 0, 0, 0, r);
    g.addColorStop(0, '#fbf8ef'); g.addColorStop(1, '#d9d6cc');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    const rx = Math.abs(r * (1 - 2 * frac));
    if (frac < 0.5) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);
    else ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, Math.PI * 1.5, false);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,120,130,.22)'; // maria
    for (const [mx, my, mr] of [[-.25, -.2, .22], [.15, -.3, .16], [.1, .15, .2], [-.3, .25, .12]]) {
      ctx.beginPath(); ctx.arc(mx * r, my * r, mr * r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- weather particles ----------
  let particles = [], pKind = null;
  function initParticles() {
    const c = state.wx && state.wx.current;
    pKind = c ? Geo.precipKind(c.weather_code) : null;
    particles = [];
    if (!pKind) return;
    const heavy = [65, 67, 75, 82, 86, 95, 96, 99].includes(c.weather_code);
    const n = Math.round((pKind === 'rain' ? 140 : 110) * (heavy ? 1.8 : 1) * (W * H) / (390 * 844));
    for (let i = 0; i < n; i++) particles.push({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, ph: Math.random() * 6.28 });
  }
  function drawParticles(dt, hdg) {
    if (!pKind || !particles.length) return;
    const c = state.wx.current;
    const windTo = (c.wind_direction_10m + 180) % 360;
    const side = Math.sin((windTo - hdg) * D2R) * Math.min(1, c.wind_speed_10m / 30);
    ctx.save();
    if (pKind === 'rain') {
      ctx.strokeStyle = 'rgba(200,215,240,.38)'; ctx.lineCap = 'round';
      for (const p of particles) {
        const vy = 900 * p.z, vx = side * 260 * p.z;
        p.y += vy * dt; p.x += vx * dt;
        if (p.y > H) { p.y = -20; p.x = Math.random() * W; }
        if (p.x > W) p.x -= W; if (p.x < 0) p.x += W;
        ctx.lineWidth = 1.2 * p.z; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - vx * 0.025, p.y - vy * 0.025); ctx.stroke();
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      const t = performance.now() / 1000;
      for (const p of particles) {
        p.y += 60 * p.z * dt; p.x += (side * 50 + Math.sin(t + p.ph) * 18) * p.z * dt;
        if (p.y > H) { p.y = -10; p.x = Math.random() * W; }
        if (p.x > W) p.x -= W; if (p.x < 0) p.x += W;
        ctx.globalAlpha = 0.35 + 0.6 * p.z; ctx.beginPath(); ctx.arc(p.x, p.y, 1 + 2.2 * p.z, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------- real stars, constellations, shooting stars ----------
  const starByName = {};
  for (const s of self.STARS || []) starByName[s[0]] = s;
  const bvColor = bv => bv < 0 ? [190, 210, 255] : bv < 0.4 ? [235, 240, 255] : bv < 0.8 ? [255, 246, 228] : bv < 1.3 ? [255, 215, 170] : [255, 170, 120];
  let meteors = [], nextMeteor = 0;
  function drawNightSky(tSel, sunAlt, now, dt) {
    const k = clamp((-sunAlt - 3) / 9, 0, 1);
    if (k <= 0) return;
    const pos = {};
    for (const s of self.STARS) {
      const h = Sun.equToHor(s[1] * 15 * D2R, s[2] * D2R, tSel, state.lat, state.lng);
      if (h.altitude < horizonAt(h.azimuth)) continue;
      const p = project(dirVec(h.azimuth, h.altitude));
      if (!onScreen(p, -60)) continue;
      pos[s[0]] = p; p.s = s; p.alt = h.altitude;
    }
    // constellation lines + names
    ctx.save(); ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (const [name, lines] of self.CONSTELLATIONS) {
      const asterism = name.includes('Triangle');
      let cx = 0, cy = 0, n = 0;
      ctx.beginPath();
      for (const [a, b] of lines) {
        const pa = pos[a], pb = pos[b]; if (!pa || !pb) continue;
        const dx = pb.x - pa.x, dy = pb.y - pa.y, L = Math.hypot(dx, dy) || 1, g = Math.min(8, L * 0.2);
        ctx.moveTo(pa.x + dx / L * g, pa.y + dy / L * g); ctx.lineTo(pb.x - dx / L * g, pb.y - dy / L * g);
        cx += pa.x + pb.x; cy += pa.y + pb.y; n += 2;
      }
      ctx.setLineDash(asterism ? [2, 6] : []);
      ctx.strokeStyle = `rgba(150,180,255,${(asterism ? 0.22 : 0.32) * k})`; ctx.stroke();
      if (n && !asterism) text(name.toUpperCase(), cx / n, cy / n + 4, { color: `rgba(170,195,255,${0.55 * k})`, size: 10, weight: 600 });
    }
    ctx.setLineDash([]); ctx.restore();
    // stars
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const name in pos) {
      const p = pos[name], [, , , mag, bv] = p.s;
      const ext = clamp(p.alt / 10, 0.25, 1); // dimmer near the horizon
      const tw = 0.82 + 0.18 * Math.sin(now / (160 + (mag * 97 % 90)) + mag * 13) * (1.2 - ext);
      const b = clamp((3.6 - mag) / 4.2, 0.12, 1.3) * k * ext * tw;
      const r = 1.2 + 2.6 * clamp((2.5 - mag) / 4, 0, 1);
      const [cr, cg, cb] = bvColor(bv);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
      g.addColorStop(0, `rgba(255,255,255,${Math.min(1, b)})`);
      g.addColorStop(0.18, `rgba(${cr},${cg},${cb},${0.85 * b})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 5, 0, Math.PI * 2); ctx.fill();
      if (mag < 0.6) { // diffraction spikes on the brightest stars
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.35 * b})`; ctx.lineWidth = 1;
        const L = r * 9 * tw;
        ctx.beginPath(); ctx.moveTo(p.x - L, p.y); ctx.lineTo(p.x + L, p.y); ctx.moveTo(p.x, p.y - L); ctx.lineTo(p.x, p.y + L); ctx.stroke();
      }
    }
    ctx.restore();
    for (const name in pos) {
      const p = pos[name];
      if (p.s[3] < 1.3 || name === 'Polaris') text(name, p.x + 9, p.y - 9, { color: `rgba(220,230,255,${0.7 * k})`, size: 11, weight: 500, align: 'left' });
    }
    // shooting stars
    if (k > 0.7 && !state.camOn) {
      if (!nextMeteor) nextMeteor = now + 4000 + Math.random() * 8000;
      if (now > nextMeteor) {
        const a = (200 + Math.random() * 140) * D2R;
        meteors.push({ x: W * (0.15 + Math.random() * 0.7), y: H * (0.1 + Math.random() * 0.35), vx: Math.cos(a) * 700, vy: Math.abs(Math.sin(a)) * 380 + 120, life: 0, max: 0.6 + Math.random() * 0.5 });
        nextMeteor = now + 6000 + Math.random() * 12000;
      }
    }
    meteors = meteors.filter(m => (m.life += dt) < m.max);
    for (const m of meteors) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      const f = Math.sin(Math.PI * m.life / m.max), tl = 0.16;
      const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * tl, m.y - m.vy * tl);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * f})`); g.addColorStop(0.3, `rgba(190,215,255,${0.5 * f})`); g.addColorStop(1, 'rgba(160,190,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * tl, m.y - m.vy * tl); ctx.stroke();
    }
  }
  function lensFlare(sx, sy, strength, now) {
    if (strength <= 0.01) return;
    const cx = W / 2, cy = H / 2, dx = cx - sx, dy = cy - sy;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    // starburst
    ctx.translate(sx, sy); ctx.rotate(now / 20000);
    for (let i = 0; i < 12; i++) {
      const L = (i % 2 ? 70 : 130) * strength * (0.85 + 0.15 * Math.sin(now / 700 + i));
      const g = ctx.createLinearGradient(0, 0, L, 0);
      g.addColorStop(0, `rgba(255,240,200,${0.35 * strength})`); g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -1.5); ctx.lineTo(L, 0); ctx.lineTo(0, 1.5); ctx.fill();
      ctx.rotate(Math.PI / 6);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // ghosts along the line through the screen centre
    for (const [t, r, c] of [[0.45, 10, '255,200,120'], [0.8, 26, '160,255,200'], [1.15, 8, '255,170,90'], [1.45, 46, '140,170,255'], [1.8, 18, '255,140,190']]) {
      const x = sx + dx * t, y = sy + dy * t;
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
      g.addColorStop(0, `rgba(${c},${0.10 * strength})`); g.addColorStop(0.75, `rgba(${c},${0.06 * strength})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- sun ribbon: the sun's path laid out on a compass strip ----------
  function ribbonRect() {
    const top = $('topbar').getBoundingClientRect().bottom + 4;
    return { x: 10, y: top, w: W - 20, h: 58 };
  }
  function drawRibbon(day, tSel, sunSel, now) {
    const R = ribbonRect(), hdg = cameraHeading(), cx = R.x + R.w / 2;
    const span = 140, ppd = R.w / span;
    const X = az => cx + wrap180(az - hdg) * ppd;
    const inR = x => x > R.x + 6 && x < R.x + R.w - 6;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(R.x, R.y, R.w, R.h, 16);
    ctx.fillStyle = 'rgba(12,14,30,.55)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.clip();
    const base = R.y + R.h - 14;
    // compass ticks
    for (let a = 0; a < 360; a += 5) {
      const x = X(a); if (!inR(x)) continue;
      const major = a % 45 === 0;
      ctx.beginPath(); ctx.moveTo(x, base + 6); ctx.lineTo(x, base + (major ? -2 : a % 15 ? 3 : 1));
      ctx.strokeStyle = major ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.3)'; ctx.stroke();
      if (major) text(DIRS[a / 22.5], x, base + 9, { color: a === 0 ? '#ff8a7a' : 'rgba(255,255,255,.85)', size: 9.5, weight: 800, shadow: false });
    }
    // the sun's daytime track, coloured by height in the sky
    const S = day.samples, ty = R.y + 24;
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i];
      if (b.alt < -0.8 && a.alt < -0.8) continue;
      const xa = X(a.az), xb = X(b.az);
      if (Math.abs(xa - xb) > R.w / 2) continue;
      const hi = clamp(Math.max(a.alt, b.alt) / 40, 0, 1);
      ctx.strokeStyle = `rgb(255,${Math.round(130 + 100 * hi)},${Math.round(60 + 110 * hi)})`;
      ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(xa, ty); ctx.lineTo(xb, ty); ctx.stroke();
    }
    // hour labels along the track
    let lastX = -1e9;
    for (const s2 of S) {
      if (s2.m % 60 || s2.alt < -0.8) continue;
      const x = X(s2.az); if (!inR(x) || Math.abs(x - lastX) < 26) continue; lastX = x;
      ctx.beginPath(); ctx.arc(x, ty, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#2a1a08'; ctx.fill();
      text(fmtShort(s2.t), x, ty - 12, { color: 'rgba(255,240,215,.9)', size: 10, weight: 700, shadow: false });
    }
    // sunrise / sunset ends
    const T = day.times;
    for (const [ev, pos, t, c] of [[day.tRise, day.rise, T.sunrise, '#ff9a4d'], [day.tSet, day.set, T.sunset, '#ff6b88']]) {
      const az = ev ? ev.az : pos && pos.azimuth; if (az == null || !t) continue;
      const x = X(az); if (!inR(x)) continue;
      ctx.beginPath(); ctx.arc(x, ty, 5, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    }
    // the sun at the selected time
    if (sunSel.altitude > -0.8) {
      const x = X(sunSel.azimuth);
      if (inR(x)) {
        const g = ctx.createRadialGradient(x, ty, 0, x, ty, 16);
        g.addColorStop(0, 'rgba(255,252,230,1)'); g.addColorStop(0.35, 'rgba(255,200,90,.95)'); g.addColorStop(1, 'rgba(255,170,60,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, ty, 16 * (1 + 0.08 * Math.sin(now / 300)), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    // centre pointer
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(cx - 7, R.y - 1); ctx.lineTo(cx + 7, R.y - 1); ctx.lineTo(cx, R.y + 8); ctx.closePath(); ctx.fill();
    ctx.fillRect(cx - 0.75, R.y + 6, 1.5, R.h - 6);
    ctx.restore();
  }

  // ---------- find-the-sun guidance ----------
  let findOn = false, locked = false;
  function drawFinder(day, tSel, sunSel, now) {
    if (!findOn) return;
    let target, label;
    const up = sunSel.altitude > horizonAt(sunSel.azimuth) - 0.3;
    if (up) { target = sunSel; label = state.scrubMin == null && state.dayOffset === 0 ? 'the sun' : `the sun at ${fmtTime(tSel)}`; }
    else {
      const nd = tSel < (day.tRise ? day.tRise.t : day.times.sunrise) ? day : nextDayData();
      const ev = nd.tRise || (nd.rise && { az: nd.rise.azimuth, t: nd.times.sunrise });
      if (!ev) return;
      target = { azimuth: ev.az, altitude: horizonAt(ev.az) }; label = `sunrise · ${fmtTime(ev.t)}`;
    }
    const hdg = cameraHeading(), pitch = cameraPitch();
    const dAz = wrap180(target.azimuth - hdg), dAlt = target.altitude - pitch;
    const off = Math.hypot(dAz, state.view === 'map' ? 0 : dAlt);
    const cx = W / 2, cy = H / 2;
    if (off < 5) {
      if (!locked) { locked = true; try { navigator.vibrate && navigator.vibrate([40, 60, 40]); } catch (_) {} }
      const r = 34 + 6 * Math.sin(now / 200);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,214,120,.95)'; ctx.lineWidth = 3; ctx.shadowColor = 'rgba(255,180,60,1)'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      pill(up ? `☀️  You found ${label}` : `🌅  Here's tomorrow's ${label}`, cx, cy + 66, '#ffd877');
      return;
    }
    if (off > 9) locked = false;
    // big arrow toward the target
    let ang;
    if (state.view === 'map' || Math.abs(dAz) > 25) ang = dAz > 0 ? 0 : Math.PI;
    else { const p = project(dirVec(target.azimuth, target.altitude)); ang = p.behind ? Math.atan2(-dAlt, dAz) : Math.atan2(p.y - cy, p.x - cx); }
    const bob = 6 * Math.sin(now / 250);
    ctx.save(); ctx.translate(cx + Math.cos(ang) * (60 + bob), cy + Math.sin(ang) * (60 + bob)); ctx.rotate(ang);
    ctx.shadowColor = 'rgba(255,170,60,.9)'; ctx.shadowBlur = 16;
    ctx.fillStyle = '#ffc456';
    ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(-6, -20); ctx.lineTo(0, 0); ctx.lineTo(-6, 20); ctx.closePath(); ctx.fill();
    ctx.restore();
    const turn = Math.abs(dAz) >= 3 ? `Turn ${Math.abs(Math.round(dAz))}° ${dAz > 0 ? 'right' : 'left'}` : '';
    const tilt = state.view !== 'map' && Math.abs(dAlt) >= 4 ? `tilt ${dAlt > 0 ? 'up' : 'down'} ${Math.abs(Math.round(dAlt))}°` : '';
    pill([turn, tilt].filter(Boolean).join(' · ').replace(/^t/, 'T') + `  →  ${label}`, cx, cy + 66, '#fff');
  }
  function pill(str, x, y, color) {
    ctx.save();
    ctx.font = `700 15px ${FONT}`;
    const w = Math.min(W - 24, ctx.measureText(str).width + 30);
    ctx.fillStyle = 'rgba(12,14,30,.72)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 18, w, 36, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,120,.5)'; ctx.lineWidth = 1; ctx.stroke();
    text(str, x, y + 1, { color, size: 15, weight: 700, shadow: false });
    ctx.restore();
  }

  // ---------- sky view overlay ----------
  function drawSkyOverlay(day, tSel, sunSel, now) {
    const intro = ease((now - state.shownAt) / 1600);
    const hdg = cameraHeading();
    drawNightSky(tSel, sunSel.altitude, now, lastDt);

    // horizon (terrain-following) with compass ticks
    const hzPts = []; for (let a = 0; a <= 360; a += 1) hzPts.push(dirVec(a, horizonAt(a)));
    tracePath(hzPts);
    ctx.strokeStyle = state.camOn ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.22)'; ctx.lineWidth = state.camOn ? 1.5 : 1; ctx.stroke();
    for (let a = 0; a < 360; a += 5) {
      const h = horizonAt(a);
      const p0 = project(dirVec(a, h)), p1 = project(dirVec(a, h + (a % 45 === 0 ? 2.2 : a % 15 === 0 ? 1.2 : 0.6)));
      if (p0.behind || p1.behind || !onScreen(p0, -40)) continue;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = a % 45 === 0 ? 1.6 : 1; ctx.stroke();
      if (a % 45 === 0) text(DIRS[a / 22.5], p0.x, p0.y + 18, { color: a === 0 ? '#ff8a7a' : '#fff', size: 15, weight: 800 });
      else if (a % 15 === 0) text(a + '°', p0.x, p0.y + 15, { color: 'rgba(255,255,255,.55)', size: 10.5, weight: 500 });
    }

    // sun path (animated draw-in)
    const S = day.samples;
    const upto = Math.floor(S.length * intro);
    const vis = S.slice(0, upto);
    const run = (filter, style, glow) => {
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          tracePath(seg);
          ctx.save(); Object.assign(ctx, style);
          if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 14; }
          ctx.stroke(); ctx.restore();
        }
        seg = [];
      };
      for (const s of vis) { if (filter(s)) seg.push(s.v); else { if (seg.length) seg.push(s.v); flush(); } }
      flush();
    };
    ctx.setLineDash([3, 7]);
    run(s => s.alt > -18 && s.alt <= -0.8, { strokeStyle: 'rgba(170,180,255,.4)', lineWidth: 2, lineCap: 'round' });
    ctx.setLineDash([]);
    run(s => s.alt > -0.8, { strokeStyle: 'rgba(255,214,130,.95)', lineWidth: 2.5, lineCap: 'round' }, 'rgba(255,180,80,.9)');
    run(s => s.alt > -0.8 && s.alt < 6, { strokeStyle: 'rgba(255,140,70,1)', lineWidth: 4.5, lineCap: 'round' }, 'rgba(255,120,50,1)');

    for (const s of vis) {
      if (s.m % 60 !== 0 || s.alt < -12) continue;
      const p = project(s.v); if (!onScreen(p, -20)) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.alt > 0 ? '#fff1c9' : 'rgba(180,190,255,.8)'; ctx.fill();
      text(fmtShort(s.t), p.x, p.y - 13, { color: s.alt > 0 ? '#fff' : 'rgba(205,210,255,.8)', size: 11.5, weight: 600 });
    }

    // sunrise / sunset markers on the real horizon
    const pinA = ease((now - state.shownAt - 900) / 900);
    const pin = (ev, fallbackPos, fallbackT, name, color) => {
      const az = ev ? ev.az : fallbackPos && fallbackPos.azimuth, t = ev ? ev.t : fallbackT;
      if (az == null || !t) return;
      const h = horizonAt(az);
      const base = project(dirVec(az, h)), top = project(dirVec(az, h + 7));
      if (base.behind || top.behind || !onScreen(base, -100)) return;
      const lift = (1 - pinA) * 20;
      const grd = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
      grd.addColorStop(0, color); grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grd; ctx.lineWidth = 2; ctx.globalAlpha = pinA;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y + lift); ctx.stroke();
      const pulse = 1 + 0.35 * Math.sin(now / 400);
      ctx.beginPath(); ctx.arc(base.x, base.y, 9 * pulse, 0, Math.PI * 2); ctx.fillStyle = color.replace('1)', '.25)'); ctx.fill();
      ctx.beginPath(); ctx.arc(base.x, base.y, 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 1;
      badge([name, `${fmtTime(t)} · ${Math.round(az)}° ${compassName(az)}`], top.x, top.y - 6 + lift, color, pinA);
    };
    pin(day.tRise, day.rise, day.times.sunrise, 'Sunrise', 'rgba(255,154,77,1)');
    pin(day.tSet, day.set, day.times.sunset, 'Sunset', 'rgba(255,107,136,1)');
    if (day.noon && day.noon.altitude > 0 && intro > 0.6) {
      const p = project(dirVec(day.noon.azimuth, day.noon.altitude));
      if (onScreen(p, -40)) text(`Highest · ${fmtTime(day.times.solarNoon)} · ${Math.round(day.noon.altitude)}°`, p.x, p.y + 22, { color: '#ffd877', size: 12, weight: 700 });
    }

    // moon
    const mp = Sun.moonPosition(tSel, state.lat, state.lng);
    if (mp.altitude > horizonAt(mp.azimuth)) {
      const p = project(dirVec(mp.azimuth, mp.altitude));
      if (onScreen(p, -30)) {
        const ill = Sun.moonIllumination(tSel);
        const sp = project(dirVec(sunSel.azimuth, sunSel.altitude));
        const dir = [sp.sx - p.sx, -(sp.sy - p.sy)];
        const r = Math.max(9, 0.26 * D2R * focal() * 2.4);
        drawMoon(p.x, p.y, r, ill.fraction, Math.hypot(dir[0], dir[1]) > 1e-6 ? dir : [1, 0]);
        text(`Moon · ${Math.round(ill.fraction * 100)}%`, p.x, p.y + r + 14, { color: 'rgba(230,235,255,.85)', size: 11.5, weight: 600 });
      }
    }

    // sun at selected time
    const sp = project(dirVec(sunSel.azimuth, sunSel.altitude));
    const sunUp = sunSel.altitude > horizonAt(sunSel.azimuth) - 0.3;
    if (onScreen(sp, -80)) {
      const r = Math.max(9, 0.27 * D2R * focal() * 2.2);
      const live = state.scrubMin == null && state.dayOffset === 0;
      if (sunUp && onScreen(sp, 0)) lensFlare(sp.x, sp.y, clamp((sunSel.altitude + 1) / 8, 0, 1), now);
      if (state.camOn || !sky) sunGlow(sp.x, sp.y, r * (1 + 0.06 * Math.sin(now / 500)), sunUp ? 1 : 0.4);
      else {
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r * 2.2 + 3 * Math.sin(now / 450), 0, Math.PI * 2);
        ctx.strokeStyle = sunUp ? 'rgba(255,230,170,.55)' : 'rgba(255,230,170,.3)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
      text(live ? (sunUp ? 'Sun now' : 'Sun now · below horizon') : `Sun at ${fmtTime(tSel)}`, sp.x, sp.y + r * 2.2 + 18, { color: '#fff', size: 12.5, weight: 700 });
    }

    // crosshair
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 1.5; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { ctx.moveTo(W / 2 + dx * 9, H / 2 + dy * 9); ctx.lineTo(W / 2 + dx * 28, H / 2 + dy * 28); }
    ctx.stroke(); ctx.restore();

    // edge guides for off-screen targets
    const top = ribbonRect().y + ribbonRect().h + 4;
    const bottom = $('panel').getBoundingClientRect().top - 30;
    let slot = 0;
    const guide = (az, alt, name, color) => {
      if (az == null) return;
      const p = project(dirVec(az, alt));
      if (onScreen(p, 30)) return;
      const delta = Math.round(wrap180(az - hdg)), right = delta >= 0;
      const y = clamp(top + 30 + slot++ * 38, top, bottom), x = right ? W - 14 : 14;
      const bob = Math.sin(now / 350) * 3 * (right ? 1 : -1);
      ctx.save(); ctx.translate(x + bob, y);
      ctx.beginPath();
      if (right) { ctx.moveTo(0, 0); ctx.lineTo(-11, -8); ctx.lineTo(-11, 8); } else { ctx.moveTo(0, 0); ctx.lineTo(11, -8); ctx.lineTo(11, 8); }
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.fill(); ctx.restore();
      text(`${name} · ${Math.abs(delta)}° ${right ? 'right' : 'left'}`, right ? x - 18 : x + 18, y, { color, size: 13, weight: 700, align: right ? 'right' : 'left' });
    };
    if (findOn) return;
    guide(day.tRise ? day.tRise.az : day.rise && day.rise.azimuth, day.tRise ? horizonAt(day.tRise.az) : 0, 'Sunrise', '#ff9a4d');
    if (sunSel.altitude > -6) guide(sunSel.azimuth, sunSel.altitude, 'Sun', '#ffd877');
    guide(day.tSet ? day.tSet.az : day.set && day.set.azimuth, day.tSet ? horizonAt(day.tSet.az) : 0, 'Sunset', '#ff6b88');
  }

  // ---------- map view (satellite + dial) ----------
  const tiles = new Map();
  function tile(z, x, y) {
    const n = 1 << z; x = ((x % n) + n) % n;
    const k = `${z}/${y}/${x}`;
    let t = tiles.get(k);
    if (!t) {
      t = new Image(); t.crossOrigin = 'anonymous'; t.decoding = 'async';
      t.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${k}`;
      tiles.set(k, t);
      if (tiles.size > 300) tiles.delete(tiles.keys().next().value);
    }
    return t.complete && t.naturalWidth ? t : null;
  }
  function drawMap(day, tSel, sunSel, now) {
    const hdg = cameraHeading();
    const panelTop = $('panel').getBoundingClientRect().top;
    const topBar = $('topbar').getBoundingClientRect().bottom;
    const cx = W / 2, cy = (topBar + panelTop) / 2;
    const R = Math.max(70, Math.min(W / 2 - 50, (panelTop - topBar) / 2 - 46));

    // satellite imagery, rotated so you're facing up
    const z = 17, n = 1 << z;
    const wx = (state.lng + 180) / 360 * n * 256;
    const latR = state.lat * D2R;
    const wy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n * 256;
    ctx.save();
    ctx.fillStyle = '#0a0d18'; ctx.fillRect(0, 0, W, H);
    ctx.translate(cx, cy); ctx.rotate(-hdg * D2R);
    const reach = Math.hypot(W, H);
    const tx0 = Math.floor((wx - reach) / 256), tx1 = Math.floor((wx + reach) / 256);
    const ty0 = Math.floor((wy - reach) / 256), ty1 = Math.floor((wy + reach) / 256);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const img = tile(z, tx, ty);
      if (img) ctx.drawImage(img, tx * 256 - wx, ty * 256 - wy, 256.5, 256.5);
    }
    ctx.restore();
    const day01 = clamp((sunSel.altitude + 8) / 20, 0, 1);
    ctx.fillStyle = `rgba(6,8,20,${0.55 - 0.3 * day01})`; ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(4,6,14,.75)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    const pt = (az, alt, rr = R) => {
      const a = (az - hdg) * D2R, r = rr * (1 - Math.max(-15, alt) / 90);
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    };
    const beam = (az, color, t, name) => {
      if (az == null || !t) return;
      const a = (az - hdg) * D2R, L = reach;
      const ex = cx + L * Math.sin(a), ey = cy - L * Math.cos(a);
      const g = ctx.createLinearGradient(cx, cy, ex, ey);
      g.addColorStop(0, color.replace('1)', '0)')); g.addColorStop(0.15, color.replace('1)', '.55)')); g.addColorStop(1, color.replace('1)', '0)'));
      ctx.save();
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + L * Math.sin(a - 0.05), cy - L * Math.cos(a - 0.05));
      ctx.lineTo(cx + L * Math.sin(a + 0.05), cy - L * Math.cos(a + 0.05)); ctx.closePath();
      ctx.fillStyle = g; ctx.globalAlpha = 0.55; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]);
      const [lx, ly] = pt(az, -24);
      badge([name, `${fmtTime(t)} · ${Math.round(az)}°`], lx, ly + 20, color);
    };
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,12,26,.28)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const alt of [30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, R * (1 - alt / 90), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1; ctx.stroke(); }
    if (state.hz) {
      ctx.beginPath();
      for (let a = 0; a <= 360; a += 2) { const [x, y] = pt(a, Math.max(0, horizonAt(a)) * 3); a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = 'rgba(150,220,170,.55)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    beam(day.tRise ? day.tRise.az : day.rise && day.rise.azimuth, 'rgba(255,154,77,1)', day.tRise ? day.tRise.t : day.times.sunrise, 'Sunrise');
    beam(day.tSet ? day.tSet.az : day.set && day.set.azimuth, 'rgba(255,107,136,1)', day.tSet ? day.tSet.t : day.times.sunset, 'Sunset');
    for (let a = 0; a < 360; a += 10) {
      const [x0, y0] = pt(a, 0), [x1, y1] = pt(a, a % 30 ? -3 : -6);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1; ctx.stroke();
      if (a % 90 === 0) { const [x, y] = pt(a, -12); text(DIRS[a / 22.5], x, y, { color: a === 0 ? '#ff8a7a' : '#fff', size: 15, weight: 800 }); }
    }
    ctx.save(); ctx.beginPath(); let pen = false;
    for (const s of day.samples) {
      if (s.alt < 0) { pen = false; continue; }
      const [x, y] = pt(s.az, s.alt);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255,214,130,.95)'; ctx.lineWidth = 3; ctx.shadowColor = 'rgba(255,170,70,.9)'; ctx.shadowBlur = 12; ctx.stroke(); ctx.restore();
    for (const s of day.samples) {
      if (s.m % 60 || s.alt < 0) continue;
      const [x, y] = pt(s.az, s.alt);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff1c9'; ctx.fill();
      text(fmtShort(s.t), x, y - 11, { color: 'rgba(255,255,255,.9)', size: 10.5, weight: 600 });
    }
    const [sx, sy] = pt(sunSel.azimuth, sunSel.altitude);
    sunGlow(sx, sy, 7 * (1 + 0.08 * Math.sin(now / 450)), sunSel.altitude > -1 ? 1 : 0.4);
    const ph = (now / 1200) % 1;
    ctx.beginPath(); ctx.arc(cx, cy, 8 + 14 * ph, 0, Math.PI * 2); ctx.fillStyle = `rgba(120,200,255,${0.4 * (1 - ph)})`; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fillStyle = '#7fc8ff'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    const half = state.fovLong / 2 * (Math.min(W, H) / Math.max(W, H));
    const cone = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    cone.addColorStop(0, 'rgba(127,200,255,.35)'); cone.addColorStop(1, 'rgba(127,200,255,0)');
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half); ctx.closePath(); ctx.fillStyle = cone; ctx.fill();
  }

  // ---------- panel ----------
  let lastPanel = 0;
  function setHTML(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  function setQ(el, q) {
    if (!q) { el.hidden = true; return; }
    el.hidden = false; el.className = 'q ' + q.tone; setText(el, q.label); el.title = q.note;
  }
  function updatePanel(day, tSel, sunSel, now) {
    if (now - lastPanel < 150) return; lastPanel = now;
    const hdg = cameraHeading(), pitch = cameraPitch();
    setText($('hdgDeg'), Math.round(hdg) + '°');
    setText($('hdgDir'), compassName(hdg));
    setText($('elev'), (pitch >= 0 ? '↑ ' : '↓ ') + Math.abs(Math.round(pitch)) + '°');

    const T = day.times;
    const riseT = day.tRise ? day.tRise.t : T.sunrise, setT = day.tSet ? day.tSet.t : T.sunset;
    const riseAz = day.tRise ? day.tRise.az : day.rise && day.rise.azimuth;
    const setAz = day.tSet ? day.tSet.az : day.set && day.set.azimuth;
    setText($('tRise'), fmtTime(riseT));
    setText($('aRise'), riseT ? `${Math.round(riseAz)}° ${compassName(riseAz)}` + (day.tRise && T.sunrise && day.tRise.t - T.sunrise > 90000 ? ' · over terrain' : '') : (day.peak.alt > 0 ? 'Sun stays up' : 'No sunrise'));
    setText($('tSet'), fmtTime(setT));
    setText($('aSet'), setT ? `${Math.round(setAz)}° ${compassName(setAz)}` : '');
    setText($('tNoon'), fmtTime(T.solarNoon));
    setText($('aNoon'), `${Math.round(day.peak.alt)}° up · ${compassName(day.peak.az)}`);
    setQ($('qRise'), qualityAt(T.sunrise)); setQ($('qSet'), qualityAt(T.sunset));
    const g = [];
    if (T.sunrise && T.goldenEnd) g.push(`<b>Golden hour</b> ${fmtTime(T.sunrise)}–${fmtTime(T.goldenEnd)}`);
    if (T.golden && T.sunset) g.push(`<b>Evening</b> ${fmtTime(T.golden)}–${fmtTime(T.sunset)}`);
    if (T.dawn) g.push(`<b>First light</b> ${fmtTime(T.dawn)}`);
    setHTML($('golden'), g.join(' · '));

    const live = state.scrubMin == null && state.dayOffset === 0;
    const nowD = new Date();
    let hero, sub, icon = '', q = null;
    if (live) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const tt = Sun.times(tomorrow, state.lat, state.lng);
      const evs = [[riseT, 'Sunrise', '', T.sunrise], [setT, 'Sunset', 'set', T.sunset], [tt.sunrise, 'Sunrise', '', tt.sunrise]].filter(e => e[0] && e[0] > nowD);
      if (evs.length) {
        const [t, name, cls, qt] = evs[0];
        hero = `${name} in <b>${fmtDur((t - nowD) / 60000)}</b>`;
        sub = `${t.getDate() !== nowD.getDate() ? 'Tomorrow ' : ''}${fmtTime(t)}`;
        icon = cls || (sunSel.altitude < -6 ? 'night' : '');
        q = qualityAt(qt);
        if (q) sub += ` · ${q.note}`;
      } else { hero = 'The sun stays up'; sub = ''; }
    } else {
      hero = `Sunrise <b>${fmtTime(riseT)}</b>`;
      sub = selectedBaseDate().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      q = qualityAt(T.sunrise);
    }
    setHTML($('heroMain'), hero); setText($('heroSub'), sub);
    $('heroIcon').className = 'heroIcon ' + icon;
    setQ($('heroQ'), q);

    let html;
    {
      const facingSun = sunSel.altitude > horizonAt(sunSel.azimuth) - 0.3 && Math.abs(wrap180(sunSel.azimuth - hdg)) < 8;
      const dirName = `${Math.round(hdg)}° ${compassName(hdg)}`;
      const nx = nextSunAt(hdg, day, tSel);
      const dayWord = d => state.dayOffset === 0 ? (d === 'today' ? 'today' : 'tomorrow') : (d === 'today' ? 'that day' : 'the next day');
      if (facingSun) {
        html = `<div class="big">☀️ You're facing the sun${live ? '' : ' at ' + fmtTime(tSel)}</div><div class="dim">It's ${Math.round(sunSel.altitude)}° above the horizon · sets ${fmtTime(setT)}</div>`;
      } else if (nx) {
        const rel = live ? relTime(nx.t).replace(' · ', '') : '';
        const golden = nx.alt < 6 ? ' · golden light' : '';
        html = `<div class="big">Sun shines this way at <b>${fmtTime(nx.t)}</b> ${dayWord(nx.when)}</div><div class="dim">${dirName} · ${Math.max(0, Math.round(nx.alt))}° above the horizon${rel ? ' · ' + rel : ''}${golden}</div>`;
      } else if (riseT) {
        const dr = wrap180(riseAz - hdg), ds = wrap180(setAz - hdg);
        const [nm, dd] = Math.abs(dr) < Math.abs(ds) ? ['sunrise', dr] : ['sunset', ds];
        html = `<div class="big">No sun from ${dirName}</div><div class="dim">Turn <b>${Math.abs(Math.round(dd))}° ${dd > 0 ? 'right' : 'left'}</b> to face the ${nm}, or tap ☀ to find the sun</div>`;
      } else html = `<div class="big">${day.peak.alt > 0 ? 'The sun circles the sky all day here' : 'The sun stays below the horizon all day'}</div>`;
    }
    setHTML($('pointText'), html);

    setText($('timeLabel'), live ? `Now · ${fmtTime(tSel)}` : fmtTime(tSel));
    $('btnNow').hidden = live;
    if (state.scrubMin == null) $('timeRange').value = tSel.getHours() * 60 + tSel.getMinutes();
    const d = state.dayOffset;
    setText($('dayLabel'), d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : selectedBaseDate().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
    paintTrack(day);

    if (!sky && !state.camOn) {
      const a = sunSel.altitude;
      $('skyFallback').style.background = a > 8 ? 'linear-gradient(#2b5fa6, #6f9fd6 60%, #a9c6e6)'
        : a > -1 ? 'linear-gradient(#2a3f78, #b5677a 65%, #ffb36b)'
        : a > -8 ? 'linear-gradient(#0f1838, #3b3460 60%, #7a4a5d)' : 'linear-gradient(#050816, #0d1430 60%, #1b1d3a)';
    }
  }
  let trackKey = '';
  function paintTrack(day) {
    const k = day.key + ':' + !!state.hz; if (trackKey === k) return; trackKey = k;
    const stops = [];
    for (let m = 0; m <= 1440; m += 60) {
      const a = day.samples[Math.min(day.samples.length - 1, m / 4)].alt;
      const c = a > 10 ? '#5b8fd4' : a > 3 ? '#e0a060' : a > -1 ? '#ff8a4d' : a > -6 ? '#7a4a7a' : a > -12 ? '#2a2a55' : '#141832';
      stops.push(`${c} ${(m / 1440 * 100).toFixed(1)}%`);
    }
    $('trackDay').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  }
  function relTime(t) {
    if (state.dayOffset !== 0) return '';
    const m = Math.round((t - Date.now()) / 60000);
    if (Math.abs(m) < 2) return ' · now';
    return m > 0 ? ` · in ${fmtDur(m)}` : ` · ${fmtDur(m)} ago`;
  }

  // ---------- main loop ----------
  let lastFrame = performance.now(), lastDt = 0.016;
  const introT0 = performance.now();
  function eqMatrix(date) {
    const phi = state.lat * D2R, th = Sun.lst(date, state.lng);
    // true equatorial frame: x -> RA 0h, y -> RA 6h, z -> celestial pole (used for the Milky Way)
    const P = [0, Math.cos(phi), Math.sin(phi)], A = [0, -Math.sin(phi), Math.cos(phi)], Wd = [-1, 0, 0];
    const Xc = A.map((v, i) => v * Math.cos(th) + Wd[i] * Math.sin(th));
    const Yc = A.map((v, i) => v * Math.sin(th) - Wd[i] * Math.cos(th));
    const e = v => [v[0], v[2], v[1]];
    const x = e(Xc), y = e(Yc), z = e(P);
    return new Float32Array([x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);
  }
  function renderSky(pose, sunPos, date, now, extra = {}) {
    if (!sky) return;
    const b = screenBasis(pose);
    const c = state.wx && state.wx.current;
    let wind = [0.006, 0.002], cloud = 0.22, fog = 0;
    if (c) {
      const to = (c.wind_direction_10m + 180) * D2R, sp = 0.002 + c.wind_speed_10m * 0.0009;
      wind = [Math.sin(to) * sp, Math.cos(to) * sp];
      cloud = clamp(c.cloud_cover / 100, 0, 1) * 0.95;
      fog = c.weather_code === 45 || c.weather_code === 48 ? 0.55 : clamp(1 - (c.visibility ?? 20000) / 12000, 0, 0.5);
    }
    const mp = Sun.moonPosition(date, state.lat, state.lng);
    sky.render({
      right: b.right, up: b.up, fwd: b.fwd, focal: focal(),
      moon: dirVec(mp.azimuth, mp.altitude), moonFrac: Sun.moonIllumination(date).fraction,
      sun: dirVec(sunPos.azimuth, sunPos.altitude), time: now / 1000,
      cloud: extra.cloud ?? cloud, fog, wind, eq: eqMatrix(date), dim: extra.dim ?? 1,
    });
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now; lastDt = dt;
    ctx.clearRect(0, 0, W, H);

    if (!state.live) { // intro: a slow sunrise over your own horizon
      const t = (now - introT0) / 1000;
      const hdg = state.day && state.day.rise ? state.day.rise.azimuth : 112;
      const pose = poseFromHeading(hdg + Math.sin(t * 0.05) * 3, 7);
      const cyc = t % 26;
      const alt = -4.5 + 13 * ease(cyc / 22) - (cyc > 23 ? (cyc - 23) * 4 : 0);
      if (state.lat == null) { state.lat = 40; state.lng = 0; renderSky(pose, { azimuth: hdg + 2, altitude: alt }, new Date(), now, { cloud: 0.35 }); state.lat = null; state.lng = null; }
      else renderSky(pose, { azimuth: hdg + 2, altitude: alt }, new Date(), now, { cloud: state.wx ? undefined : 0.35 });
      return;
    }
    if (state.lat == null) return;
    if (!state.sensor) setFromManual();
    basis = screenBasis();
    const day = dayData(), tSel = selectedTime();
    const sunSel = Sun.position(tSel, state.lat, state.lng);
    const hdg = cameraHeading();
    if (state.view === 'sky') {
      if (!state.camOn) renderSky(state, sunSel, tSel, now);
      drawParticles(dt, hdg);
      drawSkyOverlay(day, tSel, sunSel, now);
    } else {
      drawMap(day, tSel, sunSel, now);
    }
    drawFinder(day, tSel, sunSel, now);
    drawRibbon(day, tSel, sunSel, now);
    updatePanel(day, tSel, sunSel, now);
  }

  // ---------- UI ----------
  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { $('toast').classList.remove('show'); }
  function applyView() {
    $('btnView').classList.toggle('active', state.view === 'map');
    $('sky').style.visibility = state.view === 'map' || state.camOn ? 'hidden' : 'visible';
    video.style.visibility = state.view === 'map' ? 'hidden' : 'visible';
    updateFoot(); lastPanel = 0;
  }
  $('btnFind').onclick = () => {
    findOn = !findOn; locked = false;
    $('btnFind').classList.toggle('active', findOn);
    if (findOn) { $('panel').classList.add('collapsed'); toast(state.sensor ? 'Follow the arrow to the sun' : 'Drag the sky to follow the arrow', 2200); }
  };
  $('btnView').onclick = () => { state.view = state.view === 'sky' ? 'map' : 'sky'; applyView(); };
  $('btnCam').onclick = async () => { await setCamera(!state.camOn); if (state.camOn && state.view === 'map') state.view = 'sky'; applyView(); };
  $('handle').onclick = () => { const c = $('panel').classList.toggle('collapsed'); try { localStorage.setItem('panel', c ? 'c' : 'o'); } catch (_) {} };
  try { if (localStorage.getItem('panel') === 'o') $('panel').classList.remove('collapsed'); } catch (_) {}
  let swipe = null;
  $('panel').addEventListener('pointerdown', e => { if (e.target.closest('input,button:not(#handle)')) return; swipe = e.clientY; });
  $('panel').addEventListener('pointerup', e => {
    if (swipe == null) return; const dy = e.clientY - swipe; swipe = null;
    if (Math.abs(dy) > 30) { $('panel').classList.toggle('collapsed', dy > 0); try { localStorage.setItem('panel', dy > 0 ? 'c' : 'o'); } catch (_) {} }
  });
  $('timeRange').addEventListener('input', e => { state.scrubMin = +e.target.value; lastPanel = 0; });
  $('btnNow').onclick = () => { state.scrubMin = null; state.dayOffset = 0; lastPanel = 0; };
  $('dayPrev').onclick = () => { state.dayOffset--; lastPanel = 0; state.shownAt = performance.now() - 600; };
  $('dayNext').onclick = () => { state.dayOffset++; lastPanel = 0; state.shownAt = performance.now() - 600; };

  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || state.sensor) return;
    const k = (state.fovLong * R2D) / Math.max(W, H);
    state.manual.heading = wrap360(state.manual.heading - (e.clientX - drag.x) * k);
    if (state.view === 'sky') state.manual.pitch = clamp(state.manual.pitch + (e.clientY - drag.y) * k, -60, 85);
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => drag = null);
  canvas.addEventListener('pointercancel', () => drag = null);

  async function keepAwake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.live) keepAwake(); });

  $('btnStart').onclick = async () => {
    $('btnStart').disabled = true; $('btnStart').firstElementChild.textContent = 'Finding your sky…';
    startSensors();
    const wantCam = (() => { try { return localStorage.getItem('cam') === '1'; } catch (_) { return false; } })();
    const loc = await startLocation();
    if (loc !== true) {
      $('introErr').textContent = 'Location is needed to work out your sunrise. Please allow location access and try again.';
      $('btnStart').disabled = false; $('btnStart').firstElementChild.textContent = 'Try again';
      return;
    }
    if (wantCam && navigator.mediaDevices) await setCamera(true);
    const t = Sun.times(new Date(), state.lat, state.lng);
    if (t.sunrise) state.manual.heading = Sun.position(t.sunrise, state.lat, state.lng).azimuth;
    $('intro').classList.add('leaving');
    setTimeout(() => $('intro').hidden = true, 1200);
    state.live = true; state.shownAt = performance.now() + 300;
    document.body.classList.add('live');
    applyView(); keepAwake(); updateFoot();
  };

  // warm start: if we already know where you are, personalise the intro
  try {
    const saved = JSON.parse(localStorage.getItem('lastLoc'));
    if (saved) { state.lat = saved[0]; state.lng = saved[1]; dayData(); loadLocal(); }
  } catch (_) {}

  resize();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
