// Step 2: bake the route into chunks the viewer streams as you drive (free, the slowest step).
//   node bake.mjs --trip TRIP [--step 10] [--corridor 220] [--zoom 12] [--default-land farm|grass|desert]
//                 [--drive left|right] [--units miles|km] [--centre-line white|yellow]
//                 [--from-chunk N --to-chunk M] [--no-osm] [--no-landmarks] [--overpass URL]
// Reads TRIP/route.json, writes TRIP/data/index.json, TRIP/data/cNNNN.json (one per 10 km) and
// TRIP/data/landmarks.json. Resumable: finished chunks are skipped; every download is cached in TRIP/.cache.
//
// Per chunk (all positions in metres along the route, "side" in metres from the road centre, + = right):
//   samples   every STEP m: heading, height, road class, land left, land right, bridge, road name
//   fronts    the real buildings that face the road: start, length, side, type, height, name, depth.
//             This is what makes the street readable: buildings stand on their real footprints.
//   skyline   tall buildings further back (seen over the street wall)
//   cross     cross streets (crosswalks, traffic signals, gaps in the street wall)
//   rails     where the route crosses a railway (drawn across the road, with a crossbuck sign)
//   places    named places near the road (the HUD and the code-drawn town signs)
//   far       a 61 x 61 km height grid around the chunk at 1 km, for the real horizon
//   map       simplified roads, water and land for the corner minimap
// landmarks.json: named features with a Wikidata id within about 1.2 km of the road (churches, towers,
//   castles, bridges, museums, stations...), ranked by how well known they are (Wikidata sitelinks) and
//   how close. The art planner turns the top ones into pictures; the viewer always signs them by code.
//
// Services (please respect their policies):
//   Overpass API (OpenStreetMap): one corridor query per chunk (two with landmarks), run one at a time
//     with a pause; main instance first, mirrors if it is busy.
//   Terrain Tiles (Terrarium PNGs on AWS Open Data): heights. Attribution required:
//     https://github.com/tilezen/joerd/blob/master/docs/attribution.md
//   Wikidata API: one request per 50 landmarks, for sitelink counts and short descriptions.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, readJSON, writeJSON, politeFetch, decodePNG, cumulative, locate, simplify, encodeLine } from './lib.mjs';

const A = args(), TRIP = A.trip;
if (!TRIP) { console.error('usage: node bake.mjs --trip TRIP [--step 10] [--corridor 220]'); process.exit(1); }
const R = readJSON(join(TRIP, 'route.json')); if (!R) throw Error('no route.json: run route.mjs first');
const line = R.line, cum = cumulative(line), TOTAL = cum.at(-1);
const STEP = +(A.step || (TOTAL < 300e3 ? 10 : TOTAL < 1000e3 ? 20 : 40)), CH = 10000, CORR = +(A.corridor || 220), ZOOM = +(A.zoom || 12);
const NCH = Math.ceil(TOTAL / CH), fromC = +(A['from-chunk'] || 0), toC = +(A['to-chunk'] ?? NCH - 1);
const OUT = join(TRIP, 'data'), CACHE = join(TRIP, '.cache');
const DEFAULT_LAND = A['default-land'] || 'farm', DRY = DEFAULT_LAND === 'desert';
console.log(`${(TOTAL / 1000).toFixed(1)} km, ${NCH} chunks of 10 km, a sample every ${STEP} m, corridor ±${CORR} m`);

// ---------------------------------------------------------------- elevation (Terrarium tiles)
// height = R*256 + G + B/256 - 32768 metres. Tiles are cached on disk; a few are kept decoded in memory.
const tiles = new Map();
function tile(z, x, y) {
  const key = `${z}/${x}/${y}`; if (tiles.has(key)) return tiles.get(key);
  const p = politeFetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`, { cacheDir: join(CACHE, 'terrarium'), gapMs: 30, binary: true }).then(b => b && decodePNG(b));
  tiles.set(key, p); if (tiles.size > 160) tiles.delete(tiles.keys().next().value); return p;
}
async function height(lon, lat, z = ZOOM) {
  const n = 2 ** z, xf = (lon + 180) / 360 * n, s = Math.sin(lat * Math.PI / 180), yf = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const tx = Math.floor(xf), ty = Math.floor(yf), png = await tile(z, tx, ty); if (!png) return 0;
  const i = (Math.min(255, Math.floor((yf - ty) * 256)) * 256 + Math.min(255, Math.floor((xf - tx) * 256))) * 4;
  return Math.max(-50, png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768);   // the sea floor is not the horizon
}

// ---------------------------------------------------------------- OpenStreetMap (Overpass)
// overpass-api.de's other front doors (lz4., z.) often answer when the main one returns 504
const HOSTS = A.overpass ? [A.overpass] : ['https://lz4.overpass-api.de/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function overpass(q) {
  let err;
  for (let round = 0; round < 4; round++) { if (round) { console.error(`  every Overpass server is busy; waiting ${30 * round} s`); await new Promise(r => setTimeout(r, 30000 * round)); } for (const host of HOSTS) {
    try { const r = JSON.parse(await politeFetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), cacheKey: 'overpass:' + q, alsoCachedAs: [...HOSTS], headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cacheDir: join(CACHE, 'overpass'), gapMs: 3000, tries: 2, timeoutMs: 240000, accept: s => s.startsWith('{') })); HOSTS.splice(HOSTS.indexOf(host), 1); HOSTS.unshift(host); return r; }   // the server that answered goes first next time
    catch (e) { err = e; console.error(`  overpass ${host}: ${e.message}`); }
  } }
  throw Error(`Overpass failed (${err?.message}). Rerun later (finished chunks are kept), use --corridor 150, or --no-osm.`);
}
function rings(members) {   // join multipolygon members into closed rings (lakes and forests are often relations)
  const segs = members.filter(m => m.geometry && m.role !== 'inner').map(m => m.geometry.map(g => [g.lon, g.lat])), out = [];
  while (segs.length) { let ring = segs.shift(), grown = true;
    while (grown && !(ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])) { grown = false;
      for (let k = 0; k < segs.length; k++) { const s = segs[k], e = ring.at(-1);
        if (s[0][0] === e[0] && s[0][1] === e[1]) ring = ring.concat(s.slice(1)); else if (s.at(-1)[0] === e[0] && s.at(-1)[1] === e[1]) ring = ring.concat(s.slice(0, -1).reverse()); else continue;
        segs.splice(k, 1); grown = true; break; } }
    if (ring.length > 3) out.push(ring); }
  return out;
}
// road classes: mw motorway/trunk, pr primary/secondary, mi minor, sv service, tr track, pa path
const ROAD = { motorway: 'mw', trunk: 'mw', motorway_link: 'mw', trunk_link: 'mw', primary: 'pr', secondary: 'pr', primary_link: 'pr', secondary_link: 'pr', tertiary: 'mi', tertiary_link: 'mi', unclassified: 'mi', residential: 'mi', living_street: 'mi', service: 'sv', track: 'tr', path: 'pa', footway: 'pa', cycleway: 'pa', pedestrian: 'pa' };
const CLASSW = { mw: [7.5, 2], pr: [7.5, 4], mi: [5, 3], sv: [3, 1.2], pa: [1.2, 0], tr: [1.8, 0] };   // for the land probe only
// building types, as the art kit names them (the viewer picks a facade per type, height and region)
const TYPE = t => /church|cathedral|chapel|mosque|synagogue|temple|shrine|place_of_worship/.test(t) ? 'church'
  : /industrial|warehouse|manufacture|factory|hangar|storage_tank/.test(t) ? 'industrial'
  : /retail|commercial|supermarket|kiosk|office|hotel|shop|pub|restaurant|cafe|bank|fuel/.test(t) ? 'commercial'
  : /barn|farm_auxiliary|cowshed|stable|greenhouse|silo/.test(t) ? 'farm'
  : /garage|garages|shed|roof|carport|service|hut/.test(t) ? 'shed'
  : /house|detached|semidetached_house|bungalow|cabin|villa|farm$/.test(t) ? 'house'
  : /apartments|residential|terrace|dormitory/.test(t) ? 'residential'
  : /train_station|transportation|station/.test(t) ? 'station'
  : /school|university|college|civic|public|government|hospital|townhall|library|museum/.test(t) ? 'civic' : 'yes';
const GROUND = k => /^(water|n:water|l:basin|l:reservoir|w:riverbank)$/.test(k) ? 'water' : k === 'n:wetland' ? 'marsh' : /^(n:wood|l:forest)$/.test(k) ? 'forest'
  : /^(l:farmland|l:meadow|l:orchard|l:vineyard|l:farmyard|l:plant_nursery|l:allotments)$/.test(k) ? 'farm'
  : /^(p:park|p:garden|l:grass|n:grassland|l:recreation_ground|p:pitch|p:golf_course|l:cemetery|l:village_green|p:playground|p:common)$/.test(k) ? 'grass'
  : /^(n:sand|n:bare_rock|n:scree|n:scrub|n:heath|n:desert)$/.test(k) ? (DRY ? 'desert' : k === 'n:sand' ? 'sand' : k === 'n:bare_rock' || k === 'n:scree' ? 'rock' : 'grass')
  : k === 'n:beach' ? 'sand'
  : k === 'l:residential' ? 'lawn' : k === 'a:parking' ? 'lot' : /^(l:commercial|l:industrial|l:retail|l:railway|l:construction|l:brownfield|l:garages|p:marina)$/.test(k) ? 'pave' : null;
const ORDER = { water: 7, marsh: 6, lot: 5.5, pave: 5, sand: 4, grass: 3, lawn: 3, forest: 2, farm: 2, rock: 2, desert: 1 };
const LMKIND = t => (t.highway || t.railway === 'rail' || t.waterway || t.boundary) && t.man_made !== 'bridge' ? null : t.building === 'cathedral' || t.building === 'church' || t.amenity === 'place_of_worship' ? 'church'
  : /castle|fort|city_gate|tower|ruins|manor|palace/.test(t.historic || '') || t.building === 'castle' ? 'castle'
  : t.man_made === 'lighthouse' ? 'lighthouse' : t.man_made === 'windmill' ? 'windmill' : /tower|mast|water_tower/.test(t.man_made || '') ? 'tower'
  : t.bridge || t.man_made === 'bridge' ? 'bridge' : t.railway === 'station' || t.building === 'train_station' ? 'station'
  : t.leisure === 'stadium' ? 'stadium' : t.tourism === 'museum' ? 'museum' : /monument|memorial|statue/.test((t.historic || '') + (t.memorial || '')) ? 'monument'
  : t.tourism === 'attraction' || t.tourism === 'viewpoint' ? 'attraction' : t.historic ? 'historic' : null;
const LMSIZE = { church: [35, 30], castle: [25, 60], lighthouse: [30, 8], windmill: [20, 12], tower: [60, 15], bridge: [30, 120], station: [15, 70], stadium: [30, 160], museum: [20, 50], monument: [12, 8], attraction: [15, 30], historic: [12, 25] };

// ---------------------------------------------------------------- chunks
const summary = [], lmAll = [];
for (let c = fromC; c <= Math.min(toC, NCH - 1); c++) {
  const file = join(OUT, `c${String(c).padStart(4, '0')}.json`);
  if (existsSync(file)) { const d = JSON.parse(readFileSync(file, 'utf8')); summary.push(d.summary); lmAll.push(...(d.lm || [])); continue; }
  const s0 = c * CH, s1 = Math.min(TOTAL, s0 + CH), mid = locate(line, cum, (s0 + s1) / 2), lon0 = mid.lon, lat0 = mid.lat;
  const KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540;            // local metres around the chunk's middle (x east, y north)
  const toXY = (lon, lat) => [(lon - lon0) * KX, (lat - lat0) * KY], toLL = (x, y) => [lon0 + x / KX, lat0 + y / KY];
  const S = [];
  for (let d = s0; d <= s1 + 0.01; d += STEP) { const p = locate(line, cum, Math.min(d, TOTAL)); S.push({ d, xy: toXY(p.lon, p.lat), ll: [p.lon, p.lat] }); }
  for (const p of S) { const a = locate(line, cum, Math.max(0, p.d - 15)), b = locate(line, cum, Math.min(TOTAL, p.d + 15)), [ax, ay] = toXY(a.lon, a.lat), [bx, by] = toXY(b.lon, b.lat); p.hd = Math.atan2(by - ay, bx - ax); p.h = Math.round((await height(...p.ll)) * 10) / 10; }

  let osm = { elements: [] }, lmOsm = { elements: [] }, tallOsm = { elements: [] };
  const corridor = w => { const poly = S.filter((_, k) => k % Math.max(1, Math.round(100 / STEP)) === 0).concat([S.at(-1)]); const side = sg => poly.map(p => toLL(p.xy[0] + sg * Math.sin(p.hd) * w, p.xy[1] - sg * Math.cos(p.hd) * w)).map(([lo, la]) => `${la.toFixed(5)} ${lo.toFixed(5)}`); return [...side(1), ...side(-1).reverse()].join(' '); };
  if (!A['no-osm']) {
    const P = corridor(CORR);
    osm = await overpass(`[out:json][timeout:180];(way[highway](poly:"${P}");way[building](poly:"${P}");way[landuse](poly:"${P}");way[natural](poly:"${P}");way[leisure](poly:"${P}");way[waterway](poly:"${P}");way[railway=rail](poly:"${P}");way[amenity=parking](poly:"${P}");relation[natural=water](poly:"${P}");relation[waterway=riverbank](poly:"${P}");relation[landuse](poly:"${P}");relation[building](poly:"${P}");node[place](poly:"${corridor(2500)}"););out geom;`);
    if (osm.elements.some(e => e.tags?.natural === 'coastline')) {   // the whole coastline in a box (a corridor cuts it into pieces and the sea fill leaks)
      let a0 = 1e9, b0 = 1e9, a1 = -1e9, b1 = -1e9; for (const p of S) { a0 = Math.min(a0, p.ll[0]); b0 = Math.min(b0, p.ll[1]); a1 = Math.max(a1, p.ll[0]); b1 = Math.max(b1, p.ll[1]); }
      const co = await overpass(`[out:json][timeout:120][bbox:${(b0 - 0.03).toFixed(4)},${(a0 - 0.03).toFixed(4)},${(b1 + 0.03).toFixed(4)},${(a1 + 0.03).toFixed(4)}];way[natural=coastline];out geom;`);
      const seen = new Set(osm.elements.map(e => e.id)); for (const e of co.elements) if (!seen.has(e.id)) osm.elements.push(e); }
    if (!A['no-landmarks']) lmOsm = await overpass(`[out:json][timeout:120];nwr[wikidata][name](poly:"${corridor(1200)}");out center tags;`);
    // tall buildings up to 1.2 km away: the skyline that tells you you are in a city even from a freeway (centres only: light)
    if (!A['no-skyline']) { const P2 = corridor(1200); tallOsm = await overpass(`[out:json][timeout:120];(way["building:levels"~"^([1-9][0-9]+)$"](poly:"${P2}");way[building]["height"~"^([3-9][0-9]|[1-9][0-9][0-9])"](poly:"${P2}"););out center tags;`); }
  }
  const roads = [], areas = [], bds = [], lines = [], placesN = [];
  for (const e of osm.elements) { const t = e.tags || {};
    if (e.type === 'node') { if (t.place && t.name) placesN.push({ name: t.name, xy: toXY(e.lon, e.lat), rank: /city/.test(t.place) ? 3 : /town/.test(t.place) ? 2 : /village|suburb|borough|quarter|neighbourhood/.test(t.place) ? 1 : /hamlet|locality/.test(t.place) ? 0.5 : 0 }); continue; }
    if (e.type === 'relation') { const k = t.natural === 'water' || t.waterway === 'riverbank' ? 'water' : t.landuse ? 'l:' + t.landuse : null;
      if (t.building) for (const r of rings(e.members || [])) bds.push({ pts: r.map(([lo, la]) => toXY(lo, la)), type: TYPE(`${t.building} ${t.amenity || ''}`), lv: +t['building:levels'] || (parseFloat(t.height) ? parseFloat(t.height) / 3.4 : 0), name: t.name || null });
      else if (k) for (const r of rings(e.members || [])) areas.push([k, r.map(([lo, la]) => toXY(lo, la))]); continue; }
    if (!e.geometry) continue; const pts = e.geometry.map(g => toXY(g.lon, g.lat));
    if (t.building && t.building !== 'no') bds.push({ pts, type: TYPE(`${t.building} ${t.amenity || ''} ${t.shop ? 'shop' : ''}`), lv: +t['building:levels'] || (parseFloat(t.height) ? parseFloat(t.height) / 3.4 : 0), name: t.name || null });
    else if (t.highway && ROAD[t.highway] && !(t.tunnel && t.tunnel !== 'no') && !(+t.layer < 0) && t.covered !== 'yes') roads.push({ cls: ROAD[t.highway], pts, name: t.name || t.ref || null, bridge: !!t.bridge && t.bridge !== 'no' });
    else if (t.railway === 'rail') lines.push(['rl', pts]);
    else if (t.waterway) lines.push(['rv', pts]);
    else if (t.natural === 'coastline') lines.push(['co', pts]);
    else if (t.amenity === 'parking') areas.push(['a:parking', pts]);
    else if (t.natural || t.landuse || t.leisure) areas.push([t.natural === 'water' ? 'water' : t.natural ? 'n:' + t.natural : t.landuse ? 'l:' + t.landuse : 'p:' + t.leisure, pts]);
  }
  // nearest-segment search over a grid
  const grid = (items, cell = 50) => { const G = new Map(); items.forEach((p, idx) => { for (let i = 0; i < p.length - 1; i++) { const n = Math.ceil(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) / cell) + 1; for (let k = 0; k <= n; k++) { const key = Math.floor((p[i][0] + (p[i + 1][0] - p[i][0]) * k / n) / cell) + ',' + Math.floor((p[i][1] + (p[i + 1][1] - p[i][1]) * k / n) / cell); let a = G.get(key); if (!a) G.set(key, a = []); if (a.at(-2) !== idx || a.at(-1) !== i) a.push(idx, i); } } }); return { G, cell, items }; };
  const near = (gr, x, y, r, ok) => { let best = r * r, hit = null; const c2 = gr.cell; for (let gx = Math.floor((x - r) / c2); gx <= Math.floor((x + r) / c2); gx++) for (let gy = Math.floor((y - r) / c2); gy <= Math.floor((y + r) / c2); gy++) { const a = gr.G.get(gx + ',' + gy); if (!a) continue; for (let k = 0; k < a.length; k += 2) { if (ok && !ok(a[k])) continue; const p = gr.items[a[k]], i = a[k + 1], [ax, ay] = p[i], [bx, by] = p[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))), dd = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2; if (dd < best) { best = dd; hit = { i: a[k], ax, ay, dx, dy }; } } } return hit; };
  const RG = grid(roads.map(r => r.pts)), CG = grid(lines.filter(l => l[0] === 'co').map(l => l[1]), 100), WG = grid(lines.filter(l => l[0] === 'rv').map(l => l[1]));
  const bbox = pts => { let a = 1e9, b = 1e9, c2 = -1e9, d = -1e9; for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c2 = Math.max(c2, x); d = Math.max(d, y); } return [a, b, c2, d]; };
  const inPoly = (pts, x, y) => { let r = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r; } return r; };
  const AR = areas.filter(a => a[1].length > 3 && GROUND(a[0])).map(a => ({ g: GROUND(a[0]), pts: a[1], bb: bbox(a[1]) }));
  // buildings per 50 m cell: where no land use is mapped, a built-up place is paving or lawn, not farmland
  const BD = new Map(); for (const b of bds) { const [x, y] = b.pts[0], k = Math.floor(x / 50) + ',' + Math.floor(y / 50); BD.set(k, (BD.get(k) || 0) + 1); }
  const builtUp = (x, y) => { let n = 0; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) n += BD.get((Math.floor(x / 50) + i) + ',' + (Math.floor(y / 50) + j)) || 0; return n; };
  const groundAt = (x, y) => {
    const co = near(CG, x, y, 150); if (co && co.dx * (y - co.ay) - co.dy * (x - co.ax) < 0) return 'water';   // OSM coastlines run with the sea on their right
    let best = null, bo = 0; for (const a of AR) { if (x < a.bb[0] || x > a.bb[2] || y < a.bb[1] || y > a.bb[3] || ORDER[a.g] <= bo) continue; if (inPoly(a.pts, x, y)) { best = a.g; bo = ORDER[a.g]; } }
    if (best === 'lawn' && builtUp(x, y) >= 14) return 'pave';   // residential land packed with buildings is a street of row houses, not lawns
    if (best) return best; const n = builtUp(x, y); return n >= 12 ? 'pave' : n >= 4 ? 'lawn' : DEFAULT_LAND; };

  const NAMES = [], nameIdx = n => { if (!n) return -1; let i = NAMES.indexOf(n); if (i < 0) { i = NAMES.length; NAMES.push(n); } return i; };
  const samples = S.map(p => {
    const [x, y] = p.xy; let r = near(RG, x, y, 14, i => ['mw', 'pr', 'mi'].includes(roads[i].cls)); if (!r) r = near(RG, x, y, 14);
    const rd = r ? roads[r.i] : null, cls = rd ? rd.cls : (A['no-osm'] ? 'pr' : 'mi'), [rw, sw] = CLASSW[cls], off = rw + sw + 6, nx = Math.sin(p.hd), ny = -Math.cos(p.hd);   // (nx, ny) points to the right of travel
    let L = groundAt(x - nx * off, y - ny * off), Rt = groundAt(x + nx * off, y + ny * off);
    if (rd?.bridge && near(WG, x, y, 60)) L = Rt = 'water';
    return [Math.round(p.hd * 1000), Math.round(p.h * 10), cls, L, Rt, rd?.bridge ? 1 : 0, nameIdx(rd?.name)];
  });
  // where a point lies along the road: nearest sample, distance along (s) and to the side (+ right)
  const SG = new Map(); S.forEach((p, i) => { const k = Math.floor(p.xy[0] / 40) + ',' + Math.floor(p.xy[1] / 40); let a = SG.get(k); if (!a) SG.set(k, a = []); a.push(i); });
  const local = (x, y, reach = 10) => { let best = 1e18, bi = -1; const gx = Math.floor(x / 40), gy = Math.floor(y / 40); for (let rr = 0; rr <= reach && bi < 0; rr++) for (let a = gx - rr; a <= gx + rr; a++) for (let b = gy - rr; b <= gy + rr; b++) { const L = SG.get(a + ',' + b); if (L) for (const i of L) { const d = (S[i].xy[0] - x) ** 2 + (S[i].xy[1] - y) ** 2; if (d < best) { best = d; bi = i; } } } if (bi < 0) return null; const q = S[bi], dx = x - q.xy[0], dy = y - q.xy[1]; return { i: bi, s: bi * STEP + dx * Math.cos(q.hd) + dy * Math.sin(q.hd), side: dx * Math.sin(q.hd) - dy * Math.cos(q.hd) }; };
  // building fronts: per 2 m of road and side, the nearest building within 60 m; a run of one building is one front
  const NB = Math.ceil((s1 - s0) / 2) + 1, bins = { [-1]: new Int32Array(NB).fill(-1), [1]: new Int32Array(NB).fill(-1) }, dist = { [-1]: new Float32Array(NB).fill(1e9), [1]: new Float32Array(NB).fill(1e9) };
  const skyline = [], taken = new Set(), depthOf = new Map();
  bds.forEach((b, bi) => {
    const L = b.pts.map(([x, y]) => local(x, y)).filter(Boolean); if (!L.length) return;
    let d = 1e9, dmax = 0, sg = 1, a0 = 1e9, a1 = -1e9; for (const l of L) { const ad = Math.abs(l.side); if (ad < d) { d = ad; sg = Math.sign(l.side) || 1; } dmax = Math.max(dmax, ad); a0 = Math.min(a0, l.s); a1 = Math.max(a1, l.s); }
    const hgt = b.lv ? b.lv * 3.4 : 0;
    if (d > 60) { if (hgt >= 28 && d < 400) { let cx = 0, cy = 0; for (const [x, y] of b.pts) { cx += x; cy += y; } const l = local(cx / b.pts.length, cy / b.pts.length); if (l) { const key = Math.round(l.s / 16) + ':' + Math.sign(l.side) + ':' + Math.round(Math.abs(l.side) / 40); if (!taken.has(key)) { taken.add(key); const box = bbox(b.pts); skyline.push([Math.round(l.s), Math.round(l.side), b.type, Math.round(hgt), Math.round(Math.min(60, Math.max(14, Math.hypot(box[2] - box[0], box[3] - box[1]) * 0.6)))]); } } } return; }
    if (L.some(l => Math.sign(l.side) !== sg && Math.abs(l.side) > 2) || a1 - a0 > 400) return;   // straddling the road, or not a frontage
    depthOf.set(bi, Math.max(4, Math.min(60, dmax - d)));
    for (let k = Math.max(0, Math.floor(a0 / 2)); k <= Math.min(NB - 1, Math.ceil(a1 / 2)); k++) if (d < dist[sg][k]) { dist[sg][k] = d; bins[sg][k] = bi; }
  });
  for (const e of tallOsm.elements) { if (!e.center) continue; const t = e.tags || {}, hgt = parseFloat(t.height) || (+t['building:levels'] || 0) * 3.4; if (hgt < 28) continue;
    const l = local(...toXY(e.center.lon, e.center.lat), 40); if (!l || Math.abs(l.side) < 60 || l.s < 0 || l.s > s1 - s0) continue;
    const key = Math.round(l.s / 16) + ':' + Math.sign(l.side) + ':' + Math.round(Math.abs(l.side) / 40); if (taken.has(key)) continue; taken.add(key);
    skyline.push([Math.round(l.s), Math.round(l.side), TYPE(`${t.building} ${t.amenity || ''} ${t.tourism || ''}`), Math.round(hgt), Math.round(Math.min(80, Math.max(20, hgt * 0.5)))]); }
  // the row behind: for every 2 m, the nearest building at least 10 m behind the front one (up to 150 m from the road).
  // Across a square, a park or a car park you then see the buildings on its far side, not empty ground to the horizon.
  const bins2 = { [-1]: new Int32Array(NB).fill(-1), [1]: new Int32Array(NB).fill(-1) }, dist2 = { [-1]: new Float32Array(NB).fill(1e9), [1]: new Float32Array(NB).fill(1e9) };
  bds.forEach((b, bi) => { const L = b.pts.map(([x, y]) => local(x, y)).filter(Boolean); if (!L.length) return; let d = 1e9, sg = 1, a0 = 1e9, a1 = -1e9;
    for (const l of L) { const ad = Math.abs(l.side); if (ad < d) { d = ad; sg = Math.sign(l.side) || 1; } a0 = Math.min(a0, l.s); a1 = Math.max(a1, l.s); }
    if (d < 15 || d > 150 || L.some(l => Math.sign(l.side) !== sg && Math.abs(l.side) > 2) || a1 - a0 > 400) return;
    for (let k = Math.max(0, Math.floor(a0 / 2)); k <= Math.min(NB - 1, Math.ceil(a1 / 2)); k++) if (bins[sg][k] !== bi && d > Math.min(dist[sg][k], 60) + 10 && d < dist2[sg][k]) { dist2[sg][k] = d; bins2[sg][k] = bi; } });
  const backs = [];
  for (const sg of [-1, 1]) for (let k = 0; k < NB;) { const bi = bins2[sg][k]; if (bi < 0) { k++; continue; } let j = k; while (j + 1 < NB && bins2[sg][j + 1] === bi) j++;
    const len = (j - k + 1) * 2, b = bds[bi]; if (len >= 6) backs.push([k * 2, len, Math.round(sg * dist2[sg][k] * 10) / 10, b.type, b.lv ? Math.round(b.lv * 3.4) : 0, -1, 10]); k = j + 1; }
  const fronts = [];
  for (const sg of [-1, 1]) for (let k = 0; k < NB;) { const bi = bins[sg][k]; if (bi < 0) { k++; continue; } let j = k; while (j + 1 < NB && bins[sg][j + 1] === bi) j++;
    const len = (j - k + 1) * 2, b = bds[bi]; if (len >= 4) fronts.push([k * 2, len, Math.round(sg * dist[sg][k] * 10) / 10, b.type, b.lv ? Math.round(b.lv * 3.4) : 0, nameIdx(b.name && /church|cathedral|abbey|chapel|station|hall|museum|castle|tower|theat|library|court|school|hotel|inn|arms/i.test(b.name) ? b.name : null), Math.round(depthOf.get(bi))]); k = j + 1; }
  fronts.sort((a, b) => a[0] - b[0]);
  // cross streets: a road meeting the route at a good angle (crosswalks, signals, a gap in the street wall)
  const cross = [];
  for (const r of roads) { if (!['pr', 'mi', 'mw', 'sv'].includes(r.cls) || r.bridge) continue; for (let i = 0; i < r.pts.length - 1; i++) { const m = local((r.pts[i][0] + r.pts[i + 1][0]) / 2, (r.pts[i][1] + r.pts[i + 1][1]) / 2, 2); if (!m || Math.abs(m.side) > Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]) / 2 + 3) continue;
    const q = S[m.i], bx = r.pts[i + 1][0] - r.pts[i][0], by = r.pts[i + 1][1] - r.pts[i][1], ang = Math.abs(Math.asin(Math.max(-1, Math.min(1, (Math.cos(q.hd) * by - Math.sin(q.hd) * bx) / (Math.hypot(bx, by) || 1)))));
    if (ang > 0.6 && m.s > 0 && m.s < s1 - s0) cross.push([Math.round(m.s), r.cls === 'sv' ? 8 : r.cls === 'mi' ? 14 : 22, nameIdx(r.name)]); } }
  cross.sort((a, b) => a[0] - b[0]); for (let i = cross.length - 1; i > 0; i--) if (cross[i][0] - cross[i - 1][0] < 25) cross.splice(i, 1);
  // where the route crosses a railway (not on a bridge)
  const rails = []; { const X = (a, b, c2, e) => { const r0 = b[0] - a[0], r1 = b[1] - a[1], q0 = e[0] - c2[0], q1 = e[1] - c2[1], den = r0 * q1 - r1 * q0; if (!den) return -1; const t = ((c2[0] - a[0]) * q1 - (c2[1] - a[1]) * q0) / den, u = ((c2[0] - a[0]) * r1 - (c2[1] - a[1]) * r0) / den; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1; };
    for (const [k, pts] of lines) { if (k !== 'rl') continue; for (let j = 1; j < pts.length; j++) for (let i = 1; i < S.length; i++) { const t = X(S[i - 1].xy, S[i].xy, pts[j - 1], pts[j]); if (t >= 0 && !samples[i][5]) rails.push(Math.round((i - 1 + t) * STEP)); } } }
  const places = placesN.map(p => { const l = local(...p.xy, 70); return l && Math.abs(l.side) < 2500 && l.s >= 0 && l.s <= s1 - s0 ? [Math.round(l.s), p.name, p.rank, Math.round(l.side)] : null; }).filter(Boolean);
  // landmarks: named Wikidata features near the road, at their real place along it
  const lm = [];
  for (const e of lmOsm.elements) { const t = e.tags || {}, kind = LMKIND(t); if (!kind || !t.wikidata) continue; const ll = e.type === 'node' ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null; if (!ll) continue;
    const l = local(...toXY(...ll), 40); if (!l || l.s < 0 || l.s > s1 - s0) continue; const [h0, w0] = LMSIZE[kind];
    lm.push({ name: t['name:en'] && A.english ? t['name:en'] : t.name, qid: t.wikidata.split(';')[0], kind, s: Math.round(s0 + l.s), side: Math.round(l.side), h: Math.round(parseFloat(t.height) || h0), w: w0, tags: { historic: t.historic, tourism: t.tourism, building: t.building, man_made: t.man_made } }); }
  // the corner minimap: simplified features in chunk metres
  const simp = (pts, tol) => simplify(pts.map(([x, y]) => toLL(x, y)), tol).map(([lo, la]) => toXY(lo, la).map(v => Math.round(v)));
  const map = { roads: roads.filter(r => r.cls !== 'pa').map(r => [r.cls, simp(r.pts, 4)]), areas: AR.filter(a => a.g !== 'lawn').map(a => [a.g, simp(a.pts, 8)]), lines: lines.filter(l => l[0] !== 'co').map(l => [l[0], simp(l[1], 6)]) };
  // far heights ±30 km at 1 km for the real horizon (zoom 9 tiles: a few per chunk, cached)
  const far = { cell: 1000, x0: -30000, y0: -30000, w: 61, h: 61, heights: [] };
  for (let j = 0; j < 61; j++) for (let i = 0; i < 61; i++) far.heights.push(Math.round(await height(...toLL(-30000 + i * 1000, -30000 + j * 1000), 9)));
  // a summary for the art planner: what this stretch is made of
  const land = {}; for (const s of samples) { land[s[3]] = (land[s[3]] || 0) + 1; land[s[4]] = (land[s[4]] || 0) + 1; }
  for (const k in land) land[k] = Math.round(land[k] / samples.length * 50);
  const types = {}; let frontM = 0; for (const f of fronts) { types[f[3]] = (types[f[3]] || 0) + f[1]; frontM += f[1]; }
  const maxH = Math.max(0, ...fronts.map(f => f[4]), ...skyline.map(f => f[3]));
  // and the same per kilometre, so the art plan can split regions anywhere, not only at chunk edges
  const perKm = []; for (let a = 0; a < s1 - s0; a += 1000) { const ld = {}, ty = {}; let mh = 0, ns = 0; samples.forEach((sm, i) => { if (i * STEP < a || i * STEP >= a + 1000) return; ns++; ld[sm[3]] = (ld[sm[3]] || 0) + 1; ld[sm[4]] = (ld[sm[4]] || 0) + 1; });
    for (const k in ld) ld[k] = Math.round(ld[k] / Math.max(1, ns) * 50); for (const f of fronts) if (f[0] >= a && f[0] < a + 1000) { ty[f[3]] = (ty[f[3]] || 0) + f[1]; mh = Math.max(mh, f[4]); } for (const t of skyline) if (t[0] >= a && t[0] < a + 1000) mh = Math.max(mh, t[3]);
    perKm.push({ s0: s0 + a, land: ld, types: ty, maxH: mh }); }
  const sum = { c, s0, km: +((s1 - s0) / 1000).toFixed(1), land, types, built: +(frontM / (2 * (s1 - s0))).toFixed(2), maxH, cross: cross.length, places: places.filter(p => p[2] >= 1).map(p => p[1]).slice(0, 6), perKm };
  const chunk = { c, s0, len: Math.round(s1 - s0), step: STEP, origin: [+lon0.toFixed(6), +lat0.toFixed(6)], xy: S.map(p => [Math.round(p.xy[0]), Math.round(p.xy[1])]), samples, fronts, backs, skyline, cross, rails, places, names: NAMES, map, far, lm, summary: sum };
  writeJSON(file, chunk); summary.push(sum); lmAll.push(...lm);
  console.log(`c${c} ${(s0 / 1000).toFixed(0)}-${(s1 / 1000).toFixed(0)} km: ${fronts.length} fronts (${Math.round(sum.built * 100)}% built), ${skyline.length} tall, ${cross.length} cross, ${rails.length} rail, ${lm.length} landmarks, land ${Object.entries(land).map(([k, v]) => k + ' ' + v + '%').join(' ')}${sum.places.length ? ', ' + sum.places.join(', ') : ''} (${(JSON.stringify(chunk).length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------- landmarks: rank by fame (Wikidata sitelinks) and nearness
const byQ = new Map(); for (const l of lmAll) { const o = byQ.get(l.qid); if (!o || Math.abs(l.side) < Math.abs(o.side)) byQ.set(l.qid, l); }
const qids = [...byQ.keys()], wd = {};
for (let i = 0; i < qids.length; i += 50) {
  try { const j = JSON.parse(await politeFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks|descriptions&languages=en&ids=${qids.slice(i, i + 50).join('|')}`, { cacheDir: join(CACHE, 'wikidata'), gapMs: 1000, accept: s => s.startsWith('{') }));
    for (const [q, e] of Object.entries(j.entities || {})) wd[q] = { links: Object.keys(e.sitelinks || {}).length, desc: e.descriptions?.en?.value || '' }; }
  catch (e) { console.error('  wikidata:', e.message, '(landmarks keep their OSM ranking)'); }
}
const landmarks = [...byQ.values()].map(l => ({ ...l, links: wd[l.qid]?.links ?? 0, desc: wd[l.qid]?.desc || '' }))
  .map(l => ({ ...l, score: +((1 + l.links) / (1 + Math.abs(l.side) / 250)).toFixed(2) })).sort((a, b) => b.score - a.score);
writeJSON(join(OUT, 'landmarks.json'), landmarks, true);

// ---------------------------------------------------------------- index (the minimap, the places list, the credits)
const allPlaces = []; for (let c = 0; c < NCH; c++) { const f = join(OUT, `c${String(c).padStart(4, '0')}.json`); if (existsSync(f)) for (const p of JSON.parse(readFileSync(f, 'utf8')).places) if (Math.abs(p[3] ?? 0) < (p[2] >= 2 ? 3000 : 900)) allPlaces.push([p[0] + c * CH, p[1], p[2]]); }   // a suburb or village counts when the road passes within 1.2 km of it, a town within 3 km
const along = []; for (const p of allPlaces.sort((a, b) => a[0] - b[0])) { const prev = along.at(-1); if (p[2] < 0.5 || along.some(q => q[1] === p[1])) continue; if (prev && p[0] - prev[0] < Math.max(1500, TOTAL / 60)) { if (p[2] > prev[2]) along[along.length - 1] = p; continue; } along.push(p); }
const all = []; for (let c = 0; c < NCH; c++) { const f = join(OUT, `c${String(c).padStart(4, '0')}.json`); if (existsSync(f)) all.push(JSON.parse(readFileSync(f, 'utf8')).summary); }
writeJSON(join(OUT, 'index.json'), {
  title: `${R.from} to ${R.to}`, from: R.from, to: R.to, stops: R.stops, total: Math.round(TOTAL), chunk: CH, step: STEP, count: NCH, country: R.country || null,
  drive: A.drive || R.drive || 'right', units: A.units || R.units || 'km', centre: A['centre-line'] || R.centre || 'white', dry: DRY,
  line: encodeLine(simplify(line, Math.max(20, TOTAL / 4000))), places: along.map(p => [Math.round(p[0]), p[1], p[2]]), chunks: all,
  credits: ['Map data © OpenStreetMap contributors (ODbL), openstreetmap.org/copyright', R.source.split(';')[0], 'Elevation: Terrain Tiles (Mapzen/Tilezen on AWS Open Data; SRTM, GMTED, ETOPO1 and others)', 'Landmarks: Wikidata (CC0)'],
}, true);
console.log(`index.json: ${NCH} chunks, ${along.length} places along the way; landmarks.json: ${landmarks.length} (top: ${landmarks.slice(0, 5).map(l => `${l.name} [${l.kind}, ${l.links} links, ${Math.abs(l.side)} m ${l.side < 0 ? 'left' : 'right'}]`).join('; ') || 'none'})`);
