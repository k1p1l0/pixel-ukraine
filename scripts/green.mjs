#!/usr/bin/env node
// Roadside tree belts from ESA WorldCover 2021 v200 (10 m land cover; © ESA WorldCover project 2021, contains modified
// Copernicus Sentinel data, CC BY 4.0) into baked chunks. For every sample and side: d = metres from the route line to the
// near edge of the first tree belt, w = its depth (5 m steps; 0,0 = no tree within 120 m; w 120 = a wood that runs past
// the corridor). Stored as chunk.green = [[dL, wL, dR, wR], ...], one per sample; layout.js plants the belts from it.
// OpenStreetMap misses most of these (the field windbreaks and roadside belts of Ukraine): about 29% of rural roadside
// has a belt at 15-60 m where the bake says farm, grass or lawn.
//   node scripts/green.mjs --trip trips/my-trip [--from-chunk 0 --to-chunk 5] [--force] [--cache DIR]
// No dependencies: the public cloud-optimised GeoTIFFs are read with HTTP range requests, one 1024x1024 block (about
// 40 KB) at a time, and every block is kept under --cache (default TRIP/../../.cache/worldcover) so a re-run never
// downloads again. The whole 5,846 km loop reads about 900 blocks.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
const A = Object.fromEntries(process.argv.slice(2).map((a, i, v) => a.startsWith('--') ? [a.slice(2), v[i + 1] && !v[i + 1].startsWith('--') ? v[i + 1] : true] : []).filter(x => x.length));
if (!A.trip) { console.error('usage: green.mjs --trip DIR [--from-chunk N --to-chunk M] [--force] [--cache DIR]'); process.exit(1); }
const DATA = join(A.trip, 'data'), IDX = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
const CACHE = resolve(A.cache || join(A.trip, '..', '..', '.cache', 'worldcover')), URL0 = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_';
const CLASSW = { mw: 7.5, pr: 6, mi: 4.6, sv: 3, tr: 2, pa: 1.5 }, STEP = 5, OFFS = Array.from({ length: 25 }, (_, k) => k * STEP), TREE = 10, BUILT = 50, BARE = 60, WATER = 80;
const from = +(A['from-chunk'] ?? 0), to = +(A['to-chunk'] ?? (IDX.count ?? 1e6) - 1);

// ---- the GeoTIFF reader: classic TIFF, 8-bit, DEFLATE, tiled (what WorldCover ships)
const META = new Map(), BLOCKS = new Map(); let fetched = 0, bytes = 0;
async function range(url, a, b) { for (let t = 0; t < 4; t++) { try { const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } }); if (r.status === 404 || r.status === 403) return null; if (r.status !== 206 && r.status !== 200) throw Error('HTTP ' + r.status); const buf = Buffer.from(await r.arrayBuffer()); fetched++; bytes += buf.length; return buf; } catch (e) { if (t === 3) throw e; await new Promise(r => setTimeout(r, 1000 * (t + 1))); } } }
const tileName = (lon, lat) => { const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3; return `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`; };
async function meta(name) {
  if (META.has(name)) return META.get(name);
  const mf = join(CACHE, name, 'meta.json'); if (existsSync(mf)) { const m = JSON.parse(readFileSync(mf, 'utf8')); META.set(name, m); return m; }
  const url = URL0 + name + '_Map.tif', b = await range(url, 0, 65535); if (!b) { META.set(name, null); mkdirSync(join(CACHE, name), { recursive: true }); writeFileSync(mf, 'null'); return null; }
  const le = b.toString('ascii', 0, 2) === 'II', u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o), f64 = o => le ? b.readDoubleLE(o) : b.readDoubleBE(o);
  if (u16(2) !== 42) throw Error(name + ': not a classic TIFF');
  const ifd = u32(4), n = u16(ifd), T = {};
  for (let i = 0; i < n; i++) { const o = ifd + 2 + i * 12; T[u16(o)] = { type: u16(o + 2), cnt: u32(o + 4), at: o + 8 }; }
  const one = t => T[t].type === 3 ? u16(T[t].at) : u32(T[t].at);
  async function arr(t) { const { type, cnt, at } = T[t], sz = type === 3 ? 2 : type === 12 ? 8 : 4, off = cnt * sz <= 4 ? at : u32(at); let buf = b, base = off;
    if (off + cnt * sz > b.length) { buf = await range(url, off, off + cnt * sz - 1); base = 0; }
    const rd = o => type === 3 ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : type === 12 ? (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)) : (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    return Array.from({ length: cnt }, (_, k) => rd(base + k * sz)); }
  if (one(259) !== 8 && one(259) !== 32946) throw Error(name + ': compression ' + one(259)); if (T[317] && one(317) !== 1) throw Error(name + ': predictor ' + one(317));
  const scale = await arr(33550), tie = await arr(33922);
  const m = { w: one(256), h: one(257), tw: one(322), th: one(323), off: await arr(324), cnt: await arr(325), x0: tie[3] - tie[0] * scale[0], y0: tie[4] + tie[1] * scale[1], sx: scale[0], sy: scale[1] };
  m.across = Math.ceil(m.w / m.tw); mkdirSync(join(CACHE, name), { recursive: true }); writeFileSync(mf, JSON.stringify(m)); META.set(name, m); return m;
}
async function block(name, m, bi) {
  const key = name + '/' + bi; if (BLOCKS.has(key)) { const v = BLOCKS.get(key); BLOCKS.delete(key); BLOCKS.set(key, v); return v; }
  const f = join(CACHE, name, bi + '.z'); let z = existsSync(f) ? readFileSync(f) : null;
  if (!z) { z = m.cnt[bi] ? await range(URL0 + name + '_Map.tif', m.off[bi], m.off[bi] + m.cnt[bi] - 1) : null; if (z) writeFileSync(f, z); }
  const px = z ? inflateSync(z) : null; BLOCKS.set(key, px); if (BLOCKS.size > 48) BLOCKS.delete(BLOCKS.keys().next().value); return px;
}
async function classAt(lon, lat) {   // the WorldCover class of the 10 m pixel that holds the point (80 water where no tile exists: open sea)
  const name = tileName(lon, lat), m = await meta(name); if (!m) return WATER;
  const col = Math.floor((lon - m.x0) / m.sx), row = Math.floor((m.y0 - lat) / m.sy); if (col < 0 || row < 0 || col >= m.w || row >= m.h) return 0;
  const bi = Math.floor(row / m.th) * m.across + Math.floor(col / m.tw), px = await block(name, m, bi); return px ? px[(row % m.th) * m.tw + (col % m.tw)] : 0;
}

// ---- belts: the scout's noise rules (see the header of this file for what d and w mean)
function sideBelt(row, start, skipRoad) {
  const tree = row.map(c => c === TREE); let k0 = Math.ceil(start / STEP);
  if (skipRoad) while (k0 < row.length && (row[k0] === BUILT || row[k0] === BARE) && OFFS[k0] < 40) k0++;   // left of a one-way carriageway: hop over the other one
  for (let k = Math.max(0, k0 - 1); k < row.length; k++) {   // a canopy that reaches over the verge counts from the road edge
    if (!tree[k] || (tree[k] + (tree[k + 1] || 0) + (tree[k + 2] || 0)) < 2) continue;   // a belt: 2 of 3 steps are trees (10 m deep at least)
    let j = k; while (j + 1 < row.length && (tree[j + 1] || (j + 2 < row.length && tree[j + 2]))) j++; while (!tree[j]) j--;   // its depth, over single-step gaps
    const d = Math.max(start, OFFS[k]), w = OFFS[j] + STEP - d; return [Math.round(d / STEP) * STEP, Math.min(120, Math.round(w / STEP) * STEP)];
  }
  return [0, 0];
}
function smooth(D, W) {   // along the road: a lone thin belt (one sample, under 20 m deep) is noise; one-sample gaps are filled; distance is a median of 3
  const n = D.length, has = W.map(v => v > 0), keep = has.map((h, i) => !(h && !(has[i - 1] || has[i + 1]) && W[i] < 20));
  const D2 = D.map((v, i) => keep[i] ? v : 0), W2 = W.map((v, i) => keep[i] ? v : 0);
  for (let i = 1; i < n - 1; i++) if (!keep[i] && keep[i - 1] && keep[i + 1]) { D2[i] = Math.round((D2[i - 1] + D2[i + 1]) / 2 / STEP) * STEP; W2[i] = Math.min(W2[i - 1], W2[i + 1]); }
  const Dm = D2.slice(); for (let i = 1; i < n - 1; i++) { const t = [D2[i - 1], D2[i], D2[i + 1]]; if (D2[i] > 0 && t.every(v => v > 0)) Dm[i] = t.sort((a, b) => a - b)[1]; }
  return [Dm, W2];
}

let done = 0, belts = 0, sides = 0; const t0 = Date.now();
for (let c = from; c <= to; c++) {
  const f = join(DATA, `c${String(c).padStart(4, '0')}.json`); if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, 'utf8')); if (d.sea || (!A.force && Array.isArray(d.green) && d.green.length === d.samples.length)) continue;
  const [lon0, lat0] = d.origin, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540, out = { L: [[], []], R: [[], []] };
  for (let i = 0; i < d.samples.length; i++) {
    const s = d.samples[i], [x, y] = d.xy[i], h = s[0] / 1000, lanes = s[7] || 0, oneway = !!s[8], rw = lanes >= 2 || (lanes === 1 && oneway) ? lanes * 1.75 : (CLASSW[s[2]] ?? 4.6);
    for (const [side, sg] of [['L', -1], ['R', 1]]) {
      const row = []; for (const t of OFFS) row.push(await classAt(lon0 + (x + sg * Math.sin(h) * t) / KX, lat0 + (y - sg * Math.cos(h) * t) / KY));
      const [bd, bw] = s[5] ? [0, 0] : sideBelt(row, rw + 1.6, side === 'L' && oneway); out[side][0].push(bd); out[side][1].push(bw);
    }
  }
  const [DL, WL] = smooth(...out.L), [DR, WR] = smooth(...out.R); d.green = DL.map((v, i) => [v, WL[i], DR[i], WR[i]]);
  writeFileSync(f, JSON.stringify(d)); done++; const nb = WL.filter(v => v > 0).length + WR.filter(v => v > 0).length; belts += nb; sides += 2 * d.samples.length;
  console.log(`c${c}: ${nb}/${2 * d.samples.length} sides with a tree belt (${Math.round((Date.now() - t0) / 1000)} s, ${fetched} requests, ${(bytes / 1e6).toFixed(1)} MB)`);
}
if (done || !IDX.green) { IDX.green = 'ESA WorldCover 2021 v200'; writeFileSync(join(DATA, 'index.json'), JSON.stringify(IDX)); }   // the viewer credits the source when this is set
console.log(`${done} chunks updated; tree belts on ${sides ? (100 * belts / sides).toFixed(1) : 0}% of sample sides; ${fetched} range requests, ${(bytes / 1e6).toFixed(1)} MB downloaded; cache ${CACHE}`);
