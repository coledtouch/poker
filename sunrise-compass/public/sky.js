'use strict';
// Physically based sky renderer (WebGL1).
// Atmospheric scattering adapted from glsl-atmosphere by Rye Terrell (Unlicense).
(function (global) {
  const VS = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
  const FS = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform vec3 uR, uU, uF;     // screen right / up / forward in (East, Up, North)
uniform float uFocal;
uniform vec3 uSun;           // sun direction (E,U,N)
uniform float uTime, uCloud, uFog, uStars;
uniform vec2 uWind;
uniform mat3 uEq;            // world -> celestial
uniform sampler2D uHorizon;  // terrain horizon angle by azimuth
uniform float uDim;
#define PI 3.14159265
#define RP 6371e3
#define RA 6471e3
#define G 0.758
#define SHR 8e3
#define SHM 1.2e3
const vec3 KRLH = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float KMIE = 21e-6;

vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float a = dot(rd, rd), b = 2.0 * dot(rd, r0), c = dot(r0, r0) - sr * sr, d = b * b - 4.0 * a * c;
  if (d < 0.0) return vec2(1e5, -1e5);
  return vec2((-b - sqrt(d)) / (2.0 * a), (-b + sqrt(d)) / (2.0 * a));
}
vec3 atmosphere(vec3 r, vec3 pSun) {
  vec3 r0 = vec3(0.0, RP + 2.0, 0.0);
  vec2 p = rsi(r0, r, RA);
  if (p.x > p.y) return vec3(0.0);
  p.y = min(p.y, rsi(r0, r, RP).x);
  float iStep = (p.y - p.x) / 12.0, iTime = 0.0;
  vec3 tR = vec3(0.0), tM = vec3(0.0);
  float iOdR = 0.0, iOdM = 0.0;
  float mu = dot(r, pSun), mumu = mu * mu, gg = G * G;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * G, 1.5) * (2.0 + gg));
  for (int i = 0; i < 12; i++) {
    vec3 iPos = r0 + r * (iTime + iStep * 0.5);
    float iH = length(iPos) - RP;
    float odR = exp(-iH / SHR) * iStep, odM = exp(-iH / SHM) * iStep;
    iOdR += odR; iOdM += odM;
    float jStep = rsi(iPos, pSun, RA).y / 6.0, jTime = 0.0, jOdR = 0.0, jOdM = 0.0;
    for (int j = 0; j < 6; j++) {
      vec3 jPos = iPos + pSun * (jTime + jStep * 0.5);
      float jH = length(jPos) - RP;
      jOdR += exp(-jH / SHR) * jStep; jOdM += exp(-jH / SHM) * jStep;
      jTime += jStep;
    }
    vec3 attn = exp(-(KMIE * (iOdM + jOdM) + KRLH * (iOdR + jOdR)));
    tR += odR * attn; tM += odM * attn;
    iTime += iStep;
  }
  return 22.0 * (pR * KRLH * tR + pM * KMIE * tM);
}
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 x) {
  vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
vec3 stars(vec3 d) {
  vec3 q = (uEq * d) * 160.0;
  vec3 c = floor(q);
  float h = hash(c);
  if (h < 0.93) return vec3(0.0);
  vec3 o = vec3(hash(c + 3.1), hash(c + 7.7), hash(c + 1.9)) * 0.6 + 0.2;
  float dist = length(q - c - o);
  float mag = pow((h - 0.93) / 0.07, 6.0);
  float tw = 0.7 + 0.3 * sin(uTime * (2.0 + 5.0 * hash(c + 9.0)) + h * 60.0);
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash(c + 5.0));
  return tint * smoothstep(0.32, 0.0, dist) * (0.25 + 2.8 * mag) * tw;
}
void main() {
  vec2 px = (vUv - 0.5) * uRes;
  vec3 rd = normalize(uF * uFocal + uR * px.x + uU * px.y);
  vec3 sun = normalize(uSun);
  float az = atan(rd.x, rd.z) / (2.0 * PI);
  float hz = texture2D(uHorizon, vec2(fract(az), 0.5)).r * 32.0 - 2.0; // degrees
  float viewAlt = degrees(asin(clamp(rd.y, -1.0, 1.0)));
  bool ground = viewAlt < hz;

  vec3 skyDir = rd; skyDir.y = max(skyDir.y, 0.002); skyDir = normalize(skyDir);
  vec3 col = atmosphere(skyDir, sun);
  float night = 1.0 - smoothstep(-0.32, 0.02, sun.y);
  col *= 1.0 - 0.96 * night;
  col += vec3(0.0025, 0.004, 0.011) * (0.4 + 0.6 * night) * (1.0 - 0.5 * skyDir.y);

  // light colour for clouds and terrain
  float dayL = smoothstep(-0.16, 0.12, sun.y);
  vec3 sunCol = mix(vec3(1.0, 0.42, 0.22), vec3(1.0, 0.96, 0.9), smoothstep(0.0, 0.4, sun.y));

  if (!ground) {
    // sun disc
    float sd = dot(rd, sun);
    float sunHidden = step(degrees(asin(sun.y)), hz);
    col += sunCol * 40.0 * smoothstep(0.99996, 0.99998, sd) * (1.0 - sunHidden) * smoothstep(-0.02, 0.0, sun.y);
    // stars
    col += stars(rd) * uStars * night * smoothstep(0.0, 0.08, rd.y);
    // clouds
    if (uCloud > 0.01 && rd.y > 0.0) {
      float t = 1.0 / (rd.y + 0.035);
      vec2 uv = rd.xz * t * 0.9 + uWind * uTime;
      float n = fbm(uv + 0.35 * fbm(uv * 0.6 - uWind * uTime * 0.3));
      float lo = 1.02 - uCloud * 0.9;
      float cov = smoothstep(lo, lo + 0.28, n) * smoothstep(0.0, 0.14, rd.y);
      float silver = pow(max(dot(rd, sun), 0.0), 5.0);
      float thick = smoothstep(lo, lo + 0.6, n);
      vec3 cc = sunCol * dayL * (0.95 + 1.1 * silver) * (1.0 - 0.55 * thick) + col * 0.5 + vec3(0.012, 0.014, 0.02);
      col = mix(col, cc, cov * 0.92);
    }
  } else {
    float depth = clamp((hz - viewAlt) * 0.35, 0.0, 1.0);
    vec3 g = vec3(0.045, 0.05, 0.045) * (0.15 + 1.6 * dayL) + sunCol * 0.04 * dayL;
    col = mix(col * 0.55, g, smoothstep(0.0, 1.0, depth));
  }
  col = mix(col, vec3(0.55, 0.57, 0.6) * (0.08 + 0.9 * dayL), uFog * (ground ? 0.5 : 0.7) * (1.0 - clamp(rd.y * 2.0, 0.0, 0.7)));
  col = 1.0 - exp(-col * mix(2.2, 1.15, dayL));
  col *= uDim;
  col += (hash2(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

  class Sky {
    constructor(canvas, scale = 0.5) {
      this.canvas = canvas; this.scale = scale;
      const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('no webgl');
      this.gl = gl;
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr); this.pr = pr;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const n of ['uRes', 'uR', 'uU', 'uF', 'uFocal', 'uSun', 'uTime', 'uCloud', 'uFog', 'uStars', 'uWind', 'uEq', 'uHorizon', 'uDim'])
        this.u[n] = gl.getUniformLocation(pr, n);
      this.tex = gl.createTexture();
      this.setHorizon(null);
    }
    // angles: array of horizon elevation (deg) for azimuth 0..359, or null for flat
    setHorizon(angles) {
      const gl = this.gl, N = 256, data = new Uint8Array(N * 4);
      for (let i = 0; i < N; i++) {
        let v = 0;
        if (angles) {
          const a = i / N * 360, i0 = Math.floor(a) % 360, f = a - Math.floor(a);
          v = angles[i0] * (1 - f) + angles[(i0 + 1) % 360] * f;
        }
        const b = Math.max(0, Math.min(255, Math.round((v + 2) / 32 * 255)));
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    // all direction vectors in (East, North, Up); focal in CSS px
    render(o) {
      const gl = this.gl, c = this.canvas;
      const w = Math.max(1, Math.round(c.clientWidth * this.scale)), h = Math.max(1, Math.round(c.clientHeight * this.scale));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h);
      const v = a => [a[0], a[2], a[1]]; // ENU -> (E,U,N)
      gl.uniform2f(this.u.uRes, w, h);
      gl.uniform3fv(this.u.uR, v(o.right)); gl.uniform3fv(this.u.uU, v(o.up)); gl.uniform3fv(this.u.uF, v(o.fwd));
      gl.uniform1f(this.u.uFocal, o.focal * this.scale);
      gl.uniform3fv(this.u.uSun, v(o.sun));
      gl.uniform1f(this.u.uTime, o.time);
      gl.uniform1f(this.u.uCloud, o.cloud || 0);
      gl.uniform1f(this.u.uFog, o.fog || 0);
      gl.uniform1f(this.u.uStars, o.stars ?? 1);
      gl.uniform1f(this.u.uDim, o.dim ?? 1);
      gl.uniform2fv(this.u.uWind, o.wind || [0.01, 0.004]);
      gl.uniformMatrix3fv(this.u.uEq, false, o.eq);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.u.uHorizon, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
  global.Sky = Sky;
})(self);
