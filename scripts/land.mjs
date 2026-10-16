// Extra: the real coastline for the overview map (free, seconds once cached).
//   node land.mjs --trip TRIP [--tolerance 400]
// A country polygon from OSM (outline.json, neighbours.json) runs 12 nautical miles out to sea (the territorial waters), so the
// overview painted the coastal sea as land and a ship 20 km off Odesa looked like a car in a field (Kyrylo, 2026-10-14).
// Reads TRIP/data/outline.json for the box, cuts Natural Earth 1:10M land (public domain) to it, writes
// TRIP/data/land.json { rings: [[[lon, lat], ...], ...] }. The viewer fills the countries only inside these rings.
import { join } from 'node:path';
import { args, readJSON, writeJSON, politeFetch, simplify } from './lib.mjs';
const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node land.mjs --trip TRIP [--tolerance METRES]'); process.exit(1); }
const OUT = readJSON(join(TRIP, 'data/outline.json'));
if (!OUT) throw Error('no data/outline.json: run outline.mjs first');
let a0 = 1e9, b0 = 1e9, a1 = -1e9, b1 = -1e9;
for (const r of OUT.rings) for (const [lo, la] of r) { a0 = Math.min(a0, lo); a1 = Math.max(a1, lo); b0 = Math.min(b0, la); b1 = Math.max(b1, la); }
{ const kx = Math.cos((b0 + b1) / 2 * Math.PI / 180), w = (a1 - a0) * kx, h = b1 - b0, W = Math.max(w, h * 1.6) / 2 + 1, H = Math.max(h, w / 1.6) / 2 + 1, cx = (a0 + a1) / 2, cy = (b0 + b1) / 2;
  a0 = cx - W / kx; a1 = cx + W / kx; b0 = cy - H; b1 = cy + H; }   // the overview canvas is 34:22 round the country: the box covers all of it with a degree to spare
const url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson';
const ne = JSON.parse(await politeFetch(url, { cacheDir: join(TRIP, '.cache'), timeoutMs: 300000, accept: s => s.startsWith('{') }));
// Sutherland-Hodgman against the box: a ring that crosses the edge is cut along it (the cut runs on the box edge, outside the map's land)
const clip = ring => { let out = ring;
  for (const [inside, cut] of [[p => p[0] >= a0, (p, q) => [a0, p[1] + (q[1] - p[1]) * (a0 - p[0]) / (q[0] - p[0])]], [p => p[0] <= a1, (p, q) => [a1, p[1] + (q[1] - p[1]) * (a1 - p[0]) / (q[0] - p[0])]],
    [p => p[1] >= b0, (p, q) => [p[0] + (q[0] - p[0]) * (b0 - p[1]) / (q[1] - p[1]), b0]], [p => p[1] <= b1, (p, q) => [p[0] + (q[0] - p[0]) * (b1 - p[1]) / (q[1] - p[1]), b1]]]) {
    const src = out; out = []; for (let i = 0; i < src.length; i++) { const p = src[i], q = src[(i + 1) % src.length], pi = inside(p), qi = inside(q); if (pi) out.push(p); if (pi !== qi) out.push(cut(p, q)); }
    if (!out.length) break; }
  return out; };
const rings = [];
for (const f of ne.features) { const g = f.geometry, polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  for (const poly of polys) for (const ring of poly) {   // holes too (the Caspian): the viewer clips with even-odd
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [lo, la] of ring) { x0 = Math.min(x0, lo); x1 = Math.max(x1, lo); y0 = Math.min(y0, la); y1 = Math.max(y1, la); }
    if (x1 < a0 || x0 > a1 || y1 < b0 || y0 > b1) continue;
    const c = clip(ring.slice(0, -1)); if (c.length < 4) continue;
    const s = simplify([...c, c[0]], +(A.tolerance || 400)).slice(0, -1).map(([lo, la]) => [+lo.toFixed(4), +la.toFixed(4)]); if (s.length >= 4) rings.push(s); } }
writeJSON(join(TRIP, 'data', 'land.json'), { box: [+a0.toFixed(2), +b0.toFixed(2), +a1.toFixed(2), +b1.toFixed(2)], rings, source: 'Natural Earth 1:10M land (public domain)' });
console.log(`land.json: ${rings.length} ring(s), ${rings.reduce((n, r) => n + r.length, 0)} points in ${a0.toFixed(1)}..${a1.toFixed(1)} E, ${b0.toFixed(1)}..${b1.toFixed(1)} N`);
