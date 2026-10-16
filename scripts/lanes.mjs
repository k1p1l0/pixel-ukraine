#!/usr/bin/env node
// Fill the OSM lane count and one-way flag into baked chunks (sample fields 7 and 8), for trips baked before bake.mjs recorded them.
//   node scripts/lanes.mjs --trip trips/my-trip [--overpass http://127.0.0.1:12345/api/interpreter] [--from-chunk 0 --to-chunk 5] [--force]
// Same choice of road as the bake: the nearest highway within 14 m, main roads first. Chunks that already carry the fields are skipped.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).map((a, i, v) => a.startsWith('--') ? [a.slice(2), v[i + 1] && !v[i + 1].startsWith('--') ? v[i + 1] : true] : []).filter(x => x.length));
if (!A.trip) { console.error('usage: lanes.mjs --trip DIR [--overpass URL] [--from-chunk N --to-chunk M] [--force]'); process.exit(1); }
const HOST = A.overpass || 'https://overpass-api.de/api/interpreter', DATA = join(A.trip, 'data'), IDX = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
const ROAD = { motorway: 'mw', trunk: 'mw', motorway_link: 'mw', trunk_link: 'mw', primary: 'pr', secondary: 'pr', primary_link: 'pr', secondary_link: 'pr', tertiary: 'mi', tertiary_link: 'mi', unclassified: 'mi', residential: 'mi', living_street: 'mi', service: 'sv', track: 'tr', path: 'pa', footway: 'pa', cycleway: 'pa', pedestrian: 'pa' };
const from = +(A['from-chunk'] ?? 0), to = +(A['to-chunk'] ?? (IDX.count ?? (Array.isArray(IDX.chunks) ? IDX.chunks.length : 1e6)) - 1);
const segDist = (x, y, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0; return Math.hypot(x - ax - dx * t, y - ay - dy * t); };
let done = 0, filled = 0;
for (let c = from; c <= to; c++) {
  const f = join(DATA, `c${String(c).padStart(4, '0')}.json`); if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, 'utf8')); if (d.sea || (!A.force && d.samples.every(s => s.length >= 9))) continue;
  const [lon0, lat0] = d.origin, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540, toXY = (lon, lat) => [(lon - lon0) * KX, (lat - lat0) * KY], toLL = (x, y) => [lon0 + x / KX, lat0 + y / KY];
  const every = Math.max(1, Math.round(100 / (d.step || 10))), pts = d.xy.filter((_, k) => k % every === 0).concat([d.xy.at(-1)]), hd = k => { const i = Math.min(d.samples.length - 1, k * every); return d.samples[i][0] / 1000; };
  const side = sg => pts.map((p, k) => toLL(p[0] + sg * Math.sin(hd(k)) * 30, p[1] - sg * Math.cos(hd(k)) * 30)).map(([lo, la]) => `${la.toFixed(5)} ${lo.toFixed(5)}`);
  const poly = [...side(1), ...side(-1).reverse()].join(' ');
  const q = `[out:json][timeout:120];way[highway][lanes](poly:"${poly}");out geom;`;
  let r; try { r = await (await fetch(HOST, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json(); } catch (e) { console.error(`c${c}: overpass failed: ${e.message}`); continue; }
  const roads = []; for (const e of r.elements || []) { const t = e.tags || {}; if (!ROAD[t.highway] || !e.geometry || (t.tunnel && t.tunnel !== 'no') || +t.layer < 0) continue; roads.push({ cls: ROAD[t.highway], pts: e.geometry.map(g => toXY(g.lon, g.lat)), lanes: Math.min(10, parseInt(t.lanes) || 0), oneway: t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout' ? 1 : 0 }); }
  let n = 0;
  d.samples.forEach((s, i) => { const [x, y] = d.xy[i]; let best = 14, hit = null, bestMain = 14, hitMain = null;
    for (const rd of roads) for (let k = 0; k < rd.pts.length - 1; k++) { const dd = segDist(x, y, rd.pts[k][0], rd.pts[k][1], rd.pts[k + 1][0], rd.pts[k + 1][1]); if (dd < best) { best = dd; hit = rd; } if (['mw', 'pr', 'mi'].includes(rd.cls) && dd < bestMain) { bestMain = dd; hitMain = rd; } }
    const rd = hitMain || hit; s.length = 7; s.push(rd ? rd.lanes : 0, rd ? rd.oneway : 0); if (rd && rd.lanes) n++; });
  writeFileSync(f, JSON.stringify(d)); done++; filled += n; console.log(`c${c}: ${roads.length} tagged ways, ${n}/${d.samples.length} samples with lanes`);
  await new Promise(r => setTimeout(r, 300));
}
console.log(`${done} chunks updated, ${filled} samples with a lane count`);
