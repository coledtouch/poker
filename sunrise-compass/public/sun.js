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
  global.Sun = { position, times };
})(self);
