// Bundles everything in public/ into a single Worker script (dist/worker.js).
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};
const files = {};
const walk = dir => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const ext = extname(f);
    if (!TYPES[ext]) continue;
    const buf = readFileSync(p);
    files['/' + relative('public', p)] = { type: TYPES[ext], b64: buf.toString('base64'), etag: createHash('sha1').update(buf).digest('hex').slice(0, 16) };
  }
};
walk('public');
const src = `const FILES = ${JSON.stringify(files)};
const cache = new Map();
const HEADERS = {
  'Permissions-Policy': 'geolocation=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
  'X-Content-Type-Options': 'nosniff',
};
export default {
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    let f = FILES[path];
    if (!f) { if (extname(path)) return new Response('Not found', { status: 404 }); path = '/index.html'; f = FILES[path]; }
    if (req.headers.get('If-None-Match') === '"' + f.etag + '"') return new Response(null, { status: 304 });
    let body = cache.get(path);
    if (!body) { body = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)); cache.set(path, body); }
    const noCache = path === '/sw.js' || path.endsWith('.html') || path.endsWith('.webmanifest');
    return new Response(body, { headers: { ...HEADERS, 'Content-Type': f.type, ETag: '"' + f.etag + '"',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600' } });
  },
};
function extname(p) { const i = p.lastIndexOf('.'); return i > p.lastIndexOf('/') ? p.slice(i) : ''; }
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/worker.js', src);
console.log('bundled', Object.keys(files).length, 'files');
