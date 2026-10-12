// road.js: the renderer of the fly-through. A classic pseudo-3D road engine (Out Run, Pole Position, Lou's Pseudo
// 3D Page) fed by a real road. It is written to be read, top to bottom:
//
//   PICTURES   the art kit, plus mirrored, tinted, hazed and shaded copies made on demand
//   STREAMING  10 km chunks loaded ahead of you and dropped behind; layout.js turns each into slices and things
//   PROJECTION slices every 2 m; curves bend the road sideways by the real change in heading; hills raise and
//              lower each slice by its real height; a crest hides what lies behind it
//   SKY        a dithered afternoon gradient, the sun, clouds and birds at fixed bearings; the REAL horizon:
//              for each screen column the height grid is marched outwards (minus the Earth's curvature)
//   GROUND     every pixel below the horizon is traced back to (distance, offset) and coloured from the chunk:
//              asphalt, lane lines, crosswalks, curbs, sidewalk slabs, verges, fields, forest, water, parking lots.
//              Beyond the last slice (900 m) the land carries on to the horizon, hazing as it goes.
//   THINGS     buildings as blocks (facade strips along their real line plus a shaded side wall), billboards
//              (trees, plants, street props, landmarks), code-drawn lamps, poles, signals and signs; painter's order
//
// Pure presentation. The page (viewer.html) and the self-check talk to it through the object createRoad returns.
import { SEG, hash, makeKit, buildChunk, audit, TINTS } from './layout.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export async function createRoad(canvas, opts = {}) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const W = opts.width || 320, H = opts.height || 180; canvas.width = W; canvas.height = H; g.imageSmoothingEnabled = false;
  const CHECK = !!opts.check;                 // self-check mode: flat magenta sky, a building mask, no clouds or birds
  const DRAW = 450, FOCAL = Math.round(W * 0.62), CAM_H = 1.7;   // eye height: a little above a driver, so the street shows over parked cars
  const IDX = await (await fetch('data/index.json')).json();
  const LEN = IDX.total, N = Math.floor(LEN / SEG), CHS = IDX.chunk / SEG, DRIVE = IDX.drive === 'left' ? -1 : 1;
  let KITJ = { themes: [{ id: 'default', from: 0 }], pictures: {} };
  try { KITJ = await (await fetch('art/kit.json')).json(); } catch { console.warn('no art/kit.json: drawing without pictures'); }
  let LMS = []; try { LMS = await (await fetch('data/landmarks.json')).json(); } catch {}
  for (const lm of LMS) { const a = KITJ.landmarks?.[lm.qid]; if (a && KITJ.pictures[a] && !KITJ.pictures[a].drop && !KITJ.pictures[a].placeholder) lm.art = a; }   // a landmark is its real picture or nothing (its brown sign still names it)
  const signed = LMS.filter(l => l.art || l.score >= 2).slice(0, Math.max(6, Math.round(LEN / 4000))); for (const l of LMS) l.signed = signed.includes(l);
  const KIT = makeKit(KITJ);

  // ============================================================ PICTURES
  const IMG = {};
  await Promise.all(Object.entries(KITJ.pictures).filter(([, p]) => !p.drop).map(([name, p]) => new Promise(res => {
    const im = new Image(); im.onload = () => { IMG[name] = im; res(); }; im.onerror = () => { console.warn('missing picture', p.file); res(); }; im.src = p.file;
  })));
  const info = n => KITJ.pictures[n];
  const avgOf = n => info(n)?.avg || [128, 120, 110];
  // where a facade's wall starts: the first row (from the top) that is at least 90% opaque. Above it is roof, gables and
  // chimneys with sky between them; below it the wall is solid. A side wall is filled solid from there down, so the
  // gaps in a squeezed roofline never show the sky through the side of a building.
  const EAVE = new Map();
  function eaveOf(n) { if (EAVE.has(n)) return EAVE.get(n); const im = IMG[n]; let e = 0.3; if (im) { const c = canv(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height).data;
    for (let y = 0; y < im.height; y++) { let o = 0; for (let xx = 0; xx < im.width; xx++) if (d[(y * im.width + xx) * 4 + 3] > 128) o++; if (o >= im.width * 0.9) { e = y / im.height; break; } } } EAVE.set(n, e); return e; }
  const canv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  // A "look" is a picture, maybe mirrored, maybe tinted (a small kit goes further that way)
  const LOOK = new Map();
  function look(n, flip, tint) {
    const key = n + '|' + (flip ? 1 : 0) + '|' + (tint || 0); let c = LOOK.get(key); if (c) return c; const im = IMG[n]; if (!im) return null;
    c = canv(im.width, im.height); const x = c.getContext('2d');
    if (flip) { x.translate(im.width, 0); x.scale(-1, 1); } x.drawImage(im, 0, 0); x.setTransform(1, 0, 0, 1, 0, 0);
    if (tint) { const t = TINTS[tint], id = x.getImageData(0, 0, c.width, c.height), d = id.data; for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, d[i] * t[0]); d[i + 1] = Math.min(255, d[i + 1] * t[1]); d[i + 2] = Math.min(255, d[i + 2] * t[2]); } x.putImageData(id, 0, 0); }
    LOOK.set(key, c); return c;
  }
  // distance haze for things standing (the ground has its own): a few pre-hazed copies per look
  const HAZE = new Map(), SHADE = new Map();
  function hazed(n, flip, tint, z) {
    const base = look(n, flip, tint); if (!base) return null; const lv = clamp(Math.round((z - 140) / 220), 0, 4); if (!lv) return base;
    const key = n + '|' + (flip ? 1 : 0) + '|' + (tint || 0) + '|' + lv + '|' + fogCol.join(','); let c = HAZE.get(key); if (c) return c;
    c = canv(base.width, base.height); const x = c.getContext('2d'); x.drawImage(base, 0, 0); x.globalCompositeOperation = 'source-atop';
    x.fillStyle = `rgba(${fogCol[0]},${fogCol[1]},${fogCol[2]},${lv * 0.13})`; x.fillRect(0, 0, c.width, c.height); if (HAZE.size > 1500) HAZE.clear(); HAZE.set(key, c); return c;
  }
  function shaded(n, flip, tint) {   // side walls: the building's own picture in shade, only where the building is
    const key = n + '|' + (flip ? 1 : 0) + '|' + (tint || 0); let c = SHADE.get(key); if (c) return c; const base = look(n, flip, tint); if (!base) return null;
    c = canv(base.width, base.height); const x = c.getContext('2d'); x.drawImage(base, 0, 0); x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(30,24,40,0.36)'; x.fillRect(0, 0, c.width, c.height); SHADE.set(key, c); return c;
  }

  // ============================================================ STREAMING
  const CHUNKS = new Map(), env = { idx: IDX, kit: KIT, landmarks: LMS };
  async function loadChunk(c) {
    if (c < 0 || c >= IDX.count || CHUNKS.has(c)) return; CHUNKS.set(c, { loading: true });
    try { const d = await (await fetch(`data/c${String(c).padStart(4, '0')}.json`)).json(); CHUNKS.set(c, buildChunk(d, env)); }
    catch (e) { console.warn('chunk', c, e); CHUNKS.set(c, { failed: true }); }
  }
  function streamAround(s) { const c = Math.floor(s / IDX.chunk); for (let k = c - 1; k <= c + 2; k++) loadChunk(k); for (const k of [...CHUNKS.keys()]) if (k < c - 2 || k > c + 3) CHUNKS.delete(k); }
  const ready = s => { const c = CHUNKS.get(clamp(Math.floor(s / IDX.chunk), 0, IDX.count - 1)); return !!(c && (c.segs || c.failed)); };
  let lastGood = null;
  const flat = i => ({ s: i * SEG, x: 0, y: 0, hd: 0, h: 0, hs: 0, cls: 'pr', L: 'farm', R: 'farm', rw: 6, sw: 2, bill: [], town: false });
  function S(i) { i = clamp(i | 0, 0, N - 1); const c = Math.floor(i / CHS), ch = CHUNKS.get(c); if (!ch || !ch.segs) return lastGood || flat(i); return (lastGood = ch.segs[Math.min(ch.segs.length - 1, i - c * CHS)]); }
  const planesNear = (s, a, b) => { const out = []; for (const ch of CHUNKS.values()) if (ch.planes) for (const p of ch.planes) if (p.at + p.len > s + a && p.at < s + b) out.push(p); return out; };

  // ============================================================ PROJECTION
  let CAMX = DRIVE * 2.2;   // the camera's sideways place: the middle of your lane
  function project(base, frac) {
    const proj = []; let x = 0, dx = 0;
    for (let n = 0; n < DRAW; n++) {
      const q = S(Math.min(N - 1, base + n)), z = Math.max(0.3, (n - frac) * SEG + 0.3), sc = FOCAL / z;
      proj.push({ q, z, sc, xw: x, X: VIEW.cx + (x - CAMX) * sc, Y: 0 });
      const cv = wrapA(S(Math.min(N - 1, base + n + 1)).hd - q.hd); x += dx; dx -= cv * SEG;   // a left bend (heading increasing) bends the road left
    }
    return proj;
  }
  const VIEW = { hzY: 0, camY: 0, cx: W / 2 };   // cx: the screen column straight ahead (moved sideways to look aside: the self-check's oblique sweep)
  function sliceAt(proj, z) { let lo = 1, hi = DRAW - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (proj[m].z < z) lo = m + 1; else hi = m; } return lo; }
  // any point: distance ahead z, sideways offset lat from the road centre (+ right), height above the road
  function projectWorld(proj, z, lat, hgt) {
    const n = sliceAt(proj, z), p0 = proj[n - 1], p1 = proj[n], u = clamp((z - p0.z) / Math.max(1e-6, p1.z - p0.z), 0, 1);
    const xw = p0.xw + (p1.xw - p0.xw) * u, h = p0.q.hs + (p1.q.hs - p0.q.hs) * u, sc = FOCAL / z;
    return [VIEW.cx + (xw + lat - CAMX) * sc, VIEW.hzY + (VIEW.camY - h - hgt) * sc, z];
  }
  const occAt = (proj, z) => proj[sliceAt(proj, z)].occ ?? H;   // the screen line of the nearest crest in front of z
  function clipped(occ, fn) { if (occ >= H) return fn(); g.save(); g.beginPath(); g.rect(0, 0, W, Math.max(0, Math.round(occ))); g.clip(); fn(); g.restore(); }

  // ============================================================ LIGHT
  // One steady afternoon: the light the art was drawn in. T.now drifts the clouds and the birds.
  const T = { now: 0 };

  // ============================================================ SKY
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const SKY = [[52, 104, 178], [104, 156, 214], [176, 206, 228], [236, 222, 196]];   // zenith to horizon
  const fogCol = SKY[3];
  let skyH = -1, skyCanvas = null;
  function makeSky(hzY) {   // the gradient quantised to 9 levels with ordered dithering between them: it stays pixel art
    if (hzY === skyH) return; skyH = hzY;
    const stops = [[0, SKY[0]], [0.45, SKY[1]], [0.8, SKY[2]], [1, SKY[3]]], col = t => { for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (t - a) / (b - a); return ca.map((v, j) => v + (cb[j] - v) * k); } return stops.at(-1)[1]; };
    skyCanvas = canv(W, hzY + 1); const x = skyCanvas.getContext('2d'), id = x.createImageData(W, hzY + 1), L = 9;
    for (let y = 0; y <= hzY; y++) { const t = (y / Math.max(1, hzY)) * (L - 1), lo = Math.floor(t), f = t - lo;
      for (let xx = 0; xx < W; xx++) { const lv = f * 16 > BAYER[(y & 3) * 4 + (xx & 3)] ? lo + 1 : lo, c = col(Math.min(1, lv / (L - 1))), i = (y * W + xx) * 4; id.data[i] = c[0]; id.data[i + 1] = c[1]; id.data[i + 2] = c[2]; id.data[i + 3] = 255; } }
    x.putImageData(id, 0, 0);
  }
  const CLOUDS = Array.from({ length: 18 }, (_, i) => ({ az: (hash(i, 1) % 6283) / 1000, el: 0.04 + (hash(i, 2) % 200) / 1000, size: 0.5 + (hash(i, 3) % 100) / 100, seed: i }));
  const CLOUDIMG = new Map();
  function cloudImage(seed) {   // a pixel cloud: overlapping puffs, lit from above, hard edges
    if (CLOUDIMG.has(seed)) return CLOUDIMG.get(seed); const w = 40, h = 16, c = canv(w, h), x = c.getContext('2d'), id = x.createImageData(w, h);
    const puffs = Array.from({ length: 5 }, (_, i) => [8 + (hash(seed, i) % 24), 8 + (hash(seed, i + 9) % 4) - (i % 2) * 2, 4 + (hash(seed, i + 3) % 5)]);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) { let inside = false, top = 0; for (const [cx, cy, r] of puffs) { const d = Math.hypot(xx - cx, (y - cy) * 1.4); if (d < r) { inside = true; top = Math.max(top, (cy - y) / r); } }
      if (!inside || y > 12) continue; const i = (y * w + xx) * 4, v = top > 0.25 ? 255 : top > -0.2 ? 238 : 214; id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = Math.min(255, v + 6); id.data[i + 3] = 255; }
    x.putImageData(id, 0, 0); CLOUDIMG.set(seed, c); return c;
  }
  function drawSky(hzY, hd) {
    if (CHECK) { g.fillStyle = '#ff00ff'; g.fillRect(0, 0, W, hzY + 1); return; }
    makeSky(hzY); g.drawImage(skyCanvas, 0, 0);
    const toX = az => { const d = wrapA(az - hd); return Math.abs(d) > 1.2 ? null : VIEW.cx - Math.tan(d) * FOCAL; }, t = T.now;
    // the sun, low in the south-west: a pale disc with two faint rings. It stays put while the road turns under it.
    const sx = toX(Math.PI * 1.15); if (sx != null) { const sy = hzY - 0.2 * FOCAL; for (const [r, a] of [[18, 0.06], [11, 0.12]]) { g.fillStyle = `rgba(255,240,200,${a})`; g.beginPath(); g.arc(Math.round(sx), Math.round(sy), r, 0, 7); g.fill(); } g.fillStyle = '#fff6d8'; g.beginPath(); g.arc(Math.round(sx), Math.round(sy), 5, 0, 7); g.fill(); }
    // two small flocks of birds at fixed bearings, wings flapping
    for (let f = 0; f < 2; f++) { const x0 = toX(f * 2.4 + Math.sin(t * 0.05 + f) * 0.3); if (x0 == null) continue; const y0 = hzY - (0.2 + 0.08 * f) * FOCAL + Math.sin(t * 0.3 + f) * 6; g.fillStyle = 'rgba(40,40,50,.8)';
      for (let k = 0; k < 4 + f * 2; k++) { const bx = Math.round(x0 + Math.cos(k * 2.4 + t * 0.4) * (10 + k * 3)), by = Math.round(y0 + Math.sin(k * 1.7 + t * 0.5) * (4 + k)), up = ((t * 6 + k) | 0) % 2; g.fillRect(bx, by, 1, 1); g.fillRect(bx - 1, by - up, 1, 1); g.fillRect(bx + 1, by - up, 1, 1); } }
    // clouds at fixed bearings on a far dome: they swing across as the road turns, and drift slowly
    for (const c of CLOUDS) { const x = toX(c.az + t * 0.003); if (x == null) continue; const im = cloudImage(c.seed), w = im.width * c.size * (0.7 + c.el * 3), h = im.height * w / im.width, y = hzY - c.el * FOCAL - h * 0.6; g.drawImage(im, Math.round(x - w / 2), Math.round(y), Math.round(w), Math.round(h)); }
  }
  // The real horizon: for each screen column, march outwards over the chunk's 61 x 61 km height grid and keep the
  // steepest angle seen in three distance bands, minus the Earth's curvature (70 m at 30 km). Far bands are hazier.
  const BANDS = [[12000, 30000, [158, 168, 186]], [4000, 12000, [134, 146, 150]], [900, 4000, [112, 124, 118]]];
  function farHorizon(hzY, camY, b) {
    const F = b.ch && b.ch.far; if (!F || CHECK) return;
    const farH = (x, y) => { const gx = (x - F.x0) / F.cell, gy = (y - F.y0) / F.cell; if (gx < 0 || gy < 0 || gx > F.w - 2 || gy > F.h - 2) return null; const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, Hh = F.heights; return (Hh[j * F.w + i] * (1 - fx) + Hh[j * F.w + i + 1] * fx) * (1 - fy) + (Hh[(j + 1) * F.w + i] * (1 - fx) + Hh[(j + 1) * F.w + i + 1] * fx) * fy; };
    const tops = BANDS.map(() => new Float32Array(W).fill(hzY + 1));
    for (let x = 0; x < W; x++) { const ang = b.hd + Math.atan2(-(x - VIEW.cx), FOCAL), cx = Math.cos(ang), cy = Math.sin(ang);
      BANDS.forEach(([d0, d1], k) => { let best = -1e9; for (let d = d0; d < d1; d *= 1.06) { const h = farH(b.x + cx * d, b.y + cy * d); if (h == null) break; const e = (h - d * d / (2 * 6371000) - camY) / d; if (e > best) best = e; } tops[k][x] = Math.min(hzY + 1, hzY - best * FOCAL); }); }
    BANDS.forEach(([, , col], k) => { const c = col.map((v, i) => v + fogCol[i] * 0.15); for (const [dy, lift] of [[0, 0], [1, 22]]) { g.fillStyle = `rgb(${c.map(v => Math.min(255, v + lift) | 0).join(',')})`;
      for (let x = 0; x < W; x++) { const t = Math.round(tops[k][x]), h = hzY + 1 - t; if (h < 2 || (dy && h < 4)) continue; g.globalAlpha = Math.min(1, (h - 1) / 6); g.fillRect(x, t, 1, dy ? 1 : h); } } g.globalAlpha = 1; });   // a ridge a pixel or two above the horizon fades into the haze
  }

  // ============================================================ GROUND
  let FAST = false, BLUR = 1;
  const CENTRE = IDX.centre === 'yellow' ? [214, 176, 62] : [226, 226, 216];
  function water(lat, along, cell) { const k = hash(Math.floor(lat / (cell * 2)), Math.floor((along + T.now * 1.3) / (cell * 2))) & 255, v = (k & 15) - 8; return k < 6 ? [188, 212, 226] : [50 + v, 88 + v, 128 + v * 1.4]; }
  function besideCol(m, lat, along, cell, hh) {
    const v = (hh & 31) - 16;
    switch (m) {
      case 'water': return water(lat, along, cell);
      case 'lawn': { const drive = (hash(Math.floor(along / 14), lat > 0 ? 1 : 2) & 7) === 0 && Math.abs(along % 14 - 5) < 1.6; return drive ? [150, 146, 136] : [104 + v * 0.5, 138 + v, 76 + v * 0.4]; }   // a driveway now and then
      case 'farm': { const field = hash(Math.floor(along / 120), Math.floor(Math.abs(lat) / 60)) & 3, row = Math.floor(Math.abs(lat) / 0.9) & 1, w = (hh & 15) - 8; return field === 0 ? [176 + w, 156 + w, 92] : field === 1 ? [row ? 96 : 120, (row ? 128 : 148) + w, 62] : field === 2 ? [126 + w, 150 + w, 74] : [150 + w, 120 + w, 80]; }
      case 'forest': { const f = (hash(Math.floor(lat / 1.5), Math.floor(along / 1.5)) & 31) - 16; return [52 + f * 0.6, 84 + f, 50 + f * 0.5]; }
      case 'lot': { const bay = (Math.abs(lat) % 5.4 < 0.12 && along % 30 < 25) || (along % 30 > 24.85 && along % 30 < 25); return bay ? [214, 214, 206] : [84 + v * 0.3, 84 + v * 0.3, 88 + v * 0.3]; }   // a parking lot: asphalt and painted bays
      case 'sand': return [224 + v * 0.5, 206 + v * 0.5, 164 + v * 0.4];
      case 'rock': return [150 + v * 0.6, 140 + v * 0.6, 128 + v * 0.5];
      case 'desert': { const dot = (hash(Math.floor(lat / 2.2), Math.floor(along / 2.2)) & 63) === 0; return dot ? [120, 128, 84] : [206 + v * 0.6, 176 + v * 0.6, 132 + v * 0.4]; }
      case 'grass': { const stripe = (Math.floor(along / 3.5) & 1) * 5; return [98 + v * 0.5 + stripe, 128 + v * 0.8 + stripe, 78 + v * 0.35]; }
      case 'marsh': { const st = (hash(Math.floor(lat / 0.4), Math.floor(along / 2)) & 31) - 16; return [150 + st, 140 + st, 92 + st * 0.5]; }
      default: { const b = 150 + ((hh & 15) - 8), jt = !FAST && ((Math.abs(lat) % 2.4 < 0.07) || (along % 2.4 < 0.07)), tone = (hash(Math.floor(Math.abs(lat) / 2.4), Math.floor(along / 2.4)) & 7) - 3; return jt ? [124, 118, 108] : [b + tone * 2, b - 4 + tone * 2, b - 12 + tone]; }   // paving
    }
  }
  function groundCol(q, lat, along, cell, hh, xw) {
    const rw = q.rw, sw = q.sw, al = Math.abs(lat), cr = q.cross && al < rw + sw + 60; let c;
    if (al < rw || cr) {   // asphalt: patches, the centre line, lane lines and edge lines, a crosswalk at junctions
      const patch = (hash(Math.floor(lat / 3), Math.floor(along / 5)) & 255) / 255, v0 = 70 + patch * 10 + ((hh & 15) - 8) * 0.8; c = [v0, v0, v0 + 5];
      if (q.cls === 'tr') c = [150 + patch * 12, 128 + patch * 10, 96];
      else if (!cr && rw > 3.2) {
        if (q.cls === 'mw') { if (Math.abs(al - rw / 2) < 0.08 && (FAST || along % 12 < 4)) c = [222, 222, 214]; if (al < 0.5 && al > 0.3) c = [200, 200, 192]; }
        else if (IDX.centre === 'yellow' ? (al < 0.17 && al > 0.04) : (al < 0.08 && (FAST || along % 9 < 4))) c = CENTRE;
        if (Math.abs(al - (rw - 0.3)) < 0.07 && !q.town) c = [214, 214, 206]; }
      for (const x2 of xw) { const e = along - (x2.at - x2.w / 2), e2 = along - (x2.at + x2.w / 2); if ((e > -4 && e < -1 || e2 > 1 && e2 < 4) && al < rw && (Math.floor(lat / 0.6) & 1)) c = [222, 222, 214]; }
    } else if (q.town && al < rw + 0.25) c = [176, 172, 160];   // the curb
    else if (al < rw + 0.25 + sw) {
      if (q.town) { const sx = Math.floor(al / 1.5), sz = FAST ? 0 : Math.floor(along / 1.5), seam = !FAST && ((al % 1.5 < 0.05) || (along % 1.5 < 0.05)), v0 = 172 + ((hash(sx, sz) & 15) - 8) * 1.2 + ((hh & 7) - 4); c = seam ? [140, 136, 128] : [v0, v0 - 4, v0 - 12]; }   // sidewalk slabs on a fixed 1.5 m grid
      else { const v = (hh & 15) - 8, m = lat > 0 ? q.R : q.L; c = m === 'desert' || m === 'sand' ? [190 + v, 162 + v, 124 + v] : q.bridge ? [140, 140, 146] : [118 + v, 132 + v, 84 + v * 0.6]; }   // a gravel or grass verge
    } else c = besideCol(lat > 0 ? q.R : q.L, lat, along, cell, hh);
    if (q.rail !== undefined && al < 200) { const ae = Math.abs(along - q.rail); if (ae < 1.6) { if (ae < 1.25 && al < rw) c = [58, 56, 54]; else if (al >= rw && ae < 1.5) c = ae < 1.25 && (Math.floor((lat + 1000) / 0.55) & 1) ? [96, 74, 54] : [124, 118, 108]; if (Math.abs(ae - 0.72) < 0.07) c = [168, 170, 176]; } }   // rails, ties and ballast
    return c;
  }
  const GL = { c: canv(W, H) }; GL.x = GL.c.getContext('2d'); GL.id = GL.x.createImageData(W, H);
  const FAR = { x: new Float32Array(0), q: [] };
  function drawGround(proj, s, hzY, speed) {
    FAST = speed > 35; BLUR = 1 + Math.min(4, speed / 60);   // at speed fine ground detail would strobe: smooth it
    const D = GL.id.data; D.fill(0); let clip = H;
    const xs = []; for (const ch of CHUNKS.values()) if (ch.cross) for (const x2 of ch.cross) if (x2.at > s - 60 && x2.at < s + 960) xs.push(x2);
    for (let n = 1; n < DRAW; n++) {
      const p = proj[n - 1], a = proj[n], yTop = Math.max(Math.floor(a.Y), 0), yBot = Math.min(Math.floor(p.Y), clip - 1, H - 1);
      for (let y = yBot; y >= yTop; y--) {
        const t = (p.Y - y) / Math.max(1e-6, p.Y - a.Y), z = 1 / ((1 - t) / p.z + t / a.z), u = (z - p.z) / Math.max(1e-6, a.z - p.z);   // perspective-correct
        const sc = FOCAL / z, Xc = VIEW.cx + (p.xw + (a.xw - p.xw) * u - CAMX) * sc, along = s + z, fog = clamp((z - 250) / 900, 0, 1) * 0.5;
        const xw = xs.filter(x2 => Math.abs(along - x2.at) < x2.w / 2 + 5), cell = Math.max(0.08, z / FOCAL * 1.4) * BLUR, row = y * W;
        const pq = p.q, aq = a.q, q = pq.rw !== aq.rw || pq.sw !== aq.sw ? { ...aq, rw: pq.rw + (aq.rw - pq.rw) * u, sw: pq.sw + (aq.sw - pq.sw) * u } : aq;   // widths blend: smooth edges, not steps
        for (let x = 0; x < W; x++) { const lat = (x - Xc) / sc, c = groundCol(q, lat, along, cell, hash(Math.floor(lat / cell), FAST ? 0 : Math.floor(along / cell)), xw), i = (row + x) * 4;
          D[i] = c[0] + (fogCol[0] - c[0]) * fog; D[i + 1] = c[1] + (fogCol[1] - c[1]) * fog; D[i + 2] = c[2] + (fogCol[2] - c[2]) * fog; D[i + 3] = 255; }
      }
      if (a.Y < clip) clip = Math.ceil(a.Y);
    }
    // Beyond the last slice the land goes on to the horizon (otherwise a flat empty band). Flat ground at the far
    // slice's height, the road keeping its real course in 16 m steps, the land either side the mix of what lines the
    // road over a stretch that widens with distance (no straight seams or stripes to the horizon), a road narrower than
    // a pixel drawn faint, and haze that carries on from the near ground and closes in on the horizon. Two pixels a colour.
    if (clip > hzY + 1) { const pl = proj[DRAW - 1], hF = VIEW.camY - pl.q.hs; if (hF > 0) {
      const K = 8, DZ = K * SEG, zMax = Math.min(60000, hF * FOCAL * 2), nI = Math.max(2, Math.ceil((zMax - pl.z) / DZ) + 2);
      if (FAR.x.length < nI) FAR.x = new Float32Array(nI + 64); const FX = FAR.x, FQ = FAR.q; let x = pl.xw, dx = pl.xw - proj[DRAW - 2].xw, i0 = Math.floor(s / SEG) + DRAW - 1;
      for (let i = 0; i < nI; i++) { const q = S(i0), q2 = S(i0 + K); FX[i] = x; FQ[i] = q.cross || q.rail !== undefined ? { ...q, cross: false, rail: undefined } : q; const cv = wrapA(q2.hd - q.hd); x += dx * K - cv * SEG * K / 2; dx -= cv * SEG; i0 += K; }
      for (let y = Math.min(clip, H) - 1; y > hzY; y--) {
        const z = hF * FOCAL / (y - hzY); if (z <= pl.z) continue; const j = Math.min(nI - 1.001, (z - pl.z) / DZ), i = Math.floor(j), u = j - i, q = FQ[i], xw = FX[i] + (FX[i + 1] - FX[i]) * u;
        const sc = FOCAL / z, Xc = VIEW.cx + (xw - CAMX) * sc, along = s + z, cell = Math.max(0.08, z / FOCAL * 1.4) * BLUR, row = y * W, pxw = 2 / sc, edge = q.rw + q.sw + 0.3, thin = 2 * edge < pxw;
        const fl = Math.min(1, (z - 250) / 900) * 0.5 + Math.max(0, (z - 1150) / 12000), fog = fl < 0.6 ? fl : 0.6 + 0.4 * (1 - Math.exp(-(fl - 0.6) / 0.35));
        const span = Math.max(200, (z - pl.z) * 0.35) / DZ, mix = [-1, 1].map(sd => { const cnt = new Map(); for (let k = 0; k < 16; k++) { const qq = FQ[clamp(Math.round(j - span + 2 * span * k / 15), 0, nI - 1)], m = sd > 0 ? qq.R : qq.L; cnt.set(m, (cnt.get(m) || 0) + 1); }
          const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 3), tot = top.reduce((t, e) => t + e[1], 0); return top.map(([m, c2]) => [{ ...q, L: m, R: m, town: false }, c2 / tot]); });
        for (let x = 0; x < W; x += 2) { const lat = (x + 1 - Xc) / sc, al = Math.abs(lat), hh = hash(Math.floor(lat / cell), Math.floor(along / cell)); let c;
          if (!thin && al < edge) c = groundCol(q, lat, along, cell, hh, []);
          else { const lo = lat < 0 ? Math.min(lat, -edge) : Math.max(lat, edge); c = [0, 0, 0]; for (const [qk, wk] of mix[lat < 0 ? 0 : 1]) { const ck = groundCol(qk, lo, along, cell, hh, []); c[0] += ck[0] * wk; c[1] += ck[1] * wk; c[2] += ck[2] * wk; }
            if (thin && al < pxw / 2) { const k = Math.min(1, 2 * q.rw / pxw) * 0.85; c = [c[0] + (74 - c[0]) * k, c[1] + (74 - c[1]) * k, c[2] + (79 - c[2]) * k]; } }
          const i2 = (row + x) * 4, r0 = c[0] + (fogCol[0] - c[0]) * fog, g0 = c[1] + (fogCol[1] - c[1]) * fog, b0 = c[2] + (fogCol[2] - c[2]) * fog;
          D[i2] = r0; D[i2 + 1] = g0; D[i2 + 2] = b0; D[i2 + 3] = 255; if (x + 1 < W) { D[i2 + 4] = r0; D[i2 + 5] = g0; D[i2 + 6] = b0; D[i2 + 7] = 255; } } } } }
    GL.x.putImageData(GL.id, 0, 0); g.drawImage(GL.c, 0, -1); g.drawImage(GL.c, 0, 0);   // laid twice, one pixel apart: the crest line never leaves a row of sky under the buildings on it
  }

  // ============================================================ THINGS
  const STATS = { pictures: new Map(), boxed: 0 };
  const MASK = CHECK ? canv(W, H) : null, mg = MASK && MASK.getContext('2d');
  const markMask = (x, y, w, h, side = 1) => { if (mg) { mg.fillStyle = side < 0 ? '#f00' : '#00f';   // the side of the road, so the check can tell a gap in one street wall from the view down the street
 mg.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h)); } };
  const seen = n => STATS.pictures.set(n, (STATS.pictures.get(n) || 0) + 1);
  // A billboard: a flat picture with a real height in metres, scaled by focal / distance, stood on the ground line.
  function bill(proj, p, b, speed) {
    if (b.code) return codeThing(proj, p, b);
    const im = b.pic && hazed(b.pic, b.flip, b.tint, p.z), inf = info(b.pic); if (!im || !inf) return;
    const hm = (b.hm || inf.hm || 3) * (b.scale || 1), [bx, by, zc] = projectWorld(proj, p.z, b.side, 0); if (zc < 0.5) return;
    const sc = FOCAL / zc, h = hm * sc, w = b.wm ? Math.min(b.wm, hm * inf.w / inf.h * 1.25) * sc : h * inf.w / inf.h, sx = bx - w / 2, sy = by - h;
    if (sx > W || sx + w < 0 || h < 0.8 || zc < 2.5 || h > H * 1.6 || sy >= p.occ) return;
    if (!b.far && speed > 30 && zc < 4 + speed / 25) return;   // at speed things right beside you would be a one-frame smear
    seen(b.pic); clipped(p.occ, () => g.drawImage(im, 0, 0, im.width, im.height, Math.round(sx), Math.round(sy), Math.round(w), Math.round(h)));
  }
  function codeThing(proj, p, b) {
    const [x, y, zc] = projectWorld(proj, p.z, b.side, 0); if (zc < 1.5 || x < -60 || x > W + 60) return; const sc = FOCAL / zc, px = m => Math.max(1, Math.round(m * sc));
    clipped(p.occ, () => {
      if (b.code === 'post') { g.fillStyle = '#8a8a90'; g.fillRect(Math.round(x), Math.round(y - 1 * sc), px(0.15), px(1)); return; }
      if (b.code === 'fence') { g.fillStyle = '#5a4630'; g.fillRect(Math.round(x), Math.round(y - 1.1 * sc), px(0.1), px(1.1)); return; }
      if (b.code === 'pole') { const h = 9 * sc; if (h > H * 1.8) return; g.fillStyle = '#5b4632'; g.fillRect(Math.round(x), Math.round(y - h), px(0.22), Math.round(h)); g.fillRect(Math.round(x - 0.9 * sc), Math.round(y - h + 0.6 * sc), px(1.8 + 0.22), px(0.12)); g.fillStyle = '#d8d8cc'; for (const dx of [-0.8, 0.8]) g.fillRect(Math.round(x + dx * sc), Math.round(y - h + 0.4 * sc), px(0.1), px(0.2)); return; }
      if (b.code === 'lamp') { const h = 6 * sc, arm = -Math.sign(b.side) * 1.1 * sc; if (h > H * 1.8) return; g.fillStyle = '#3c3c44'; g.fillRect(Math.round(x), Math.round(y - h), px(0.14), Math.round(h)); g.fillRect(Math.round(Math.min(x, x + arm)), Math.round(y - h), Math.round(Math.abs(arm)) + 1, px(0.1)); g.fillStyle = '#c8c8be'; g.fillRect(Math.round(x + arm - 0.25 * sc), Math.round(y - h + 0.1 * sc), px(0.5), px(0.15));
        return; }
      if (b.code === 'signal') { const h = 4.6 * sc; if (h > H * 1.8) return; g.fillStyle = '#2e3034'; g.fillRect(Math.round(x), Math.round(y - h), px(0.14), Math.round(h)); const bw = px(0.35), bh = px(1), bx = Math.round(x - bw / 2 + px(0.07)), by = Math.round(y - h); g.fillRect(bx, by, bw, bh);
        const ph = Math.floor(T.now / 6) % 3; ['#e8402c', '#f0b030', '#40c060'].forEach((c, i) => { g.fillStyle = i === ph ? c : '#1a1a1c'; g.fillRect(bx + Math.max(0, Math.round(bw / 2 - px(0.1))), by + Math.round(bh * (0.12 + i * 0.3)), px(0.2), px(0.2)); }); return; }
      if (b.code === 'sign') { const im = signImage(b.sign); if (!im) return; const hm = b.hm || 2.4, h = hm * sc, w = h * im.width / im.height; if (h > H * 1.4 || h < 1) return; g.drawImage(im, Math.round(x - w / 2), Math.round(y - h), Math.round(w), Math.round(h)); }
    });
  }
  // A building is a block. Its front is laid along its real line in thin vertical strips (each projected from its own
  // two ends, so the wall recedes and bends over hills), and where nothing joins it a side wall runs back from the street
  // in shade. Two rules keep it from turning into giant pixels: a texture is never magnified more than about 3x (a side
  // wall repeats its own bays instead), and a wall right beside you fades to its own average colour.
  function planeDraws(proj, pl, s, draws) {
    const im0 = look(pl.pic, pl.flip, pl.tint), inf = info(pl.pic); if (!im0 || !inf) return;
    const z0 = pl.at - s + 0.3, far = proj[DRAW - 1].z, sg = Math.sign(pl.side), c = avgOf(pl.pic); if (z0 > far) return;
    // Every building is a block: its near end wall is always drawn. Where a neighbour joins it, the neighbour is nearer
    // and paints over the part it covers; where the street wall steps back, steps up or stops, the wall shows and the
    // building never reads as a flat card. Only a wall within 6 m of you that would fill the view is left out.
    if (z0 > 1.5) draws.push({ z: z0 + 0.02 + Math.abs(pl.side) * 0.001, f: () => {
      const D = Math.max(6, pl.capD || 10), [xa, ya] = projectWorld(proj, z0, pl.side, 0), [xb] = projectWorld(proj, z0, pl.side + sg * D, 0), [, ta] = projectWorld(proj, z0, pl.side, pl.hgt);
      const x0 = Math.min(xa, xb), w = Math.abs(xb - xa), hh = Math.max(1, Math.round(ya - ta) + (z0 > 60 ? 2 : 1));   // a pixel or two into the ground: never a line of sky under a building if (w < 1 || x0 > W || x0 + w < 0) return; if (hh > H * 1.6 && z0 < 6) return;   // right beside you at the corner: no wall filling the view
      const dk = shaded(pl.pic, pl.flip, pl.tint), fu = Math.min(1, 7 / Math.max(7, pl.hgt * inf.w / inf.h)), T0 = Math.max(1, Math.round(D / 7)), wide = w / T0 > inf.w * fu * 3, Tn = wide ? Math.max(T0, Math.ceil(w / (inf.w * 3))) : T0, tw = w / Tn;
      const ev = clamp((hh / inf.h - 4) / 4, 0, 1), wall = `rgb(${c[0] * 0.72 | 0},${c[1] * 0.7 | 0},${c[2] * 0.74 | 0})`;
      clipped(occAt(proj, z0), () => { markMask(x0, ta, w, hh, sg);
        if (ev >= 1) { g.fillStyle = wall; g.fillRect(Math.round(x0), Math.round(ta), Math.ceil(w), hh); return; }
        const ey = Math.round(ta + hh * eaveOf(pl.pic)); g.fillStyle = wall; g.fillRect(Math.round(x0), ey, Math.ceil(w), Math.round(ta) + hh - ey);   // solid below the eaves
        for (let t = 0; t < Tn; t++) g.drawImage(dk, 0, 0, Math.max(1, dk.width * (wide ? 1 : fu)), dk.height, Math.round(x0 + t * tw), Math.round(ta), Math.ceil(tw), hh);
        if (ev > 0) { g.globalAlpha = ev; g.fillStyle = wall; g.fillRect(Math.round(x0), Math.round(ta), Math.ceil(w), hh); g.globalAlpha = 1; } }); } });
    const [xa0] = projectWorld(proj, Math.max(0.5, z0), pl.side, 0), [xb0] = projectWorld(proj, Math.min(far, Math.max(0.6, z0 + pl.len)), pl.side, 0), SL = clamp(Math.ceil(Math.abs(xb0 - xa0) / 3), 2, 100);   // strips about 3 px wide
    let first = true;
    for (let k = 0; k < SL; k++) {
      const za = z0 + (k / SL) * pl.len, zb = z0 + ((k + 1) / SL) * pl.len; if (zb < 0.5 || za > far) continue; const zaC = Math.max(0.5, za);
      draws.push({ z: (zaC + zb) / 2 + Math.abs(pl.side) * 0.001, f: () => {   // ties: the one further out is painted first
        const [xa, ya, za0] = projectWorld(proj, zaC, pl.side, 0), [xb, , zb0] = projectWorld(proj, zb, pl.side, 0), [, ta] = projectWorld(proj, zaC, pl.side, pl.hgt); if (Math.max(za0, zb0) < 3.2) return;   // the last metres beside you would fill the edge with giant pixels
        const u0 = (zaC - z0) / pl.len, u1 = (zb - z0) / pl.len, su = sg > 0 ? u0 : 1 - Math.min(1, u1), x0 = Math.min(xa, xb), w = Math.max(1, Math.abs(xb - xa) + 0.6); if (x0 > W || x0 + w < 0) return;
        const imH = hazed(pl.pic, pl.flip, pl.tint, za0) || im0, hpx = Math.max(1, Math.round(ya - ta) + (za0 > 60 ? 2 : 1));   // sunk a pixel or two: no sliver of sky under the base
        const veil = Math.min(1, Math.max(0, (w / Math.max(0.5, (u1 - u0) * imH.width) - 2.5) / 4, (hpx / imH.height - 2.5) / 3));   // magnified past ~3x: fade to the wall's colour
        if (first) { seen(pl.pic); first = false; }
        clipped(occAt(proj, zaC), () => { markMask(x0, ta, w, hpx, sg);
          if (veil < 1) g.drawImage(imH, su * imH.width, 0, Math.max(1, (u1 - u0) * imH.width), imH.height, Math.round(x0), Math.round(ta), Math.ceil(w), hpx);
          if (veil > 0) { g.globalAlpha = veil; g.fillStyle = `rgb(${c[0] * 0.82 | 0},${c[1] * 0.8 | 0},${c[2] * 0.82 | 0})`; g.fillRect(Math.round(x0), Math.round(ta + (veil < 1 ? 0 : 0)), Math.ceil(w), hpx); g.globalAlpha = 1; } });
      } });
    }
    if (pl.name && z0 > 2) draws.push({ z: z0 - 0.01, f: () => { const im = signImage({ type: 'name', text: pl.name }), [x, y, zc] = projectWorld(proj, z0 + Math.min(4, pl.len / 2), pl.side - sg * 0.3, Math.min(4.2, pl.hgt * 0.45)), sc = FOCAL / zc, h = 0.7 * sc, w = h * im.width / im.height; if (h < 2 || h > H) return; clipped(occAt(proj, z0), () => g.drawImage(im, Math.round(x - w / 2), Math.round(y - h), Math.round(w), Math.round(h))); } });
  }

  // ------------------------------------------------------------ signs, drawn by code in a 5 x 7 pixel font
  const FONT = (() => { const r = s => s.split(' '); return {
    A: r('.###. #...# #...# ##### #...# #...# #...#'), B: r('####. #...# #...# ####. #...# #...# ####.'), C: r('.###. #...# #.... #.... #.... #...# .###.'), D: r('####. #...# #...# #...# #...# #...# ####.'),
    E: r('##### #.... #.... ####. #.... #.... #####'), F: r('##### #.... #.... ####. #.... #.... #....'), G: r('.###. #...# #.... #.### #...# #...# .####'), H: r('#...# #...# #...# ##### #...# #...# #...#'),
    I: r('### .#. .#. .#. .#. .#. ###'), J: r('..### ...#. ...#. ...#. ...#. #..#. .##..'), K: r('#...# #..#. #.#.. ##... #.#.. #..#. #...#'), L: r('#.... #.... #.... #.... #.... #.... #####'),
    M: r('#...# ##.## #.#.# #.#.# #...# #...# #...#'), N: r('#...# #...# ##..# #.#.# #..## #...# #...#'), O: r('.###. #...# #...# #...# #...# #...# .###.'), P: r('####. #...# #...# ####. #.... #.... #....'),
    Q: r('.###. #...# #...# #...# #.#.# #..#. .##.#'), R: r('####. #...# #...# ####. #.#.. #..#. #...#'), S: r('.#### #.... #.... .###. ....# ....# ####.'), T: r('##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..'),
    U: r('#...# #...# #...# #...# #...# #...# .###.'), V: r('#...# #...# #...# #...# #...# .#.#. ..#..'), W: r('#...# #...# #...# #.#.# #.#.# #.#.# .#.#.'), X: r('#...# #...# .#.#. ..#.. .#.#. #...# #...#'),
    Y: r('#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..'), Z: r('##### ....# ...#. ..#.. .#... #.... #####'),
    0: r('.###. #...# #..## #.#.# ##..# #...# .###.'), 1: r('.#. ##. .#. .#. .#. .#. ###'), 2: r('.###. #...# ....# ...#. ..#.. .#... #####'), 3: r('####. ....# ....# .###. ....# ....# ####.'),
    4: r('...#. ..##. .#.#. #..#. ##### ...#. ...#.'), 5: r('##### #.... ####. ....# ....# #...# .###.'), 6: r('.###. #.... #.... ####. #...# #...# .###.'), 7: r('##### ....# ...#. ..#.. .#... .#... .#...'),
    8: r('.###. #...# #...# .###. #...# #...# .###.'), 9: r('.###. #...# #...# .#### ....# ....# .###.'),
    ' ': r('... ... ... ... ... ... ...'), '.': r('. . . . . . #'), ',': r('.. .. .. .. .. .# #.'), '-': r('... ... ... ### ... ... ...'), "'": r('# # . . . . .'), '&': r('.##.. #..#. .##.. .#... #.#.# #..#. .##.#'), '/': r('....# ...#. ...#. ..#.. .#... .#... #....'), '<': r('...#. ..#.. .#... #.... .#... ..#.. ...#.'), '>': r('.#... ..#.. ...#. ....# ...#. ..#.. .#...') }; })();
  const plain = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const fits = t => [...plain(t)].every(ch => FONT[ch]);
  const textW = (t, k = 1) => fits(t) ? [...plain(t)].reduce((w, ch) => w + (FONT[ch][0].length + 1) * k, -k) : Math.ceil(t.length * 8 * k);
  function text(x, t, ox, oy, col, k = 1) {
    if (!fits(t)) { x.fillStyle = col; x.font = `${8 * k}px sans-serif`; x.textBaseline = 'top'; x.fillText(t, ox, oy - k); return; }   // scripts the pixel font lacks (Japanese, Greek...)
    x.fillStyle = col; let cx = ox; for (const ch of plain(t)) { const gl = FONT[ch]; gl.forEach((row, y) => { for (let i = 0; i < row.length; i++) if (row[i] === '#') x.fillRect(cx + i * k, oy + y * k, k, k); }); cx += (gl[0].length + 1) * k; } }
  const SIGNS = new Map();
  const STY = cc => ({ gb: 'uk', ie: 'uk', us: 'us', ca: 'us', mx: 'us', au: 'au', nz: 'au', fr: 'fr', de: 'de', at: 'de', ch: 'de', nl: 'de', be: 'fr', es: 'fr', it: 'fr', pt: 'fr', jp: 'jp' }[cc] || 'eu');
  function signImage(sg) {
    const key = JSON.stringify(sg); if (SIGNS.has(key)) return SIGNS.get(key); const sty = STY(IDX.country), short = t => t.length > 22 ? t.slice(0, 21) + '.' : t;
    const panel = (x, w, h, fill, line) => { x.fillStyle = '#2b241b'; x.fillRect(0, 0, w, h); x.fillStyle = fill; x.fillRect(1, 1, w - 2, h - 2); if (line) { x.fillStyle = line; x.fillRect(2, 2, w - 4, 1); x.fillRect(2, h - 3, w - 4, 1); x.fillRect(2, 2, 1, h - 4); x.fillRect(w - 3, 2, 1, h - 4); x.fillStyle = fill; x.fillRect(3, 3, w - 6, h - 6); } };
    const post = (x, px, y0, y1) => { x.fillStyle = '#2b241b'; x.fillRect(px - 1, y0, 4, y1 - y0); x.fillStyle = '#8d939a'; x.fillRect(px, y0, 2, y1 - y0 - 1); };
    let c;
    if (sg.type === 'town' || sg.type === 'street' || sg.type === 'brown' || sg.type === 'name') {
      const t = short(sg.text), k = sg.type === 'town' && sg.rank >= 2 ? 2 : 1, arrow = sg.type === 'brown' ? (sg.dir < 0 ? '< ' : '') : '', tail = sg.type === 'brown' && sg.dir > 0 ? ' >' : '', s = arrow + t + tail;
      const [fill, ink, line] = sg.type === 'brown' ? ['#7a4a2a', '#f6f2e8', '#f6f2e8'] : sg.type === 'name' ? ['#f2e6c4', '#3a2c1f', null]
        : sg.type === 'street' ? (sty === 'us' ? ['#1e6e3a', '#f6f2e8', null] : sty === 'fr' ? ['#22448a', '#f6f2e8', '#f6f2e8'] : ['#f6f2e8', '#1c1c1c', null])
        : sty === 'us' ? ['#1e6e3a', '#f6f2e8', '#f6f2e8'] : sty === 'de' ? ['#f2c41f', '#1c1c1c', '#1c1c1c'] : sty === 'fr' ? ['#f6f2e8', '#1c1c1c', '#c8202a'] : sty === 'jp' ? ['#22448a', '#f6f2e8', '#f6f2e8'] : ['#f6f2e8', '#1c1c1c', '#1c1c1c'];
      const pw = textW(s, k) + 10, ph = 7 * k + 10, legs = sg.type === 'name' ? 0 : Math.round(ph * (sg.type === 'street' ? 4 : sg.type === 'brown' ? 1.3 : 1));   // the post is part of the picture: a street name is a small plate high on a pole
      c = canv(pw, ph + legs); const x = c.getContext('2d'); if (legs) { post(x, Math.round(pw * 0.2), ph - 1, ph + legs); if (pw > 30) post(x, Math.round(pw * 0.8) - 2, ph - 1, ph + legs); }
      panel(x, pw, ph, fill, line); text(x, s, 5, 5, ink, k);
    } else if (sg.type === 'distance') {
      const [fill, ink] = sg.motorway && sty !== 'us' ? ['#22448a', '#f6f2e8'] : sty === 'us' || sty === 'uk' || sty === 'au' ? ['#1e6e3a', '#f6f2e8'] : ['#f6f2e8', '#1c1c1c'];
      const lines = sg.lines.map(([n, m]) => [short(n), m]), nw = Math.max(...lines.map(l => textW(l[0]))), dw = Math.max(...lines.map(l => textW(String(l[1])))), pw = 10 + nw + 12 + dw, ph = 8 + lines.length * 10;
      const lg = Math.round(ph * 0.6); c = canv(pw, ph + lg); const x = c.getContext('2d'); post(x, Math.round(pw * 0.25), ph - 1, ph + lg); post(x, Math.round(pw * 0.75), ph - 1, ph + lg); panel(x, pw, ph, fill, ink);
      lines.forEach(([n, m], i) => { text(x, n, 5, 5 + i * 10, sty === 'uk' && fill === '#1e6e3a' ? '#f6f2e8' : ink); text(x, String(m), pw - 5 - textW(String(m)), 5 + i * 10, sty === 'uk' && fill === '#1e6e3a' ? '#f2c14e' : ink); });
    } else if (sg.type === 'rail') {
      if (sty === 'us' || sty === 'au' || sty === 'jp') { c = canv(40, 60); const x = c.getContext('2d'); post(x, 19, 8, 60); for (const [w, col] of [[8, '#2b241b'], [5, '#f6f2e8']]) { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(3, 3); x.lineTo(37, 25); x.moveTo(37, 3); x.lineTo(3, 25); x.stroke(); } }
      else { c = canv(34, 52); const x = c.getContext('2d'); post(x, 16, 26, 52); x.fillStyle = '#2b241b'; x.beginPath(); x.moveTo(17, 0); x.lineTo(34, 30); x.lineTo(0, 30); x.fill(); x.fillStyle = '#c8202a'; x.beginPath(); x.moveTo(17, 3); x.lineTo(31, 28); x.lineTo(3, 28); x.fill(); x.fillStyle = '#f6f2e8'; x.beginPath(); x.moveTo(17, 10); x.lineTo(25, 25); x.lineTo(9, 25); x.fill(); x.fillStyle = '#1c1c1c'; x.fillRect(11, 19, 12, 2); for (let i = 0; i < 4; i++) x.fillRect(12 + i * 3, 17, 1, 2); }
    }
    if (!c) return null; const x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height); for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] > 127 ? 255 : 0; x.putImageData(id, 0, 0);   // hard edges, like every other picture
    SIGNS.set(key, c); return c;
  }

  // ============================================================ ONE FRAME
  function render(s, speed) {
    const base = Math.min(N - 2, Math.floor(s / SEG)), frac = (s % SEG) / SEG, b = S(base), b1 = S(base + 1);
    CAMX += (DRIVE * Math.min(b.rw * 0.5, 2.2 + (b.cls === 'mw' ? b.rw * 0.25 : 0)) - CAMX) * 0.05;   // drift smoothly into the middle of your lane
    const camY = b.hs + (b1.hs - b.hs) * frac + CAM_H, proj = project(base, frac), hzY = Math.round(H * 0.52);   // the horizon a little below the middle: more street, less asphalt
    for (const p of proj) p.Y = hzY + (camY - p.q.hs) * p.sc; VIEW.hzY = hzY; VIEW.camY = camY;
    let occ = H; for (const p of proj) { p.occ = occ; if (p.Y < occ) occ = p.Y; }   // for each slice, the highest nearer crest
    STATS.pictures.clear(); if (mg) mg.clearRect(0, 0, W, H);
    g.fillStyle = '#e6dcc4'; g.fillRect(0, 0, W, H);
    drawSky(hzY, b.hd); farHorizon(hzY, camY, b); drawGround(proj, s, hzY, Math.abs(speed));
    // everything standing, sorted far to near and painted in that order (the painter's algorithm)
    const draws = [];
    for (let n = DRAW - 1; n > 0; n--) { const p = proj[n]; for (const bl of p.q.bill) draws.push({ z: p.z, f: () => bill(proj, p, bl, Math.abs(speed)) }); }
    for (const pl of planesNear(s, -60, proj[DRAW - 1].z)) planeDraws(proj, pl, s, draws);
    draws.sort((a, c) => c.z - a.z); for (const d of draws) d.f();
    return b;
  }

  // ------------------------------------------------------------ the corner map: the chunk's own roads, water and land
  function drawLocalMap(cx2, s, size) {
    const q = S(Math.floor(s / SEG)), ch = CHUNKS.get(q.c); if (!ch || !ch.d || !ch.d.map) return; const m = ch.d.map, k = size / 900, x0 = q.x, y0 = q.y, rot = -q.hd + Math.PI / 2;
    cx2.save(); cx2.clearRect(0, 0, size, size); cx2.fillStyle = '#e9e2cf'; cx2.fillRect(0, 0, size, size); cx2.translate(size / 2, size * 0.62); cx2.rotate(rot); cx2.scale(k, -k);
    const path = pts => { cx2.beginPath(); pts.forEach(([x, y], i) => i ? cx2.lineTo(x - x0, y - y0) : cx2.moveTo(x - x0, y - y0)); };
    const AREA = { lot: '#c9c4bc', water: '#9cc3dc', forest: '#9cbf86', grass: '#bfd8a0', farm: '#e2dcae', pave: '#d8d2c4', marsh: '#c8d0a8', sand: '#efe0b4', desert: '#e8d4ac', rock: '#cfc6b8' };
    for (const [g2, pts] of m.areas) { if (!AREA[g2]) continue; cx2.fillStyle = AREA[g2]; path(pts); cx2.fill(); }
    cx2.lineCap = 'round'; cx2.lineJoin = 'round';
    for (const [k2, pts] of m.lines) { cx2.strokeStyle = k2 === 'rv' ? '#7fb0d0' : '#8a7f78'; cx2.lineWidth = (k2 === 'rv' ? 6 : 3) / k; path(pts); cx2.stroke(); }
    for (const [cls, pts] of m.roads) { cx2.strokeStyle = cls === 'mw' ? '#d9a050' : cls === 'pr' ? '#f4f0e6' : '#ffffff'; cx2.lineWidth = (cls === 'mw' || cls === 'pr' ? 4.5 : cls === 'mi' ? 3 : 1.8) / k; path(pts); cx2.stroke(); }
    cx2.strokeStyle = '#d2453a'; cx2.lineWidth = 3 / k; path(ch.d.xy.filter((_, i) => Math.abs(i * (ch.d.step || 10) + ch.d.s0 - s) < 1500)); cx2.stroke();
    cx2.restore(); cx2.fillStyle = '#1c1c22'; cx2.beginPath(); cx2.moveTo(size / 2, size * 0.62 - 6); cx2.lineTo(size / 2 + 4, size * 0.62 + 4); cx2.lineTo(size / 2 - 4, size * 0.62 + 4); cx2.fill();
  }

  // ------------------------------------------------------------ the API for the page, tests and the self-check
  // where you are: the last named place passed (or the start), the town or city around it
  const FROM = IDX.from.split(',')[0], TO = IDX.to.split(',')[0];
  const placeAt = s => { let here = FROM; for (const [at, name] of IDX.places) { if (at <= s + 300) here = name; else break; } if (s > LEN - 500) here = TO;
    const towns = [[0, FROM], [LEN, TO], ...IDX.places.filter(p => p[2] >= 2).map(p => [p[0], p[1]])]; let area = towns[0]; for (const t of towns) if (Math.abs(t[0] - s) < Math.abs(area[0] - s)) area = t;
    return { here, area: area[1] !== here ? area[1] : null }; };
  return {
    W, H, IDX, KITJ, LEN, LMS, T, CHECK, setLook: deg => { VIEW.cx = W / 2 + Math.tan(deg * Math.PI / 180) * FOCAL; },
    streamAround, ready, render, drawLocalMap, placeAt, roadAt: s => S(Math.floor(s / SEG)),
    stats: () => ({ pictures: Object.fromEntries(STATS.pictures), visible: STATS.pictures.size }),
    mask: () => MASK, audit: () => audit([...CHUNKS.values()].filter(c => c.segs)),
    chunks: CHUNKS,
  };
}
