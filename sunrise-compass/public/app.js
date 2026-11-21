'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const canvas = $('overlay'), ctx = canvas.getContext('2d');
  const video = $('cam');

  const state = {
    lat: null, lng: null, acc: null,
    // device axes expressed in world frame (East, North, Up)
    X: [1, 0, 0], Y: [0, 0, 1], Z: [0, -1, 0],
    sensor: false, manual: { heading: 90, pitch: 5 },
    view: 'ar', camOn: false,
    dayOffset: 0, scrubMin: null,
    fovLong: 66 * D2R,
    day: null, // cached day data
  };

  // ---------- vector helpers ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const wrap180 = d => ((d % 360) + 540) % 360 - 180;
  const wrap360 = d => ((d % 360) + 360) % 360;
  const dirVec = (az, alt) => {
    const a = az * D2R, e = alt * D2R;
    return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  };
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compassName = az => DIRS[Math.round(wrap360(az) / 22.5) % 16];
  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  const fmtShort = d => d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '').toLowerCase();

  // ---------- orientation ----------
  function setFromEuler(alpha, beta, gamma) {
    const cA = Math.cos(alpha * D2R), sA = Math.sin(alpha * D2R);
    const cB = Math.cos(beta * D2R), sB = Math.sin(beta * D2R);
    const cG = Math.cos(gamma * D2R), sG = Math.sin(gamma * D2R);
    const X = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
    const Z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
    smoothAxes(X, Z, 0.18);
  }
  function smoothAxes(X, Z, k) {
    let z = norm(lerp(state.Z, Z, k));
    let x = lerp(state.X, X, k);
    x = norm([x[0] - dot(x, z) * z[0], x[1] - dot(x, z) * z[1], x[2] - dot(x, z) * z[2]]);
    state.Z = z; state.X = x; state.Y = cross(z, x);
  }
  function setFromManual() {
    const h = state.manual.heading * D2R, p = state.manual.pitch * D2R;
    const f = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
    const Y = [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)];
    const Z = [-f[0], -f[1], -f[2]];
    state.Z = Z; state.Y = Y; state.X = cross(Y, Z);
  }
  function screenAngle() {
    const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return (a || 0) * D2R;
  }
  function cameraHeading() {
    const f = [-state.Z[0], -state.Z[1], -state.Z[2]];
    if (Math.hypot(f[0], f[1]) < 0.15) { // pointing straight up/down: use screen-top direction
      const y = f[2] < 0 ? state.Y : state.Y.map(v => -v);
      return wrap360(Math.atan2(y[0], y[1]) * R2D);
    }
    return wrap360(Math.atan2(f[0], f[1]) * R2D);
  }
  const cameraPitch = () => Math.asin(Math.max(-1, Math.min(1, -state.Z[2]))) * R2D;

  let gotEvent = false;
  function onOrient(e) {
    if (e.alpha == null && e.webkitCompassHeading == null) return;
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      alpha = 360 - e.webkitCompassHeading; // iOS: true compass heading
    } else if (e.type === 'deviceorientation' && e.absolute !== true && 'ondeviceorientationabsolute' in window) {
      return; // prefer the absolute event on Android
    }
    if (alpha == null || e.beta == null || e.gamma == null) return;
    if (!gotEvent) { gotEvent = true; state.sensor = true; $('toast').hidden = true; if (state.lat != null) updateLocText(); }
    setFromEuler(alpha, e.beta, e.gamma);
  }
  async function startSensors() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') throw new Error('denied');
      }
    } catch (_) { /* fall back to manual */ }
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
    setTimeout(() => {
      if (!gotEvent) {
        setFromManual();
        toast('No compass found — drag the screen to look around', 4500);
      }
    }, 1800);
  }

  // ---------- location ----------
  function startLocation() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve(false); return; }
      let first = true;
      navigator.geolocation.watchPosition(p => {
        const moved = state.lat == null || Math.abs(p.coords.latitude - state.lat) > 0.01 || Math.abs(p.coords.longitude - state.lng) > 0.01;
        state.lat = p.coords.latitude; state.lng = p.coords.longitude; state.acc = p.coords.accuracy;
        try { localStorage.setItem('lastLoc', JSON.stringify([state.lat, state.lng])); } catch (_) {}
        if (moved) state.day = null;
        updateLocText();
        if (first) { first = false; resolve(true); }
      }, err => {
        if (first) {
          first = false;
          let saved = null;
          try { saved = JSON.parse(localStorage.getItem('lastLoc')); } catch (_) {}
          if (saved) { state.lat = saved[0]; state.lng = saved[1]; updateLocText('(last known)'); resolve(true); }
          else resolve(err);
        }
      }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 });
    });
  }
  function updateLocText(extra = '') {
    const ns = state.lat >= 0 ? 'N' : 'S', ew = state.lng >= 0 ? 'E' : 'W';
    $('loc').textContent = `${Math.abs(state.lat).toFixed(4)}° ${ns}, ${Math.abs(state.lng).toFixed(4)}° ${ew}` +
      (state.acc ? ` · ±${Math.round(state.acc)} m` : '') + (extra ? ' ' + extra : '') +
      (state.sensor ? '' : ' · drag to look around');
  }

  // ---------- camera ----------
  async function setCamera(on) {
    if (on) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = s; await video.play().catch(() => {});
        video.classList.add('on'); state.camOn = true;
      } catch (_) { state.camOn = false; toast('Camera not available — showing sky view'); }
    } else {
      const s = video.srcObject; if (s) s.getTracks().forEach(t => t.stop());
      video.srcObject = null; video.classList.remove('on'); state.camOn = false;
    }
    $('btnCam').classList.toggle('active', state.camOn);
    try { localStorage.setItem('cam', state.camOn ? '1' : '0'); } catch (_) {}
  }

  // ---------- sun data ----------
  function selectedBaseDate() {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + state.dayOffset); return d;
  }
  function selectedTime() {
    const base = selectedBaseDate();
    if (state.scrubMin == null) {
      const n = new Date();
      base.setHours(n.getHours(), n.getMinutes(), n.getSeconds());
    } else base.setMinutes(state.scrubMin);
    return base;
  }
  function dayData() {
    const base = selectedBaseDate();
    if (state.day && state.day.key === base.getTime()) return state.day;
    const { lat, lng } = state;
    const times = Sun.times(base, lat, lng);
    const samples = [];
    for (let m = 0; m <= 1440; m += 4) {
      const t = new Date(base.getTime() + m * 60000);
      const p = Sun.position(t, lat, lng);
      samples.push({ t, m, az: p.azimuth, alt: p.altitude, v: dirVec(p.azimuth, p.altitude) });
    }
    const pos = d => d ? Sun.position(d, lat, lng) : null;
    let peak = samples[0];
    for (const s of samples) if (s.alt > peak.alt) peak = s;
    state.day = {
      key: base.getTime(), times, samples, peak,
      rise: pos(times.sunrise), set: pos(times.sunset), noon: pos(times.solarNoon),
    };
    return state.day;
  }

  // When does the sun appear in compass direction `hdg` (any altitude above horizon)?
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
  // Point on today's (above-horizon) path closest to the crosshair direction
  function nearestPathPoint(fwd, day) {
    let best = null, bd = -2;
    for (const s of day.samples) {
      if (s.alt < -1) continue;
      const d = dot(fwd, s.v);
      if (d > bd) { bd = d; best = s; }
    }
    return best ? { s: best, ang: Math.acos(Math.min(1, bd)) * R2D } : null;
  }

  // ---------- projection ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);

  function project(v) {
    const dx = dot(state.X, v), dy = dot(state.Y, v), dz = dot(state.Z, v);
    const th = screenAngle(), c = Math.cos(th), s = Math.sin(th);
    const sx = dx * c - dy * s, sy = dx * s + dy * c;
    const f = (Math.max(W, H) / 2) / Math.tan(state.fovLong / 2);
    if (dz > -0.02) return { behind: true, sx, sy };
    return { x: W / 2 + f * sx / -dz, y: H / 2 - f * sy / -dz, sx, sy, behind: false };
  }
  const onScreen = (p, m = 0) => !p.behind && p.x >= m && p.x <= W - m && p.y >= m && p.y <= H - m;

  // ---------- drawing (AR) ----------
  function polyline(points, style) {
    ctx.beginPath();
    let pen = false, last = null;
    for (const v of points) {
      const p = project(v);
      if (p.behind || Math.abs(p.x) > W * 4 || Math.abs(p.y) > H * 4) { pen = false; last = null; continue; }
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > Math.max(W, H)) pen = false;
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
      last = p;
    }
    Object.assign(ctx, style); ctx.stroke();
  }
  function label(text, x, y, color = '#fff', size = 13, weight = 600, align = 'center') {
    ctx.font = `${weight} ${size}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  }
  function drawSunDisc(x, y, r, alpha = 1) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
    g.addColorStop(0, `rgba(255,244,200,${alpha})`);
    g.addColorStop(0.28, `rgba(255,190,70,${alpha})`);
    g.addColorStop(0.32, `rgba(255,170,60,${0.45 * alpha})`);
    g.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
  }

  function drawAR(day, tSel, sunSel) {
    // horizon + ticks
    const hz = []; for (let a = 0; a <= 360; a += 2) hz.push(dirVec(a, 0));
    polyline(hz, { strokeStyle: 'rgba(255,255,255,.55)', lineWidth: 1.5 });
    for (let a = 0; a < 360; a += 10) {
      const p0 = project(dirVec(a, 0)), p1 = project(dirVec(a, a % 30 ? 1.2 : 2.5));
      if (p0.behind || p1.behind || !onScreen(p0, -50)) continue;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1; ctx.stroke();
      if (a % 45 === 0) label(DIRS[a / 22.5], p0.x, p0.y + 16, a === 0 ? '#ff7a6a' : '#fff', 15, 700);
      else if (a % 30 === 0) label(a + '°', p0.x, p0.y + 14, 'rgba(255,255,255,.7)', 11, 500);
    }

    // sun path: below-horizon faint, golden-hour gold, day bright
    const S = day.samples;
    const seg = (filter, style) => {
      let run = [];
      const flush = () => { if (run.length > 1) polyline(run, style); run = []; };
      for (const s of S) { if (filter(s)) run.push(s.v); else { if (run.length) run.push(s.v); flush(); } }
      flush();
    };
    ctx.setLineDash([4, 6]);
    seg(s => s.alt > -18 && s.alt <= -0.8, { strokeStyle: 'rgba(160,170,255,.45)', lineWidth: 2 });
    ctx.setLineDash([]);
    seg(s => s.alt > -0.8, { strokeStyle: 'rgba(255,200,90,.9)', lineWidth: 3 });
    seg(s => s.alt > -0.8 && s.alt < 6, { strokeStyle: 'rgba(255,130,50,.95)', lineWidth: 5 });

    // hour markers
    for (const s of S) {
      if (s.m % 60 !== 0 || s.alt < -12) continue;
      const p = project(s.v); if (!onScreen(p, -20)) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = s.alt > 0 ? '#ffe2a0' : 'rgba(170,180,255,.8)'; ctx.fill();
      label(fmtShort(s.t), p.x, p.y - 14, s.alt > 0 ? '#fff' : 'rgba(200,205,255,.85)', 12, 600);
    }

    // sunrise / sunset / peak pins
    const pin = (pos, t, name, color) => {
      if (!pos || !t) return;
      const base = project(dirVec(pos.azimuth, 0)), top = project(dirVec(pos.azimuth, 9));
      if (base.behind || top.behind || !onScreen(base, -80)) return;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(base.x, base.y, 6, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      label(name, top.x, top.y - 22, color, 15, 800);
      label(`${fmtTime(t)} · ${Math.round(pos.azimuth)}°`, top.x, top.y - 5, '#fff', 13, 600);
    };
    pin(day.rise, day.times.sunrise, 'Sunrise', '#ff8a3d');
    pin(day.set, day.times.sunset, 'Sunset', '#ff5e7a');
    if (day.noon && day.noon.altitude > 0) {
      const p = project(dirVec(day.noon.azimuth, day.noon.altitude));
      if (onScreen(p, -40)) label(`Highest ${fmtTime(day.times.solarNoon)} · ${Math.round(day.noon.altitude)}°`, p.x, p.y + 20, '#ffd76a', 12, 700);
    }

    // sun at selected time
    const sp = project(dirVec(sunSel.azimuth, sunSel.altitude));
    if (onScreen(sp, -60)) {
      const f = (Math.max(W, H) / 2) / Math.tan(state.fovLong / 2);
      const r = Math.max(10, 0.27 * D2R * f * 2.2);
      drawSunDisc(sp.x, sp.y, r, sunSel.altitude > -1 ? 1 : 0.45);
      label(state.scrubMin == null && state.dayOffset === 0 ? 'Sun now' : `Sun ${fmtTime(tSel)}`, sp.x, sp.y + r * 1.6 + 10, '#fff', 13, 700);
    }

    // crosshair
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 - 26, H / 2); ctx.lineTo(W / 2 - 8, H / 2); ctx.moveTo(W / 2 + 8, H / 2); ctx.lineTo(W / 2 + 26, H / 2);
    ctx.moveTo(W / 2, H / 2 - 26); ctx.lineTo(W / 2, H / 2 - 8); ctx.moveTo(W / 2, H / 2 + 8); ctx.lineTo(W / 2, H / 2 + 26);
    ctx.stroke();

    // off-screen guides
    const hdg = cameraHeading();
    const guide = (pos, name, color, i) => {
      if (!pos) return;
      const p = project(dirVec(pos.azimuth, pos.altitude ?? 0));
      if (onScreen(p, 30)) return;
      const delta = Math.round(wrap180(pos.azimuth - hdg));
      const right = delta >= 0;
      const top = $('topbar').getBoundingClientRect().bottom + 30;
      const bottom = $('panel').getBoundingClientRect().top - 24;
      const y = Math.min(bottom, top + 34 + i * 34);
      const x = right ? W - 12 : 12;
      ctx.beginPath();
      if (right) { ctx.moveTo(x, y); ctx.lineTo(x - 12, y - 8); ctx.lineTo(x - 12, y + 8); }
      else { ctx.moveTo(x, y); ctx.lineTo(x + 12, y - 8); ctx.lineTo(x + 12, y + 8); }
      ctx.fillStyle = color; ctx.fill();
      label(`${name} ${Math.abs(delta)}° ${right ? 'right' : 'left'}`, right ? x - 18 : x + 18, y, color, 13, 700, right ? 'right' : 'left');
    };
    guide(day.rise, 'Sunrise', '#ff8a3d', 0);
    guide(sunSel.altitude > -6 ? sunSel : null, 'Sun', '#ffd76a', 1);
    guide(day.set, 'Sunset', '#ff5e7a', 2);
  }

  // ---------- drawing (Map / top-down dial) ----------
  function drawMap(day, tSel, sunSel) {
    const hdg = cameraHeading();
    const panelTop = $('panel').getBoundingClientRect().top;
    const topBar = $('topbar').getBoundingClientRect().bottom;
    const cx = W / 2, cy = (topBar + panelTop) / 2;
    const R = Math.max(60, Math.min(W / 2 - 56, (panelTop - topBar) / 2 - 58));
    const pt = (az, alt) => {
      const a = (az - hdg) * D2R;
      const r = R * (1 - Math.max(-15, alt) / 90);
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    };
    ctx.fillStyle = 'rgba(8,12,28,.55)';
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.17, 0, Math.PI * 2); ctx.fill();
    // altitude rings
    for (const alt of [0, 30, 60]) {
      ctx.beginPath(); ctx.arc(cx, cy, R * (1 - alt / 90), 0, Math.PI * 2);
      ctx.strokeStyle = alt === 0 ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.15)'; ctx.lineWidth = alt === 0 ? 1.5 : 1; ctx.stroke();
    }
    // field-of-view wedge (where you're facing)
    const half = state.fovLong / 2 * (Math.min(W, H) / Math.max(W, H));
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R * 1.17, -Math.PI / 2 - half, -Math.PI / 2 + half); ctx.closePath();
    ctx.fillStyle = 'rgba(255,200,90,.12)'; ctx.fill();
    // degree ticks + cardinals
    for (let a = 0; a < 360; a += 10) {
      const [x0, y0] = pt(a, 0), [x1, y1] = pt(a, a % 30 ? -3 : -6);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.stroke();
      if (a % 90 === 0) { const [x, y] = pt(a, -11); label(DIRS[a / 22.5], x, y, a === 0 ? '#ff7a6a' : '#fff', 15, 800); }
    }
    // rise/set rays
    const ray = (pos, t, name, color) => {
      if (!pos || !t) return;
      const [x, y] = pt(pos.azimuth, 0);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      const [lx, ly] = pt(pos.azimuth, -26);
      label(name, lx, ly - 8, color, 13, 800); label(fmtTime(t), lx, ly + 8, '#fff', 12, 600);
    };
    ray(day.rise, day.times.sunrise, 'Sunrise', '#ff8a3d');
    ray(day.set, day.times.sunset, 'Sunset', '#ff5e7a');
    // path
    ctx.beginPath(); let pen = false;
    for (const s of day.samples) {
      if (s.alt < 0) { pen = false; continue; }
      const [x, y] = pt(s.az, s.alt);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255,200,90,.95)'; ctx.lineWidth = 3; ctx.stroke();
    for (const s of day.samples) {
      if (s.m % 60 || s.alt < 0) continue;
      const [x, y] = pt(s.az, s.alt);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#ffe2a0'; ctx.fill();
      label(fmtShort(s.t), x, y - 11, 'rgba(255,255,255,.85)', 10, 600);
    }
    // sun
    const [sx, sy] = pt(sunSel.azimuth, sunSel.altitude);
    drawSunDisc(sx, sy, 8, sunSel.altitude > -1 ? 1 : 0.4);
    // you
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = '#7fc8ff'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy - R * 1.17 - 2); ctx.lineTo(cx - 8, cy - R * 1.17 - 14); ctx.lineTo(cx + 8, cy - R * 1.17 - 14); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
  }

  function relTime(t) {
    if (state.dayOffset !== 0) return '';
    const m = Math.round((t - Date.now()) / 60000);
    if (Math.abs(m) < 2) return ', now';
    const a = Math.abs(m), str = a >= 60 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${a} min`;
    return m > 0 ? `, in ${str}` : `, ${str} ago`;
  }

  // ---------- panel text ----------
  let lastPanel = 0;
  function updatePanel(day, tSel, sunSel, now) {
    if (now - lastPanel < 120) return; lastPanel = now;
    const hdg = cameraHeading(), pitch = cameraPitch();
    $('hdgDeg').textContent = Math.round(hdg) + '°';
    $('hdgDir').textContent = compassName(hdg);
    $('elev').textContent = (pitch >= 0 ? '↑ ' : '↓ ') + Math.abs(Math.round(pitch)) + '°';

    const T = day.times;
    $('tRise').textContent = fmtTime(T.sunrise);
    $('aRise').textContent = day.rise && T.sunrise ? `${Math.round(day.rise.azimuth)}° ${compassName(day.rise.azimuth)}` : (day.peak.alt > 0 ? 'Sun stays up' : 'No sunrise');
    $('tSet').textContent = fmtTime(T.sunset);
    $('aSet').textContent = day.set && T.sunset ? `${Math.round(day.set.azimuth)}° ${compassName(day.set.azimuth)}` : '';
    $('tNoon').textContent = fmtTime(T.solarNoon);
    $('aNoon').textContent = `${Math.round(day.peak.alt)}° up · ${compassName(day.peak.az)}`;
    const g = [];
    if (T.sunrise && T.goldenEnd) g.push(`<b>Morning golden hour</b> ${fmtTime(T.sunrise)}–${fmtTime(T.goldenEnd)}`);
    if (T.golden && T.sunset) g.push(`<b>Evening</b> ${fmtTime(T.golden)}–${fmtTime(T.sunset)}`);
    $('golden').innerHTML = g.join(' · ') || (T.dawn ? `First light ${fmtTime(T.dawn)}` : '');

    // what's in the crosshair
    const fwd = [-state.Z[0], -state.Z[1], -state.Z[2]];
    const near = nearestPathPoint(fwd, day);
    const cr = crossingsAt(hdg, day);
    let html;
    if (near && near.ang < 7) {
      html = `The sun will be right here at <b>${fmtTime(near.s.t)}</b> <span style="color:var(--muted)">(${Math.round(near.s.alt)}° above the horizon${relTime(near.s.t)})</span>`;
    } else if (cr.length) {
      const parts = cr.map(c => `<b>${fmtTime(c.t)}</b> at ${Math.max(0, Math.round(c.alt))}° high`);
      const low = cr.every(c => c.alt < 6);
      html = `Sun shines from ${Math.round(hdg)}° ${compassName(hdg)} at ${parts.join(' and ')}` + (low ? ' — golden light 🌅' : '');
    } else if (day.rise && T.sunrise) {
      const dr = wrap180(day.rise.azimuth - hdg), ds = wrap180(day.set.azimuth - hdg);
      const closer = Math.abs(dr) < Math.abs(ds) ? ['sunrise', dr] : ['sunset', ds];
      html = `No sun from this direction today. Turn <b>${Math.abs(Math.round(closer[1]))}° ${closer[1] > 0 ? 'right' : 'left'}</b> for the ${closer[0]}.`;
    } else {
      html = day.peak.alt > 0 ? 'The sun circles the sky all day here.' : 'The sun stays below the horizon all day here.';
    }
    $('pointText').innerHTML = html;

    // time scrubber labels
    const live = state.scrubMin == null;
    $('timeLabel').textContent = live && state.dayOffset === 0 ? `Now ${fmtTime(tSel)}` : fmtTime(tSel);
    $('btnNow').hidden = live && state.dayOffset === 0;
    if (live) $('timeRange').value = tSel.getHours() * 60 + tSel.getMinutes();
    const base = selectedBaseDate();
    $('dayLabel').textContent = state.dayOffset === 0 ? 'Today' : state.dayOffset === 1 ? 'Tomorrow' : state.dayOffset === -1 ? 'Yesterday'
      : base.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    // sky tint when camera off
    if (!state.camOn) {
      const a = sunSel.altitude;
      $('sky').style.background = a > 8 ? 'linear-gradient(#2b5fa6, #6f9fd6 60%, #a9c6e6)'
        : a > -1 ? 'linear-gradient(#2a3f78, #b5677a 65%, #ffb36b)'
        : a > -8 ? 'linear-gradient(#0f1838, #3b3460 60%, #7a4a5d)'
        : 'linear-gradient(#050816, #0d1430 60%, #1b1d3a)';
    }
  }

  // ---------- main loop ----------
  function frame(now) {
    requestAnimationFrame(frame);
    if (state.lat == null) return;
    ctx.clearRect(0, 0, W, H);
    if (!state.sensor) setFromManual();
    const day = dayData();
    const tSel = selectedTime();
    const sunSel = Sun.position(tSel, state.lat, state.lng);
    if (state.view === 'ar') drawAR(day, tSel, sunSel); else drawMap(day, tSel, sunSel);
    updatePanel(day, tSel, sunSel, now);
  }

  // ---------- UI ----------
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
  }
  $('btnView').onclick = () => {
    state.view = state.view === 'ar' ? 'map' : 'ar';
    $('btnView').textContent = state.view === 'ar' ? 'Map' : 'Sky';
    $('btnView').classList.toggle('active', state.view === 'map');
  };
  $('btnCam').onclick = () => setCamera(!state.camOn);
  $('timeRange').addEventListener('input', e => { state.scrubMin = +e.target.value; lastPanel = 0; });
  $('btnNow').onclick = () => { state.scrubMin = null; state.dayOffset = 0; lastPanel = 0; };
  $('dayPrev').onclick = () => { state.dayOffset--; lastPanel = 0; };
  $('dayNext').onclick = () => { state.dayOffset++; lastPanel = 0; };

  // drag to look around when there is no compass
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || state.sensor) return;
    const k = (state.fovLong * R2D) / Math.max(W, H);
    state.manual.heading = wrap360(state.manual.heading - (e.clientX - drag.x) * k);
    if (state.view === 'ar') state.manual.pitch = Math.max(-80, Math.min(85, state.manual.pitch + (e.clientY - drag.y) * k));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => drag = null);
  canvas.addEventListener('pointercancel', () => drag = null);

  async function keepAwake() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('intro').hidden) keepAwake(); });

  $('btnStart').onclick = async () => {
    $('btnStart').disabled = true; $('btnStart').textContent = 'Starting…';
    startSensors();
    const wantCam = (() => { try { return localStorage.getItem('cam') !== '0'; } catch (_) { return true; } })();
    const camP = wantCam && navigator.mediaDevices ? setCamera(true) : Promise.resolve();
    const loc = await startLocation();
    if (loc !== true) {
      $('introErr').textContent = 'Location is needed to work out your sunrise. Please allow location access and try again.';
      $('btnStart').disabled = false; $('btnStart').textContent = 'Try again';
      return;
    }
    await camP;
    $('intro').hidden = true; $('topbar').hidden = false; $('panel').hidden = false;
    keepAwake();
    try { localStorage.setItem('started', '1'); } catch (_) {}
  };

  resize();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
