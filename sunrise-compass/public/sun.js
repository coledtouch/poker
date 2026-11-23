// Solar position math adapted from SunCalc (c) Vladimir Agafonkin, BSD-2-Clause.
// https://github.com/mourner/suncalc
(function (global) {
  const PI = Math.PI, rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545;
  const e = rad * 23.4397;
  const toJulian = d => d.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
  const toDays = d => toJulian(d) - J2000;
  const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
  function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + rad * 102.9372 + PI;
  }
  function sunCoords(d) {
    const L = eclipticLongitude(solarMeanAnomaly(d));
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  // Returns compass azimuth (deg, 0 = North, clockwise) and altitude (deg).
  function position(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const c = sunCoords(d), H = siderealTime(d, lw) - c.ra;
    let az = azimuth(H, phi, c.dec) / rad + 180;
    az = ((az % 360) + 360) % 360;
    let alt = altitude(H, phi, c.dec) / rad;
    // simple atmospheric refraction near horizon
    if (alt > -2) alt += 1.02 / Math.tan(rad * (alt + 10.3 / (alt + 5.11))) / 60;
    return { azimuth: az, altitude: alt };
  }

  const J0 = 0.0009;
  const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * PI));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));
  function getSetJ(h, lw, phi, dec, n, M, L) {
    const w = hourAngle(h, phi, dec), a = approxTransit(w, lw, n);
    return solarTransitJ(a, M, L);
  }
  const TIMES = [
    [-0.833, 'sunrise', 'sunset'],
    [-6, 'dawn', 'dusk'],
    [-4, 'blueEnd', 'blueStart'],
    [6, 'goldenEnd', 'golden'],
  ];
  function times(date, lat, lng) {
    // anchor to local noon so we get "today"
    const noon = new Date(date); noon.setHours(12, 0, 0, 0);
    const lw = rad * -lng, phi = rad * lat, d = toDays(noon);
    const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);
    const r = { solarNoon: fromJulian(Jnoon) };
    for (const [ang, rise, set] of TIMES) {
      const Jset = getSetJ(ang * rad, lw, phi, dec, n, M, L);
      const Jrise = Jnoon - (Jset - Jnoon);
      r[rise] = isNaN(Jrise) ? null : fromJulian(Jrise);
      r[set] = isNaN(Jset) ? null : fromJulian(Jset);
    }
    return r;
  }
  // ---- Moon ----
  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d);
    const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
  }
  function moonPosition(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const c = moonCoords(d), H = siderealTime(d, lw) - c.ra;
    let alt = altitude(H, phi, c.dec) / rad;
    if (alt > -2) alt += 1.02 / Math.tan(rad * (alt + 10.3 / (alt + 5.11))) / 60;
    return { azimuth: (((azimuth(H, phi, c.dec) / rad + 180) % 360) + 360) % 360, altitude: alt };
  }
  function moonIllumination(date) {
    const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / PI };
  }
  // Local sidereal time in radians (for rotating the star field)
  const lst = (date, lng) => siderealTime(toDays(date), rad * -lng);
  // Equatorial (RA/Dec, radians) -> local horizon (compass azimuth deg, altitude deg)
  function equToHor(ra, dec, date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, H = siderealTime(toDays(date), lw) - ra;
    let alt = altitude(H, phi, dec) / rad;
    if (alt > -2) alt += 1.02 / Math.tan(rad * (alt + 10.3 / (alt + 5.11))) / 60;
    return { azimuth: (((azimuth(H, phi, dec) / rad + 180) % 360) + 360) % 360, altitude: alt };
  }
  global.Sun = { position, times, moonPosition, moonIllumination, lst, equToHor };
})(self);
