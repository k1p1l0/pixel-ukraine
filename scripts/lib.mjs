// Shared helpers for the Pixel Path scripts. No dependencies: Node 18+ only.
//   - geometry on the sphere (distances, cumulative length, locate, Douglas-Peucker, line encoding)
//   - polite HTTP (a User-Agent, a minimum gap between requests per host, retries, a disk cache)
//   - a small PNG decoder/encoder (8-bit and palette PNGs, which is what Terrarium tiles and
//     RetroDiffusion return), so nobody has to npm install anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

// ------------------------------------------------------------------ arguments
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
export const readJSON = (f, d) => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d;
export const writeJSON = (f, v, pretty) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, pretty ? 2 : 0)); };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
// every value of a repeatable flag: --theme a --theme b -> ['a', 'b']
export const multi = (flag, argv = process.argv.slice(2)) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] !== undefined ? acc.concat(argv[i + 1]) : acc), []);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ geometry
export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;
export function haversine(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// [[lon, lat], ...] -> cumulative metres from the first point
export function cumulative(points) {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) out[i] = out[i - 1] + haversine(...points[i - 1], ...points[i]);
  return out;
}
// The point at distance d along the line (binary search on the cumulative lengths)
export function locate(points, cum, d) {
  const n = points.length;
  if (d <= 0) return { lon: points[0][0], lat: points[0][1] };
  if (d >= cum[n - 1]) return { lon: points[n - 1][0], lat: points[n - 1][1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo], t = seg > 0 ? (d - cum[lo]) / seg : 0, a = points[lo], b = points[hi];
  return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t };
}
// Douglas-Peucker in local metres; tolerance in metres
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [ax, ay] = points[a], [bx, by] = points[b];
    const k = Math.cos(((ay + by) / 2) * RAD) * RAD * EARTH_R, kk = RAD * EARTH_R;
    const dx = (bx - ax) * k, dy = (by - ay) * kk, len = Math.hypot(dx, dy);
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (points[i][0] - ax) * k, py = (points[i][1] - ay) * kk;
      const dd = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (dd > worst) { worst = dd; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
// Delta-encoded integer coordinates (1e-5 degrees, about a metre)
export function encodeLine(points, q = 1e5) {
  const out = []; let px = 0, py = 0;
  for (const [lon, lat] of points) { const x = Math.round(lon * q), y = Math.round(lat * q); if (out.length && x === px && y === py) continue; out.push(x - px, y - py); px = x; py = y; }
  return out;
}

// ------------------------------------------------------------------ polite HTTP
// Every public service we use asks for an identifying User-Agent and for modest request rates.
export const USER_AGENT = process.env.PIXEL_PATH_USER_AGENT || 'pixel-path-skill/1.0 (personal project; https://github.com/jonwheatley/pixel-path)';
const lastHit = new Map();
async function gap(host, ms) { const t = lastHit.get(host) || 0, wait = t + ms - Date.now(); if (wait > 0) await sleep(wait); lastHit.set(host, Date.now()); }

// fetch with a disk cache, a per-host minimum gap and retries with back-off.
// opts: { cacheDir, gapMs, method, body, headers, tries, timeoutMs, binary, accept(text) }
export async function politeFetch(url, opts = {}) {
  const { cacheDir, gapMs = 1000, method = 'GET', body, headers = {}, tries = 6, timeoutMs = 120000, binary = false, accept = () => true, cacheKey } = opts;
  const key = createHash('sha1').update(cacheKey ?? (method + url + (body || ''))).digest('hex').slice(0, 20);   // cacheKey: the same answer from any mirror
  const file = cacheDir && join(cacheDir, key + (binary ? '.bin' : '.txt'));
  if (file && existsSync(file)) return binary ? readFileSync(file) : readFileSync(file, 'utf8');
  for (const u of opts.alsoCachedAs || []) { const f2 = cacheDir && join(cacheDir, createHash('sha1').update(method + u + (body || '')).digest('hex').slice(0, 20) + (binary ? '.bin' : '.txt')); if (f2 && existsSync(f2)) return binary ? readFileSync(f2) : readFileSync(f2, 'utf8'); }   // an answer cached from one mirror serves them all
  const host = new URL(url).host;
  let last = '';
  for (let i = 0; i < tries; i++) {
    await gap(host, gapMs);
    try {
      const r = await fetch(url, { method, body, headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404 && binary) return null;           // e.g. an elevation tile over open sea
      if (r.ok) {
        const out = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
        if (binary || accept(out)) { if (file) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, out); } return out; }
        last = 'unexpected body: ' + String(out).slice(0, 120);
      } else last = `HTTP ${r.status}`;
      if (r.status === 400) break;                             // a bad query will not get better
    } catch (e) { last = e.message; }
    const wait = Math.min(60000, 4000 * 2 ** i);
    console.error(`  ${host}: ${last}; retrying in ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
  throw Error(`${host} failed after ${tries} tries: ${last}`);
}

// ------------------------------------------------------------------ PNG
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// -> { width, height, data: Uint8Array RGBA }
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 8, type = 6, inter = 0, palette = null, trns = null; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len); p += 12 + len;
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
    else if (t === 'PLTE') palette = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
  }
  if (inter) throw Error('interlaced PNGs are not supported');
  if (depth === 16) throw Error('16-bit PNGs are not supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3;
  const raw = inflateSync(Buffer.concat(idat)), px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {                               // undo the per-row filters
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[o + x - bpp] : 0, b = y ? px[o - stride + x] : 0, c = y && x >= bpp ? px[o - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[o + x] = v;
    }
  }
  const out = new Uint8Array(w * h * 4), sample = (y, i) => { const bit = i * depth, byte = px[y * stride + (bit >> 3)]; return depth === 8 ? byte : (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (type === 3) { const k = sample(y, x); out[o] = palette[k * 3]; out[o + 1] = palette[k * 3 + 1]; out[o + 2] = palette[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
    else if (type === 0 || type === 4) { const v = type === 0 ? sample(y, x) * (255 / ((1 << depth) - 1)) : px[y * stride + x * 2]; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = type === 4 ? px[y * stride + x * 2 + 1] : 255; }
    else { const i = y * stride + x * ch; out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; out[o + 3] = ch === 4 ? px[i + 3] : 255; }
  }
  return { width: w, height: h, data: out };
}
export function encodePNG({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export const readPNG = f => decodePNG(readFileSync(f));
export const writePNG = (f, img) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, encodePNG(img)); };

// ------------------------------------------------------------------ the RetroDiffusion key
// Read at request time and never printed, logged or written anywhere. Two places, in order:
//   1. the RETRODIFFUSION_API_KEY environment variable (set it in your own terminal, not in a chat);
//   2. on macOS, the login Keychain item with service "pixel-path" (or RD_KEYCHAIN_SERVICE / RD_KEYCHAIN_ACCOUNT):
//        security add-generic-password -s pixel-path -a retrodiffusion -w      (it prompts for the key)
let cachedKey = null;
export function rdKey() {
  if (cachedKey) return cachedKey;
  if (process.env.RETRODIFFUSION_API_KEY) return (cachedKey = process.env.RETRODIFFUSION_API_KEY.trim());
  if (process.platform === 'darwin') {
    const a = ['find-generic-password', '-s', process.env.RD_KEYCHAIN_SERVICE || 'pixel-path', '-w']; if (process.env.RD_KEYCHAIN_ACCOUNT) a.splice(1, 0, '-a', process.env.RD_KEYCHAIN_ACCOUNT);
    const r = spawnSync('security', a, { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return (cachedKey = r.stdout.trim());
  }
  return null;
}

// ------------------------------------------------------------------ tiny raster helpers (contact sheets, montages)
// a 3 x 5 pixel font for labels; unknown characters print as a dot
const F35 = { A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010', Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001110', '-': '000000111000000', '.': '000000000000010', ':': '000010000010000', '/': '001001010100100', ' ': '000000000000000', '%': '101001010100101', '$': '011110010011110', '?': '110001010000010', '!': '010010010000010', '(': '010100100100010', ')': '010001001001010', '+': '000010111010000', '=': '000111000111000', '>': '100010001010100', '<': '001010100010001', ',': '000000000010100' };
export function newImage(w, h, rgb = [0, 0, 0]) { const data = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; } return { width: w, height: h, data }; }
export function fillRect(img, x0, y0, w, h, rgb) { for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) { const i = (y * img.width + x) * 4; img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255; } }
export function drawText(img, x, y, s, rgb = [255, 255, 255], k = 1) { let cx = x; for (const ch of String(s).toUpperCase()) { const g = F35[ch] || '000000000000010'; for (let j = 0; j < 15; j++) if (g[j] === '1') fillRect(img, cx + (j % 3) * k, y + Math.floor(j / 3) * k, k, k, rgb); cx += 4 * k; } return cx; }
// copy src (RGBA) into dst at (x, y), scaled to w x h by nearest neighbour, alpha-blended over what is there
export function blit(dst, src, x, y, w, h) { for (let j = 0; j < h; j++) { const sy = Math.min(src.height - 1, Math.floor(j * src.height / h)), Y = y + j; if (Y < 0 || Y >= dst.height) continue;
  for (let i = 0; i < w; i++) { const sx = Math.min(src.width - 1, Math.floor(i * src.width / w)), X = x + i; if (X < 0 || X >= dst.width) continue; const s = (sy * src.width + sx) * 4, d = (Y * dst.width + X) * 4, a = src.data[s + 3] / 255; if (!a) continue;
    for (let c = 0; c < 3; c++) dst.data[d + c] = src.data[s + c] * a + dst.data[d + c] * (1 - a); dst.data[d + 3] = 255; } } }
