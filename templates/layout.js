// layout.js: from a baked chunk to the things that stand beside the road.
//
// This module is shared by the viewer (in the browser) and the self-check (scripts/check.mjs, in Node), so
// the check audits exactly the street the viewer draws: the same buildings, the same gaps, the same repeats.
// It has no DOM code. Everything here is deterministic: the same trip always places the same things.
//
// What it does, in order:
//   1. 2 m road slices from the 10 m samples, with the messy map smoothed: headings over ±60 m (routes zig-zag
//      at junctions), grades capped at 12%, heights eased over ±30 m, short road-class flips absorbed.
//   2. Buildings as blocks on their real footprints. A long frontage becomes a row of different buildings,
//      each as wide as its own picture (never one picture tiled), detached kinds (houses, barns, churches)
//      stand apart with yards between, cracks under 3 m are closed and short lots in a street wall are filled.
//   3. Where the map has no buildings, the land use decides: houses set back on lawns, a farmstead now and then
//      on farmland, low commercial on paved land, a continuous wall in a dense city.
//   4. Variety: every pick avoids the last few pictures on that side of the road; a small kit is stretched
//      further with mirrored and tinted copies (a "look" is picture + mirror + tint).
//   5. Street furniture, trees by land cover, code-drawn signs (town names, distances, landmarks, railway
//      crossings), landmarks at their real place.
//   6. audit(): the gaps, repeats and missing pictures the self-check reports.

export const SEG = 2;                          // metres per road slice
// half road width and sidewalk (or verge) width by road class, in metres
export const CLASSW = { mw: [7.5, 2.5], pr: [6, 3.2], mi: [4.6, 2.6], sv: [3, 1.2], tr: [2, 0], pa: [1.5, 0] };
export function hash(a, b) { let h = (a * 73856093 ^ b * 19349663) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h ^ (h >>> 16)) >>> 0; }
export const hrnd = (a, b) => (hash(Math.round(a), b) & 65535) / 65535;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// ------------------------------------------------------------------ the art kit
// Facade roles and what each bake building type falls back to, best first. A role the kit lacks falls through
// to the next real picture before any placeholder is used, so a small kit never mixes in grey boxes.
export const ROLE_H = { house: 8, terrace: 10, shop: 10, apartment: 18, tower: 60, civic: 14, church: 20, industrial: 9, farm: 8 };
const ATTACHED = new Set(['terrace', 'shop', 'apartment', 'tower']);
export function rolesFor(type, h, dense) {
  if (type === 'church') return ['church', 'civic', 'terrace', 'house'];
  if (type === 'civic' || type === 'station') return h > 30 ? ['tower', 'civic', 'apartment'] : ['civic', 'apartment', 'shop', 'terrace'];
  if (type === 'industrial') return ['industrial', 'farm', 'shop'];
  if (type === 'farm') return ['farm', 'industrial', 'house'];
  if (type === 'shed') return dense ? ['shop', 'terrace', 'industrial'] : ['farm', 'house', 'industrial'];
  if (h > 32) return ['tower', 'apartment', 'civic', 'shop'];
  if (h > 15) return ['apartment', 'tower', 'shop', 'terrace'];
  if (type === 'commercial') return ['shop', 'terrace', 'apartment', 'house'];
  if (type === 'residential') return dense ? ['terrace', 'apartment', 'shop', 'house'] : ['terrace', 'house', 'shop'];
  if (type === 'house') return dense ? ['terrace', 'house', 'shop'] : ['house', 'terrace', 'shop'];
  return dense ? ['shop', 'terrace', 'apartment', 'house'] : ['house', 'terrace', 'shop'];
}
// tints that stretch a small kit: wall colours shifted a little (applied by the viewer to a copy of the picture)
export const TINTS = [[1, 1, 1], [1.07, 0.99, 0.9], [0.9, 0.95, 1.04], [0.86, 0.84, 0.82]];

// kit.json -> pools. pictures: { name: { role, theme, kind, w, h, hm, avg, placeholder, drop, flags } }
export function makeKit(kitJson) {
  const P = kitJson.pictures || {}, themes = [...(kitJson.themes || [{ id: 'default', from: 0 }])].sort((a, b) => a.from - b.from);
  const ok = n => P[n] && !P[n].drop && P[n].w > 0;
  const by = new Map();   // "theme|role" -> [names]; real pictures and placeholders kept apart
  for (const [n, p] of Object.entries(P)) { if (!ok(n)) continue; const k = `${p.theme || '*'}|${p.role}|${p.placeholder ? 'p' : 'r'}`; if (!by.has(k)) by.set(k, []); by.get(k).push(n); }
  for (const a of by.values()) a.sort();
  const themeAt = s => { let t = themes[0]; for (const th of themes) if (th.from <= s) t = th; return t; };
  const near = id => { const i = themes.findIndex(t => t.id === id); return [...themes].sort((a, b) => Math.abs(themes.indexOf(a) - i) - Math.abs(themes.indexOf(b) - i)).map(t => t.id); };
  const memo = new Map();
  // every picture that can stand in for these roles at distance s: this theme's real art, then the fallback roles,
  // then other themes, then placeholders
  function pool(roles, s) {
    const th = themeAt(s).id, key = th + '|' + roles.join(','); if (memo.has(key)) return memo.get(key);
    let out = [];
    // with fewer than 4 pictures of the first role, the next role joins in: a row mixes shops and houses rather than repeating
    for (const kind of ['r', 'p']) { for (const t of near(th)) { let added = 0; for (let i = 0; i < roles.length; i++) { const got = (by.get(`${t}|${roles[i]}|${kind}`) || []).concat(by.get(`*|${roles[i]}|${kind}`) || []); if (!got.length) continue; out = out.concat(got); if (out.length >= 4 || ++added >= 2) break; } if (out.length) break; } if (out.length) break; }
    memo.set(key, out); return out;
  }
  return { P, themes, themeAt, pool, has: n => ok(n), info: n => P[n] };
}
// pick a picture from a pool, never one of the recent ones on this side of the road if the pool allows
export function pickFrom(pool, k, avoid) {
  if (!pool.length) return null; let c = pool[((k % pool.length) + pool.length) % pool.length];
  for (let t = 1; avoid && avoid.includes(c) && t < pool.length; t++) c = pool[(((k + t) % pool.length) + pool.length) % pool.length];
  return c;
}

// ------------------------------------------------------------------ one chunk
// env: { idx (index.json), kit (makeKit), landmarks (landmarks.json with .art filled in by the kit), signs (sign maker ids) }
export function buildChunk(d, env) {
  const { idx, kit } = env, TOTAL = idx.total, DRIVE = idx.drive === 'left' ? -1 : 1, n = Math.round(d.len / SEG) + 1, segs = new Array(n), smp = d.samples, nm = i => (i >= 0 ? d.names[i] : null), step = d.step || 10;
  // 1. slices
  for (let k = 0; k < n; k++) {
    const t = k * SEG / step, a = Math.min(smp.length - 1, Math.floor(t)), b = Math.min(smp.length - 1, a + 1), f = t - a, A = smp[a], B = smp[b];
    let ha = A[0] / 1000, dh = wrapA(B[0] / 1000 - ha); const X = f < 0.5 ? A : B, cls = CLASSW[X[2]] ? X[2] : 'mi', P0 = d.xy[a], P1 = d.xy[b];
    segs[k] = { s: d.s0 + k * SEG, x: P0[0] + (P1[0] - P0[0]) * f, y: P0[1] + (P1[1] - P0[1]) * f, hd0: ha + dh * f, h: (A[1] + (B[1] - A[1]) * f) / 10, cls, L: X[3], R: X[4], bridge: !!X[5], road: nm(X[6]), bill: [], ch: d, c: d.c };
  }
  // road class flips every few metres where a road is mapped twice (a sidewalk as a footway beside a street): short
  // runs take the class of what surrounds them, so the street doesn't come and go
  for (const maxLen of [30, 60]) { let k = 0; while (k < n) { let j = k; while (j + 1 < n && segs[j + 1].cls === segs[k].cls) j++; const before = segs[k - 1], after = segs[j + 1];
    if ((j - k + 1) * SEG < maxLen && before && after && before.cls === after.cls) for (let m = k; m <= j; m++) Object.assign(segs[m], { cls: before.cls, road: before.road }); k = j + 1; } }
  // heading smoothed over ±60 m; slopes at most 12%; heights eased over ±30 m
  for (let k = 0; k < n; k++) { let sx = 0, sy = 0; for (let j = -30; j <= 30; j++) { const v = segs[clamp(k + j, 0, n - 1)].hd0; sx += Math.cos(v); sy += Math.sin(v); } segs[k].hd = Math.atan2(sy, sx); }
  for (let k = 1; k < n; k++) segs[k].h = Math.min(segs[k].h, segs[k - 1].h + 0.24); for (let k = n - 2; k >= 0; k--) segs[k].h = Math.min(segs[k].h, segs[k + 1].h + 0.24);
  for (let k = 0; k < n; k++) { let sum = 0; for (let j = -15; j <= 15; j++) sum += segs[clamp(k + j, 0, n - 1)].h; segs[k].hs = sum / 31; }
  // built-up: buildings within 40 m on either side, or paved/lawn land. Towns get sidewalks; open road a verge.
  const frontAt = new Uint8Array(n); for (const [s, len] of d.fronts) for (let k = Math.max(0, Math.floor((s - 40) / SEG)); k <= Math.min(n - 1, Math.ceil((s + len + 40) / SEG)); k++) frontAt[k] = 1;
  for (let k = 0; k < n; k++) { const q = segs[k], town = frontAt[k] || q.L === 'pave' || q.R === 'pave'; q.town = town; q.rw0 = CLASSW[q.cls][0]; q.sw0 = town ? Math.max(CLASSW[q.cls][1], q.cls === 'sv' ? 1.2 : 2) : Math.min(1.6, CLASSW[q.cls][1]); }
  for (let k = 0; k < n; k++) { let a = 0, b = 0, t = 0; for (let j = -8; j <= 8; j++) { const q = segs[clamp(k + j, 0, n - 1)]; a += q.rw0; b += q.sw0; t += q.town ? 1 : 0; } segs[k].rw = a / 17; segs[k].sw = b / 17; segs[k].walk = t > 8; }
  if (idx.dry) for (const q of segs) for (const sd of ['L', 'R']) if (q[sd] === 'farm' || q[sd] === 'grass') q[sd] = 'desert';

  // crossings (a crosswalk and a gap in the street wall) and railway crossings
  const cross = (d.cross || []).map(([s, w, ni]) => ({ at: d.s0 + s, w, name: nm(ni) })).filter(c => c.name !== segAt(segs, d, c.at)?.road);
  for (const c of cross) for (let k = Math.max(0, Math.round((c.at - d.s0 - c.w / 2) / SEG)); k <= Math.min(n - 1, Math.round((c.at - d.s0 + c.w / 2) / SEG)); k++) segs[k].cross = true;
  for (const r of d.rails || []) for (let k = Math.max(0, Math.round((r - 4) / SEG)); k <= Math.min(n - 1, Math.round((r + 4) / SEG)); k++) segs[k].rail = d.s0 + r;
  // dense: the paved share of the land within 200 m along the road (both sides). A dense stretch builds continuous street
  // walls; a suburb of houses on lawns does not, even in the same 10 km as a city centre.
  const paveCum = new Float32Array(n + 1); for (let k = 0; k < n; k++) paveCum[k + 1] = paveCum[k] + ((segs[k].L === 'pave') + (segs[k].R === 'pave')) / 2;
  const denseAt = s => { const k = clamp(Math.round((s - d.s0) / SEG), 0, n - 1), a = Math.max(0, k - 100), b = Math.min(n, k + 100); return paveCum[b] - paveCum[a] > (b - a) * 0.6; };
  for (const q of segs) q.dense = denseAt(q.s);

  // 2. buildings on their footprints
  const planes = [], recent = { [-1]: [], [1]: [] }, remember = (sg, k) => { const r = recent[sg]; r.push(k); if (r.length > 6) r.shift(); };
  const choose = (type, h, s, sg, salt, dense) => {
    const roles = rolesFor(type, h, dense), pool = kit.pool(roles, s), pic = pickFrom(pool, hash(Math.round(s), salt + d.c * 31), recent[sg]); if (!pic) return null;
    const look = lookFor(pic, s, sg, pool.length); remember(sg, pic); return { pic, role: kit.info(pic)?.role, pool, ...look };
  };
  // a look: a mirrored and/or tinted copy, only needed when the kit is small (with 8+ pictures per pool: plain)
  const lookFor = (pic, s, sg, poolN) => poolN >= 8 ? { flip: false, tint: 0 } : { flip: hrnd(s, 91 + sg) < 0.5, tint: poolN >= 4 ? (hrnd(s, 93) < 0.6 ? 0 : 1 + (hash(Math.round(s), 95) % 3)) : hash(Math.round(s), 95) % 4 };
  const natural = (pic, h) => { const p = kit.info(pic); return p ? Math.max(5, h * p.w / p.h) : 12; };
  const heightFor = (pic, osmH, s) => { const p = kit.info(pic), base = p?.hm || ROLE_H[p?.role] || 9; if (osmH > 2) return clamp(osmH, base * 0.7, base * 1.7); return base * (0.9 + hrnd(s, 7) * 0.2); };
  for (const [s, len, side, type, hgt, ni, depth] of d.fronts) {
    const k0 = Math.max(0, Math.round(s / SEG)), k1 = Math.min(n - 1, Math.round((s + len) / SEG)); if (k1 <= k0 || segs[k0].bridge) continue;
    const sg = Math.sign(side) || 1, g0 = sg > 0 ? segs[k0].R : segs[k0].L; if (g0 === 'water') continue;
    let edge = 0; for (let k = k0; k <= k1; k++) edge = Math.max(edge, segs[k].rw + segs[k].sw + 0.4);
    const dense = denseAt(d.s0 + s) || g0 === 'pave', first = choose(type, hgt, d.s0 + s, sg, 1, dense); if (!first) continue;
    const h = heightFor(first.pic, hgt, d.s0 + s), role = kit.info(first.pic)?.role, name = nm(ni);
    // in a dense street a building sits at most 3 m behind the sidewalk: one mapped far back leaves a hole in the street wall
    // (the row behind still shows what really stands further back)
    const setback = denseAt(d.s0 + s) && Math.abs(side) > edge + 6 && Math.abs(side) < 40 ? edge + 3 : Math.max(edge, Math.abs(side));
    const p0 = { at: d.s0 + s, len: len + 0.4, side: sg * setback, hgt: h, ...first, depth: depth || 0, name, type, real: true };
    planes.push(...splitFront(p0, ATTACHED.has(role) ? 'row' : 'detached', i => choose(type, hgt, d.s0 + s + i * 37, sg, 13 + i, dense), heightFor, natural));
  }
  // tall buildings further back, seen over the street wall. Towers are seen from far off, so the same picture is never
  // used twice within 600 m of skyline (the street's own memory of six is far too short for them).
  { const kept = [], used = []; for (const [s, side, type, hgt, wid] of [...(d.skyline || [])].sort((a, b) => a[0] - b[0])) {
      if (kept.some(([s2, sd2]) => Math.abs(s2 - s) < 34 && Math.abs(sd2 - side) < 60)) continue;
      const k = clamp(Math.round(s / SEG), 0, n - 1), pool = kit.pool(rolesFor(type, hgt, true), d.s0 + s), near = used.filter(u => s - u[0] < 600).map(u => u[1]);
      const free = pool.filter(p => !near.includes(p)); if (!free.length) continue;   // rather no tower than a twin of one in view
      const pic = free[hash(Math.round(s), 5 + d.c) % free.length]; kept.push([s, side]); used.push([s, pic]);
      segs[k].bill.push({ pic, flip: hrnd(s, 3) < 0.5, tint: 0, side, hm: Math.min(hgt, 400), wm: wid, far: true, block: true }); } }

  // 3. fill where the map has no building near the road, by what the land is
  { const hasFront = (s0, sg, r) => planes.some(p => Math.sign(p.side) === sg && p.at < s0 + r && p.at + p.len > s0 - r);
    const wall = (q, sg, c, len, setback, hgt) => { if (!c) return; const w = clamp(natural(c.pic, hgt), 6, Math.max(6, len * 1.6)); planes.push({ at: q.s - w / 2, len: w, side: sg * setback, hgt, ...c, fill: true }); };
    for (let k = 6; k < n - 6; k += 11) { const q = segs[k]; if (q.cross || q.bridge || q.s < 30 || q.s > TOTAL - 30) continue;
      for (const sg of [-1, 1]) { const land = sg > 0 ? q.R : q.L, r = hrnd(q.s, sg * 31), edge = q.rw + q.sw + 0.4;
        if (land === 'water' || land === 'grass' || land === 'forest' || land === 'marsh' || land === 'sand' || land === 'lot' || hasFront(q.s, sg, 14)) continue;
        if (q.dense && land === 'pave') { const h = 12 + r * 14, c = choose('commercial', h, q.s, sg, 41, true); wall(q, sg, c, 20, edge + 0.5, heightFor(c?.pic, 0, q.s) * (h > 18 ? 1.3 : 1)); }
        else if (land === 'lawn' && r < 0.8) { const c = choose('house', 0, q.s, sg, 43, false); wall(q, sg, c, 12 + r * 4, edge + 6 + r * 8, heightFor(c?.pic, 0, q.s)); }
        else if (land === 'farm' && k % 55 === 6 && r < 0.45) { const c = choose('farm', 0, q.s, sg, 47, false); wall(q, sg, c, 22, edge + 25 + r * 40, heightFor(c?.pic, 0, q.s)); }
        else if (land === 'pave' && r < 0.5) { const c = choose('commercial', 0, q.s, sg, 49, false); wall(q, sg, c, 16, edge + 3 + r * 5, heightFor(c?.pic, 0, q.s)); } } }
    finishPlanes(planes, cross, segs, d, (type, h, s, sg) => choose(type, h, s, sg, 53, true), heightFor, natural);
    // the row behind (from the bake): the far side of a square, a park or a car park. Not part of the street wall checks.
    for (const [s, len, side, type, hgt] of d.backs || []) { const sg = Math.sign(side) || 1, c = choose(type, hgt, d.s0 + s + 777, sg, 61, denseAt(d.s0 + s)); if (!c) continue;
      const h = heightFor(c.pic, hgt, d.s0 + s); for (const p of splitFront({ at: d.s0 + s, len, side, hgt: h, ...c, back: true, cap: true, capD: 10 }, 'row', i => choose(type, hgt, d.s0 + s + i * 31, sg, 67, true), heightFor, natural)) planes.push({ ...p, back: true, cap: true, capD: 10 }); }
    // behind every gap in a built-up row (a cross street, a yard, a lane): a backing building further back, so the gap
    // shows the side walls of its two neighbours and a building behind, never open sky down to the ground
    for (const sg of [-1, 1]) { const row = planes.filter(p => Math.sign(p.side) === sg && !p.back).sort((a, b) => a.at - b.at);
      for (let i = 0; i + 1 < row.length; i++) { const p = row[i], q = row[i + 1], end = p.at + p.len, gap = q.at - end; if (gap < 0.3 || gap > 60) continue;
        const mid = segs[clamp(Math.round((end + gap / 2 - d.s0) / SEG), 0, n - 1)]; if (!mid.town || mid.bridge) continue; const land = sg > 0 ? mid.R : mid.L; if (land === 'water' || land === 'forest') continue;
        const back = Math.max(Math.abs(p.side) + (p.capD || 10), Math.abs(q.side) + (q.capD || 10)) + 2;
        if (planes.some(b => b.back && Math.sign(b.side) === sg && Math.abs(b.side) < back + 40 && b.at < end + gap * 0.3 && b.at + b.len > q.at - gap * 0.3 && b.hgt >= 0.9 * Math.min(p.hgt, q.hgt))) continue;   // a lower building behind still leaves sky between two tall ones
        const c = choose('commercial', Math.min(p.hgt, q.hgt), end + 333, sg, 73, true); if (!c) continue;
        planes.push({ ...c, at: end - 4, len: gap + 8, side: sg * back, hgt: Math.max(6, Math.max(p.hgt, q.hgt) * (1 + hrnd(end, 4) * 0.2)), back: true, fill: true, capD: 10 }); } }   // at least as tall as the taller neighbour: no sky between them
    // in a dense town, where neither the map's front row nor its row behind covers a stretch, plausible buildings stand
    // 35 to 70 m back: a town seen across a square or a junction is buildings, not paving to the horizon
    for (let k = 6; k < n - 6; k += 9) { const q = segs[k]; if (!q.dense) continue;
      for (const sg of [-1, 1]) { const land = sg > 0 ? q.R : q.L; if (land === 'water' || land === 'forest') continue;
        if (planes.some(p => Math.sign(p.side) === sg && p.at < q.s + 12 && p.at + p.len > q.s - 12)) continue;
        const c = choose('commercial', 0, q.s + 555, sg, 71, true); if (!c) continue; const h = heightFor(c.pic, 0, q.s) * 1.2, w = natural(c.pic, h);
        planes.push({ ...c, at: q.s - w / 2, len: w, side: sg * (35 + hrnd(q.s, sg * 9) * 35), hgt: h, back: true, fill: true, cap: true, capD: 10 }); } }
    planes.sort((a, b) => a.at - b.at); }

  // 4. furniture, trees and signs
  const F = env.furniture || {};
  for (let k = 0; k < n; k++) {
    const q = segs[k], s = q.s; if (q.bridge && k % 2 === 0) { for (const sg of [-1, 1]) q.bill.push({ code: 'post', side: sg * (q.rw + 0.4) }); continue; }
    if (q.cross || s < 20) continue;
    const curb = q.rw + 0.5, r = hrnd(s, 1), sg = hrnd(s, 2) < 0.5 ? -1 : 1;
    const wallAt = side => planes.some(p => Math.sign(p.side) === Math.sign(side) && p.at < s + 2 && p.at + p.len > s - 2 && Math.abs(p.side) < Math.abs(side) + 0.6);
    if (q.town && k % 15 === 0) for (const s2 of [-1, 1]) q.bill.push(pic(F, 'lamp', s, s2) || { code: 'lamp', side: s2 * curb });
    if (!q.town && k % 20 === 0 && q.cls !== 'mw' && q[DRIVE > 0 ? 'R' : 'L'] !== 'water') q.bill.push(pic(F, 'pole', s, 1, -DRIVE * 0) || { code: 'pole', side: DRIVE * (curb + q.sw + 1.2) });
    if (q.town && k % 12 === 5 && r < 0.55) { const s2 = sg, land = s2 > 0 ? q.R : q.L; if (land !== 'water' && !wallAt(s2 * (curb + 0.6))) { const t = treePick(kit, s, s2); if (t) q.bill.push({ pic: t, side: s2 * (q.rw + q.sw - 0.6), scale: 0.65 + hrnd(s, 7) * 0.25 }); } }   // street trees are smaller than country ones
    if (q.town && r > 0.985) { const p2 = kit.pool(['street'], s), ex = pickFrom(p2, hash(s, 5)); if (ex) q.bill.push({ pic: ex, side: sg * (curb + 0.5) }); }
    for (const s2 of [-1, 1]) { const g = s2 > 0 ? q.R : q.L, off = q.rw + q.sw + 2.5;
      if (g === 'forest' && k % 3 === 0) { const t = treePick(kit, s + s2, s2); if (t) q.bill.push({ pic: t, side: s2 * (off + hrnd(s, s2 * 5) * 22), scale: 0.75 + hrnd(s, 9) * 0.6 }); }
      else if ((g === 'farm' || g === 'grass') && hrnd(s, s2 * 3 + 1) < (g === 'grass' ? 0.06 : 0.025)) { const t = treePick(kit, s + s2, s2); if (t) q.bill.push({ pic: t, side: s2 * (off + hrnd(s, s2 * 3) * 30), scale: 0.7 + hrnd(s, 8) * 0.6 }); }
      else if ((g === 'farm' || g === 'grass') && !q.town && k % 3 === 0) q.bill.push({ code: 'fence', side: s2 * (off - 0.6) });
      else if (g === 'lawn' && hrnd(s, s2 * 13) < 0.04) { const t = kit.pool(['bush', 'tree'], s), b = pickFrom(t, hash(s, s2 * 17)); if (b) q.bill.push({ pic: b, side: s2 * (off + 1 + hrnd(s, 12) * 4), scale: 0.8 + hrnd(s, 3) * 0.4 }); }
      else if (g === 'desert' && k % 4 === 0 && hrnd(s, s2 * 11) < 0.5) { const t = kit.pool(['bush', 'tree'], s), b = pickFrom(t, hash(s, s2 * 19)); if (b) q.bill.push({ pic: b, side: s2 * (off + hrnd(s, s2 * 11) * 40), scale: 0.6 + hrnd(s, 10) * 0.7 }); } }
  }
  for (const c of cross) for (const sg of [-1, 1]) { const k = Math.round((c.at - c.w / 2 - 1 - d.s0) / SEG); if (segs[k] && segs[k].town) segs[k].bill.push({ code: 'signal', side: sg * (segs[k].rw + 0.4) }); }
  // landmarks with a picture stand at their real place; close to the road a building landmark replaces the frontage
  for (const lm of env.landmarks || []) { if (!lm.art || lm.s < d.s0 || lm.s >= d.s0 + d.len) continue; const info = kit.info(lm.art); if (!info) continue;
    const k = clamp(Math.round((lm.s - d.s0) / SEG), 0, n - 1), q = segs[k], sg = Math.sign(lm.side) || 1, hm = lm.h, wm = Math.max(4, hm * info.w / info.h);
    if (Math.abs(lm.side) < 60 && lm.kind !== 'bridge') { const at = lm.s - wm / 2, side = sg * Math.max(q.rw + q.sw + 1, Math.min(Math.abs(lm.side), 25));
      for (let i = planes.length - 1; i >= 0; i--) { const p = planes[i]; if (Math.sign(p.side) === sg && p.at < at + wm + 4 && p.at + p.len > at - 4) planes.splice(i, 1); }
      planes.push({ at, len: wm, side, hgt: hm, pic: lm.art, flip: false, tint: 0, cap: true, capD: 20, landmark: lm.name }); planes.sort((a, b) => a.at - b.at); }
    else q.bill.push({ pic: lm.art, side: lm.side, hm, wm, far: true, landmark: lm.name }); }
  // keep the road and the near sidewalk clear
  for (const q of segs) q.bill = q.bill.filter(b => b.far || b.code === 'post' || Math.abs(b.side) > q.rw + 0.3);
  placeSigns(d, segs, env);
  return { c: d.c, d, segs, planes, cross, places: (d.places || []).map(([s, name, rank]) => ({ at: d.s0 + s, name, rank })) };
}
function treePick(kit, s, sg) { return pickFrom(kit.pool(['tree'], s), hash(Math.round(s), 61 + sg)); }
function pic(F, slot, s, sg) { return null; }   // lamps and poles are drawn by code (crisp and free); a kit picture could be wired in here
function segAt(segs, d, s) { return segs[clamp(Math.round((s - d.s0) / SEG), 0, segs.length - 1)]; }

// A long frontage is a row of buildings, each as wide as its picture; detached kinds stand apart with yards.
export function splitFront(p, mode, chooseNext, heightFor, natural) {
  const out = [];
  if (mode === 'detached') { const end = p.at + p.len; let at = p.at, i = 0, cur = p;
    while (i < 40) { const w = Math.min(natural(cur.pic, cur.hgt), Math.max(6, end - at + 2)); out.push({ ...cur, at, len: w }); at += w + 3 + hrnd(at * 10, 5) * 5; i++; if (at > end - 5) break;
      const c = chooseNext(i); if (!c) break; cur = { ...p, ...c, hgt: heightFor(c.pic, 0, at), name: null }; }
    return out; }
  const nat = natural(p.pic, p.hgt), N = clamp(Math.round(p.len / nat), 1, 60), w = p.len / N;
  let cur = p; for (let i = 0; i < N; i++) { if (i) { const c = chooseNext(i); if (c) cur = { ...p, ...c, name: null, hgt: p.hgt * (0.9 + hrnd((p.at + i * w) * 10, 7) * 0.2) }; }
    out.push({ ...cur, at: p.at + i * w, len: w + (i < N - 1 ? 0.05 : 0) }); }
  return out;
}
// Close cracks, fill short lots in a street wall, and decide where each building shows a side wall.
export function finishPlanes(planes, cross, segs, d, chooseFill, heightFor, natural) {
  planes.sort((a, b) => a.at - b.at);
  const crossIn = (a, b) => cross.some(c => c.at + c.w / 2 + 2 > a && c.at - c.w / 2 - 2 < b), add = [];
  const landAt = (s, sg) => { const q = segs[clamp(Math.round((s - d.s0) / SEG), 0, segs.length - 1)]; return q && (sg > 0 ? q.R : q.L); };
  for (const sg of [-1, 1]) { const row = planes.filter(p => Math.sign(p.side) === sg);
    for (let i = 0; i + 1 < row.length; i++) { const p = row[i], q = row[i + 1], end = p.at + p.len, gap = q.at - end; if (gap <= 0.2 || crossIn(end, q.at)) continue;
      const city = segs[clamp(Math.round((end - d.s0) / SEG), 0, segs.length - 1)].dense, rowLike = ATTACHED.has(p.role) || ATTACHED.has(q.role) || city;
      if (gap < 3) { p.len += gap + 0.05; continue; }   // a crack under 3 m between any two buildings is closed: from the road it is a slit of sky, not a gap
      const land = landAt(end + gap / 2, sg);
      if (rowLike && gap < (city ? 90 : 60) && Math.abs(Math.abs(p.side) - Math.abs(q.side)) < (city ? 12 : 8) && land !== 'water' && land !== 'grass' && land !== 'forest' && land !== 'lot') {   // a short lot in a street wall: filled, never a park or the river
        const h = Math.max(6, Math.min(p.hgt, q.hgt) * 0.95), side = sg * Math.max(Math.abs(p.side), Math.abs(q.side));
        let at = end - 0.05, i2 = 0; while (at < q.at - 0.5 && i2 < 8) { const c = chooseFill(h > 15 ? 'residential' : 'commercial', h, at + i2 * 29, sg); if (!c) break; const left = q.at + 0.05 - at, w0 = natural(c.pic, h), w = left < w0 * 1.5 ? left : w0; add.push({ ...c, at, len: w, side, hgt: h, fill: true }); at += w; i2++; } }
      else if (!city && land === 'pave' && gap >= 18 && gap < 90) {   // a wide gap on commercial land outside a city: a parking lot with a low building set back behind it (a strip mall), not nothing
        for (let k = clamp(Math.round((end - d.s0) / SEG), 0, segs.length - 1); k <= clamp(Math.round((q.at - d.s0) / SEG), 0, segs.length - 1); k++) segs[k][sg > 0 ? 'R' : 'L'] = 'lot';
        const c = chooseFill('commercial', 7, end + gap / 2, sg); if (c) { const w = Math.min(gap * 0.8, natural(c.pic, 7)); add.push({ ...c, at: end + (gap - w) / 2, len: w, side: sg * (Math.abs(p.side) + 18 + hrnd(end, 3) * 10), hgt: 7, fill: true }); } } } }
  planes.push(...add); planes.sort((a, b) => a.at - b.at);
  // Last pass, in street order: buildings are created in several passes (mapped fronts, land-use fills, lot fills), so
  // a neighbour can still match. A building the same picture as the one next door, or the same look within 40 m, takes
  // another picture from its own pool, or failing that another mirror or tint.
  for (const sg of [-1, 1]) { const row = planes.filter(p => Math.sign(p.side) === sg); for (let i = 0; i < row.length; i++) { const p = row[i]; if (!p.pool || p.landmark) continue;
    const near = row.slice(Math.max(0, i - 16), i).filter(q => p.at - (q.at + q.len) < 40), lookOf = q => `${q.pic}|${q.flip ? 1 : 0}|${q.tint || 0}`, prev = row[i - 1], clash = () => (prev && prev.pic === p.pic && p.at - (prev.at + prev.len) < 6) || near.some(q => lookOf(q) === lookOf(p));
    if (!clash()) continue;
    const start = hash(Math.round(p.at), 71); let done = false;   // every picture in the pool, then every mirror and tint of it, until nothing nearby matches
    for (let a = 0; a < p.pool.length && !done; a++) { p.pic = p.pool[(start + a) % p.pool.length]; for (let t = 0; t < 8; t++) { p.flip = !!(t & 1); p.tint = (t >> 1) % 4; if (!clash()) { done = true; break; } } } } }
  // a side wall shows where there is a gap before the building, running back as deep as the building really is
  const lastEnd = { [-1]: -1e9, [1]: -1e9 };
  for (const p of planes) { const sg = Math.sign(p.side), gap = p.at - lastEnd[sg]; p.cap = gap > 1.5; p.capD = p.capD || (p.depth > 3 ? p.depth : clamp(p.len * 0.9, 7, p.hgt > 20 ? 30 : 14)); lastEnd[sg] = Math.max(lastEnd[sg], p.at + p.len); }
}

// ------------------------------------------------------------------ signs, drawn by code (exact lettering, free)
// Each sign is { code: 'sign', sign: {...}, side } and the viewer paints it with its pixel font.
function placeSigns(d, segs, env) {
  const { idx } = env, s0 = d.s0, s1 = d.s0 + d.len, DRIVE = idx.drive === 'left' ? -1 : 1, units = idx.units === 'miles' ? 'miles' : 'km';
  const put = (at, sign, side = DRIVE, hm = sign.hm || 2.4) => { const k = Math.round((at - s0) / SEG), q = segs[k]; if (!q || q.bridge || q.cross) return; q.bill.push({ code: 'sign', sign, side: side * (q.rw + Math.min(q.sw, 1.6) + 0.8), hm, far: true }); };
  const places = idx.places || [];
  // town names where you arrive (not in the middle of a city: you arrive at a town, not at a neighbourhood)
  for (const [at, name, rank] of places) { const a = at - 400, q = segs[Math.round((a - s0) / SEG)]; if (a >= s0 && a < s1 && a > 150 && !(q && q.L === 'pave' && q.R === 'pave')) put(a, { type: 'town', text: name, rank, country: idx.country }, DRIVE, rank >= 2 ? 2.8 : 2.4); }
  // distances: the next places and the destination, every 6 km or so (more often on short trips)
  const every = Math.max(2500, Math.min(8000, idx.total / 4));
  for (let at = Math.ceil(s0 / every) * every + every * 0.37; at < s1; at += every) { if (at < 400 || at > idx.total - 1500) continue;
    const ahead = places.filter(p => p[0] > at + 1200).slice(0, 2), lines = ahead.map(p => [p[1], dist(p[0] - at, units)]);
    if (!ahead.some(p => p[1] === idx.to.split(',')[0])) lines.push([idx.to.split(',')[0], dist(idx.total - at, units)]);
    if (lines.length) put(at, { type: 'distance', lines: lines.slice(0, 3), country: idx.country, motorway: segs[Math.round((at - s0) / SEG)]?.cls === 'mw' }, DRIVE, 4); }
  // landmarks: a brown sign 150 m before each one, pointing to its side
  for (const lm of env.landmarks || []) { if (lm.signed === false) continue; const a = lm.s - 150; if (a >= s0 && a < s1 && a > 100) put(a, { type: 'brown', text: lm.name, dir: lm.side < 0 ? -1 : 1 }, DRIVE, 2.6); }
  // railway crossings
  for (const r of d.rails || []) { const at = s0 + r; put(at - 8, { type: 'rail' }, DRIVE, 3.2); put(at + 8, { type: 'rail' }, -DRIVE, 3.2); }
  // street names at cross streets in town
  let lastStreet = -1e9; for (const c of d.cross || []) { const name = c[2] >= 0 ? d.names[c[2]] : null, at = s0 + c[0] - c[1] / 2 - 3; if (name && at - lastStreet > 150 && segs[Math.round((at - s0) / SEG)]?.town) { put(at, { type: 'street', text: name, country: idx.country }, DRIVE, 2.8); lastStreet = at; } }
}
const dist = (m, units) => units === 'miles' ? `${Math.max(1, Math.round(m / 1609.34))}` : `${Math.max(1, Math.round(m / 1000))}`;

// ------------------------------------------------------------------ the audit (scripts/check.mjs and the road's audit() hook)
// gaps: stretches of a built-up side with no building, longer than allowed, not explained by a cross street,
//       water, a park, a bridge or a railway.
// repeats: the same picture twice within a short window on one side, or the same look (picture + mirror + tint)
//       within a longer one.
export function audit(chunks, { gapCity = 10, gapTown = 18, repeatWin = 40, lookWin = 120 } = {}) {
  const out = { gaps: [], repeats: [], frontage: 0, planes: 0, pictures: new Map() };
  for (const ch of chunks) {
    const { segs, planes, cross, d } = ch;
    for (const sg of [-1, 1]) {
      const row = planes.filter(p => Math.sign(p.side) === sg && !p.back).sort((a, b) => a.at - b.at);
      let end = -1e9, lastPic = [], looks = [], prev = null;
      for (const p of row) { out.planes++; out.frontage += p.len; out.pictures.set(p.pic, (out.pictures.get(p.pic) || 0) + 1);
        const gap = p.at - end;
        if (end > -1e8 && gap > 0) { const mid = end + gap / 2, q = segs[clamp(Math.round((mid - d.s0) / SEG), 0, segs.length - 1)], land = sg > 0 ? q.R : q.L, near = Math.abs(p.side) < 25;
          const explained = cross.some(c => c.at + c.w / 2 + 3 > end && c.at - c.w / 2 - 3 < p.at) || ['water', 'grass', 'forest', 'farm', 'marsh', 'sand', 'lot', 'desert'].includes(land) || q.bridge || q.rail !== undefined;
          const allowed = q.L === 'pave' && q.R === 'pave' ? gapCity : gapTown;
          const wallish = land === 'pave' || ((p.role === 'terrace' || p.role === 'shop' || p.role === 'apartment' || p.role === 'tower') && (prev?.role === 'terrace' || prev?.role === 'shop' || prev?.role === 'apartment' || prev?.role === 'tower'));   // a street wall; detached houses on lawns have gardens between them
          if (near && q.town && wallish && !explained && gap > allowed && gap < 120) out.gaps.push({ at: Math.round(end), len: Math.round(gap), side: sg, land }); }
        if (lastPic.length && lastPic.at(-1)[0] === p.pic && p.at - lastPic.at(-1)[1] < 6) out.repeats.push({ at: Math.round(p.at), pic: p.pic, side: sg, kind: 'picture', within: Math.round(p.at - lastPic.at(-1)[1]) });   // the same picture right next door
        const look = `${p.pic}|${p.flip ? 1 : 0}|${p.tint || 0}`;
        for (const [lk, at] of looks) if (lk === look && p.at - at < repeatWin) { out.repeats.push({ at: Math.round(p.at), pic: p.pic, side: sg, kind: 'look', within: Math.round(p.at - at) }); break; }   // the identical look again within 40 m
        lastPic.push([p.pic, p.at + p.len]); if (lastPic.length > 2) lastPic.shift();
        looks.push([look, p.at + p.len]); looks = looks.filter(([, a]) => p.at - a < repeatWin);
        end = Math.max(end, p.at + p.len); prev = p; }
    }
  }
  out.pictures = Object.fromEntries(out.pictures); return out;
}
