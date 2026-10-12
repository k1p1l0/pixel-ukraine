// Step 3c: clean the generated pictures so they stand in the world with hard, honest edges (free).
//   node clean.mjs --trip TRIP [--only NAME,NAME]
// Reads TRIP/art/raw/<name>.png, writes TRIP/art/<name>.png, TRIP/art/kit.json and TRIP/art/contact.png (a contact
// sheet of every picture with its warnings: LOOK AT IT). Names listed in TRIP/art/drop.txt (one per line) are never
// used; add a picture there when it looks wrong, then re-roll it with rd.mjs run --regen NAME.
//
// Every kind of picture has its own steps (generated art comes back nearly right; the last bit is here):
//   facade     flood away the white (or flat) backdrop from the edges, defringe, then no see-through anywhere below the
//              roofline: enclosed gaps become dark window recesses, notches in a wall are filled from above, ragged
//              streaks along the base are filled (otherwise you see the sky through a building)
//   sprite, landmark   flood away the backdrop, keep the figure and its real pieces, peel the light
//              halo, clear slivers of a neighbour the generator cut through
//   all        hard alpha (no half-see-through edges), cropped to the subject
// Then the checks that decide if a picture may stand in the scene at all:
//   boxed  more than 55% of the outline is opaque: it still has a painted background (a billboard in a box)
//   sky    a building or landmark with painted sky across its top
//   cut    the subject runs off the top or the sides of the picture: a cut-off tree or prop
//   empty / tiny   nothing (or almost nothing) is left after cleaning
//   narrow a facade that came out as a sliver (under 40% of the picture's width)
//   ground a tree or prop standing on its own painted patch of ground (warning)
// boxed, sky, cut, narrow and empty pictures are dropped automatically; the viewer never shows them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, readJSON, writeJSON, readPNG, writePNG, newImage, fillRect, drawText, blit } from './lib.mjs';

const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node clean.mjs --trip TRIP'); process.exit(1); }
const ART = join(TRIP, 'art'), plan = readJSON(join(ART, 'plan.json')); if (!plan) throw Error('no art/plan.json');
const only = A.only ? new Set(A.only.split(',')) : null, N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const dropList = new Set(existsSync(join(ART, 'drop.txt')) ? readFileSync(join(ART, 'drop.txt'), 'utf8').split(/\s+/).filter(Boolean) : []);

function cutBackdrop({ width: w, height: h, data: d }) {
  const cnt = new Map(), add = i => { if (d[i + 3] > 200) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); cnt.set(k, (cnt.get(k) || 0) + 1); } };
  for (let x = 0; x < w; x++) for (const y of [0, 1]) add((y * w + x) * 4); for (let y = 0; y < h / 2; y++) for (const x of [0, w - 1]) add((y * w + x) * 4);
  let top = null, tn = 0, sampled = 0, clear = 0; for (const [k, n] of cnt) if (n > tn) { tn = n; top = k; }
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { sampled++; if (!d[(y * w + x) * 4 + 3]) clear++; } for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { sampled++; if (!d[(y * w + x) * 4 + 3]) clear++; }
  // a flat non-white backdrop counts only when the edges have no transparency and that one colour dominates them
  const c0 = top && clear < sampled * 0.05 && tn > (w + h) * 0.6 ? top.split(',').map(v => +v * 16 + 8) : null, flat = c0 && !(c0[0] > 232 && c0[1] > 232 && c0[2] > 232);
  const bg = i => d[i * 4 + 3] === 0 || (d[i * 4] > 232 && d[i * 4 + 1] > 232 && d[i * 4 + 2] > 232) || (flat && Math.abs(d[i * 4] - c0[0]) + Math.abs(d[i * 4 + 1] - c0[1]) + Math.abs(d[i * 4 + 2] - c0[2]) < 40);
  const seen = new Uint8Array(w * h), st = []; for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x); for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
  while (st.length) { const i = st.pop(); if (seen[i]) continue; seen[i] = 1; if (!bg(i)) continue; d[i * 4 + 3] = 0; const x = i % w, y = (i / w) | 0; if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (y > 0) st.push(i - w); if (y < h - 1) st.push(i + w); }
}
function components(W, H, on) { const lab = new Int32Array(W * H).fill(-1), comps = [];
  for (let i = 0; i < W * H; i++) { if (!on(i) || lab[i] >= 0) continue; const id = comps.length, st = [i], px = []; lab[i] = id; let edge = false;
    while (st.length) { const j = st.pop(); px.push(j); const x = j % W, y = (j / W) | 0; if (x === 0 || x === W - 1 || y === 0) edge = true; for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) if (k >= 0 && on(k) && lab[k] < 0) { lab[k] = id; st.push(k); } }
    comps.push({ px, edge }); } return comps; }
function defringe({ width: W, height: H, data: d }) {
  const on = i => d[i * 4 + 3] > 0, comps = components(W, H, on), big = Math.max(0, ...comps.map(c => c.px.length)), total = comps.reduce((a, c) => a + c.px.length, 0);
  for (const c of comps) if (c.px.length < big * 0.02 || (c.edge && c.px.length < total * 0.15 && c.px.length !== big)) for (const j of c.px) d[j * 4 + 3] = 0;   // specks, and slivers of a neighbour cut through at the edge
  for (let pass = 0; pass < 2; pass++) { const kill = [];   // the light halo a background remover leaves: light grey pixels touching transparency
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!on(i)) continue; const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 200 && mx - mn < 40 && N4.some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X < 0 || Y < 0 || X >= W || Y >= H || !on(Y * W + X); })) kill.push(i); }
    for (const i of kill) d[i * 4 + 3] = 0; }
}
const hardAlpha = ({ data: d }, t = 140) => { for (let i = 3; i < d.length; i += 4) d[i] = d[i] > t ? 255 : 0; };
function noSeeThrough({ width: w, height: h, data: d }) {
  const op = i => d[i * 4 + 3] > 128, copy = (i, j) => { d[i * 4] = d[j * 4]; d[i * 4 + 1] = d[j * 4 + 1]; d[i * 4 + 2] = d[j * 4 + 2]; d[i * 4 + 3] = 255; }; let n = 0;
  const out = new Uint8Array(w * h), st = []; for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x); for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
  while (st.length) { const i = st.pop(); if (out[i] || op(i)) continue; out[i] = 1; const x = i % w; if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (i >= w) st.push(i - w); if (i < w * (h - 1)) st.push(i + w); }
  for (let i = 0; i < w * h; i++) if (!out[i] && !op(i)) { d[i * 4] = 38; d[i * 4 + 1] = 35; d[i * 4 + 2] = 44; d[i * 4 + 3] = 255; n++; }   // enclosed gaps: dark window recesses
  for (let x = 0; x < w; x++) { let t = -1, b = -1; for (let y = 0; y < h; y++) if (op(y * w + x)) { if (t < 0) t = y; b = y; } for (let y = t + 1; y < b; y++) if (!op(y * w + x)) { copy(y * w + x, (y - 1) * w + x); n++; } }   // a notch with wall above and below
  // a gap that runs from the roof to the ground between two buildings drawn in one picture (a pair of houses, a terrace
  // with a passage) is open at the top, so the steps above miss it: below the eaves, every row is closed between its first
  // and last wall pixel, in a shaded copy of the wall beside it (it reads as the recess of a passage, never as sky)
  { let eave = -1; for (let y = 0; y < h && eave < 0; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (op(y * w + x)) { if (a < 0) a = x; b = x; } if (a >= 0 && b - a > w * 0.6) eave = y; }
    if (eave >= 0) for (let y = eave; y < h; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (op(y * w + x)) { if (a < 0) a = x; b = x; } if (a < 0) continue;
      for (let x = a + 1; x < b; x++) { if (op(y * w + x)) continue; let e = x; while (e < b && !op(y * w + e)) e++; if (e - x < w * 0.3) for (let k = x; k < e; k++) { const i = y * w + k, j = y * w + x - 1; d[i * 4] = d[j * 4] * 0.55; d[i * 4 + 1] = d[j * 4 + 1] * 0.55; d[i * 4 + 2] = d[j * 4 + 2] * 0.6; d[i * 4 + 3] = 255; n++; } x = e; } } }   // only gaps narrower than a third of the picture
  let top = -1, bot = -1; for (let i = 0; i < w * h; i++) if (op(i)) { if (top < 0) top = (i / w) | 0; bot = (i / w) | 0; }
  if (bot > 0) { const y0 = Math.round(bot - (bot - top) * 0.22); for (let x = 0; x < w; x++) { let src = -1; for (let y = y0; y <= bot; y++) { const i = y * w + x; if (op(i)) src = i; else if (src >= 0) { copy(i, src); n++; } } } }   // ragged streaks along the base
  return n;
}
function bounds({ width: W, height: H, data: d }) { let x0 = W, y0 = H, x1 = -1, y1 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 < 0 ? null : [x0, y0, x1, y1]; }
function crop(img, b) { const { width: W, data: d } = img; const [x0, y0, x1, y1] = b;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) out.set(d.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1 + 1) * 4), y * w * 4); return { width: w, height: h, data: out }; }
const coverage = ({ data: d }) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n / (d.length / 4); };
function outlineOpaque({ width: W, height: H, data: d }) { let n = 0, o = 0; const a = (x, y) => d[(y * W + x) * 4 + 3] > 40; for (let x = 0; x < W; x++) { n += 2; o += a(x, 0) + a(x, H - 1); } for (let y = 0; y < H; y++) { n += 2; o += a(0, y) + a(W - 1, y); } return o / n; }
function edgeTouch({ width: W, height: H, data: d }) { const a = (x, y) => d[(y * W + x) * 4 + 3] > 128; let t = 0, l = 0, r = 0, b = 0; for (let x = 0; x < W; x++) { t += a(x, 0); b += a(x, H - 1); } for (let y = 0; y < H; y++) { l += a(0, y); r += a(W - 1, y); } return { t, l, r, b }; }
function skyTop(img) {   // painted sky: one flat sky-coloured fill across the top of the picture (a glass tower has its window grid instead)
  const { width: W, data: d } = img, rows = Math.max(2, Math.round(img.height * 0.08)), cnt = new Map();
  for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (d[i + 3] < 128) continue; const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); cnt.set(k, (cnt.get(k) || 0) + 1); }
  let sky = 0; for (const [k, v] of cnt) { const [r, g, b] = k.split(',').map(x => x * 8 + 4), share = v / (W * rows); if (share > 0.1 && 0.3 * r + 0.59 * g + 0.11 * b > 150 && b >= r - 10) sky += share; }   // flat, light and cool: sky, not a warm cornice
  return sky; }
function groundPatch(img) { const { width: W, height: H, data: d } = img, wid = y => { let a = W, b = -1; for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { a = Math.min(a, x); b = Math.max(b, x); } return b - a + 1; };
  const ws = []; for (let y = Math.round(H * 0.3); y < Math.round(H * 0.85); y++) ws.push(wid(y)); ws.sort((a, b) => a - b); const med = ws[ws.length >> 1] || 1; let bottom = 0; for (let y = Math.round(H * 0.92); y < H; y++) bottom = Math.max(bottom, wid(y)); return bottom > med * 1.8 && bottom > W * 0.75; }
function avgColour({ data: d }) { let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return n ? [r / n, g / n, b / n].map(Math.round) : [128, 120, 110]; }

// ---------------------------------------------------------------- run
const kit = readJSON(join(ART, 'kit.json'), { themes: plan.themes, pictures: {} }); kit.themes = plan.themes; kit.landmarks = plan.landmarks || {}; kit.detail = plan.detail;
{ const inPlan = new Set(plan.jobs.map(j => j.name)); for (const k of Object.keys(kit.pictures)) if (!inPlan.has(k)) delete kit.pictures[k]; }   // pictures from an earlier plan are not part of this kit
let n = 0, dropped = 0;
for (const j of plan.jobs) {
  if (only && !only.has(j.name)) continue;
  const src = join(ART, 'raw', j.name + '.png'); if (!existsSync(src)) continue;
  const img = readPNG(src), before = coverage(img), flags = [];
  cutBackdrop(img); defringe(img); hardAlpha(img); const touch = edgeTouch(img);   // measured before any filling: a cut edge is the art's, not ours
  if (j.kind === 'facade') { const filled = noSeeThrough(img); if (filled > img.width * img.height * 0.02) flags.push(`holes filled (${filled} px)`); }
  const cov = coverage(img), b = bounds(img);
  if (!b) flags.push('empty');
  else {
    if (cov < 0.04) flags.push('tiny');
    const cut = j.kind === 'facade' || j.kind === 'landmark' ? touch.t > img.width * 0.15 : touch.t >= 3 || touch.l >= 3 || touch.r >= 3;
    if (cut) flags.push('cut');
  }
  const out = b ? crop(img, b) : null;
  if (out && j.kind === 'sprite' && outlineOpaque(out) > 0.55) flags.push('boxed');
  if (out && ['facade', 'landmark'].includes(j.kind) && skyTop(out) > 0.35) flags.push('sky');
  if (out && j.kind === 'facade' && out.width < j.width * 0.4) flags.push('narrow');   // a sliver of a building (a fire escape, a doorway), not a facade
  if (out && j.kind === 'sprite' && groundPatch(out)) flags.push('ground?');
  const drop = dropList.has(j.name) || flags.some(f => ['empty', 'tiny', 'cut', 'boxed', 'sky', 'narrow'].includes(f));
  if (out) writePNG(join(ART, j.name + '.png'), out);
  kit.pictures[j.name] = { file: `art/${j.name}.png`, role: j.role, theme: j.theme, kind: j.kind, w: out?.width || 0, h: out?.height || 0, hm: j.hm, avg: out ? avgColour(out) : null,
    ...(j.label ? { label: j.label } : {}), ...(j.qid ? { qid: j.qid } : {}), placeholder: false, drop, flags };
  n++; if (drop) dropped++;
  console.log(`${j.name}: ${out ? `${out.width}x${out.height}` : '-'}, opaque ${(before * 100).toFixed(0)}% -> ${(cov * 100).toFixed(0)}%${flags.length ? '  [' + flags.join(', ') + ']' : ''}${drop ? '  DROPPED' : ''}`);
}
writeJSON(join(ART, 'kit.json'), kit, true);
// the contact sheet: every picture on a checkerboard, red frame = dropped, amber = a warning, P = placeholder
const names = Object.keys(kit.pictures).sort(), C = 110, cols = 8, rows = Math.ceil(names.length / cols), sheet = newImage(cols * C, rows * (C + 10), [24, 22, 28]);
names.forEach((name, i) => { const p = kit.pictures[name], x0 = (i % cols) * C, y0 = Math.floor(i / cols) * (C + 10); for (let y = 0; y < C - 4; y += 6) for (let x = 0; x < C - 4; x += 6) fillRect(sheet, x0 + 2 + x, y0 + 2 + y, 6, 6, ((x + y) / 6) & 1 ? [70, 70, 76] : [96, 96, 102]);
  if (existsSync(join(TRIP, p.file))) { const im = readPNG(join(TRIP, p.file)), k = Math.min((C - 8) / im.width, (C - 8) / im.height, 3), w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k)); blit(sheet, im, x0 + Math.round((C - w) / 2), y0 + C - 4 - h, w, h); }
  const col = p.drop ? [220, 60, 50] : p.flags?.length ? [230, 170, 40] : null; if (col) { fillRect(sheet, x0, y0, C, 2, col); fillRect(sheet, x0, y0 + C - 2, C, 2, col); fillRect(sheet, x0, y0, 2, C, col); fillRect(sheet, x0 + C - 2, y0, 2, C, col); }
  drawText(sheet, x0 + 2, y0 + C + 2, (p.placeholder ? 'P ' : '') + name.slice(0, 26), p.drop ? [240, 110, 100] : [220, 214, 200]); });
writePNG(join(ART, 'contact.png'), sheet);
console.log(`${n} pictures cleaned, ${dropped} dropped. art/kit.json updated; contact sheet: ${join(ART, 'contact.png')} (look at it).`);
