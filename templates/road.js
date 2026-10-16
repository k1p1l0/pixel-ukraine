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
  const SMOOTH = opts.smooth !== false;   // a picture squeezed below its own size is averaged, not sampled: a far facade stays a facade, not noise
  const minified = (sw, sh, dw, dh) => SMOOTH && (dw < sw * 0.9 || dh < sh * 0.9);
  const CHECK = !!opts.check;                 // self-check mode: flat magenta sky, a building mask, no clouds or birds
  const DRAW = 450, FOCAL = Math.round(W * 0.62); let CAM_H = 1.7, PITCH = 0;   // eye height and a look-down offset of the horizon in pixels (the intro bends down)   // eye height: a little above a driver, so the street shows over parked cars
  const IDX = await (await fetch('data/index.json')).json();
  if (!Array.isArray(IDX.sea)) { const out = []; let run = null;   // an index.json baked before the sea legs has no sea ranges (the Ukraine loop's did not: its overview showed the ship on land, Kyrylo 2026-10-14): 20+ km in a row of open water is a sea stretch
    for (const k of (IDX.chunks || []).flatMap(c => c.perKm || [])) { const w = k.land && k.land.water === 100 && Object.keys(k.land).length === 1; if (w) { if (run) run[1] = k.s0 + 1000; else run = [k.s0, k.s0 + 1000]; } else if (run) { out.push(run); run = null; } }
    if (run) out.push(run); IDX.sea = out.filter(([a, b]) => b - a >= 20000); }
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
  for (const [n, c] of Object.entries({ ...sunflowerArt(), ...boatArt() })) { IMG[n] = c; KITJ.pictures[n] = { file: null, role: n === '~boat' ? 'boat' : 'sunflower', theme: '*', kind: 'sprite', w: c.width, h: c.height, hm: c.hm, avg: c.avg, placeholder: false, drop: false, flags: [], code: true }; }   // the sunflower fields' plants (layout.js plants them), drawn by code after the kit so its pools never see them; ~boat is another rider on the sea
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
    if (c < 0 || c >= IDX.count) return; const old = CHUNKS.get(c); if (old && !(old.failed && Date.now() - old.t > 4000)) return; CHUNKS.set(c, { loading: true });   // a failed chunk (a phone losing the network) is asked again after 4 s
    try { const d = await (await fetch(`data/c${String(c).padStart(4, '0')}.json`)).json(); CHUNKS.set(c, buildChunk(d, env)); shore(c); }
    catch (e) { console.warn('chunk', c, e); CHUNKS.set(c, { failed: true, t: Date.now() }); }
  }
  // a land chunk beside a sea stretch comes down to the water's level at 6% (the map has Zatoka's road 54 m above the sea, Odesa's 28 m: it stood up as a grey wall over the bow, QA, 15 Oct)
  function shore(c) { for (const [a, b] of [[c - 1, c], [c, c + 1]]) { const A = CHUNKS.get(a), B = CHUNKS.get(b); if (!A?.segs || !B?.segs || !A.d.sea === !B.d.sea) continue; const land = A.d.sea ? B : A, sea = A.d.sea ? A : B, head = land === B, key = head ? 'shore0' : 'shore1'; if (land[key]) continue; land[key] = true;
    const sl = sea.segs[head ? sea.segs.length - 1 : 0].hs, n = land.segs.length; land.segs.forEach((q, k) => { const lim = 0.06 * (head ? k : n - 1 - k) * SEG; q.hs = sl + Math.max(-lim, Math.min(lim, q.hs - sl)); }); } }
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
  const SKY = [[52, 104, 178], [104, 156, 214], [176, 206, 228], [236, 222, 196]];   // zenith to horizon (rewritten in place by the time of day)
  const fogCol = SKY[3];
  let skyH = -1, skyCanvas = null;
  // ---- time of day (Ukraine branch): the sun and the moon stand where they really are for this spot and this moment, night is dark
  const DAYP = [[52, 104, 178], [104, 156, 214], [176, 206, 228], [236, 222, 196]], DUSKP = [[36, 44, 100], [150, 86, 110], [232, 140, 92], [250, 204, 150]], NIGHTP = [[5, 8, 24], [9, 14, 40], [18, 27, 60], [34, 45, 80]];
  const TOD = { mode: opts.time || 'auto', el: 0.6, az: Math.PI * 1.15, dark: 0, key: '', moonEl: 0.5, moonAz: 0 };
  function solar(date, lat, lon) {   // NOAA low-precision solar position, about a degree: elevation and compass azimuth in radians
    const rad = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5, g = (357.529 + 0.98560028 * d) % 360, q = (280.459 + 0.98564736 * d) % 360, L = (q + 1.915 * Math.sin(g * rad) + 0.02 * Math.sin(2 * g * rad)) % 360;
    const e = 23.439 - 0.00000036 * d, RA = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)), dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24, H = (gmst + lon / 15) * 15 * rad - RA, la = lat * rad;
    const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)), az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) + Math.PI;
    return { el, az: (az + 4 * Math.PI) % (2 * Math.PI) }; }
  const mixP = (A, B, k) => A.map((c, i) => c.map((v, j) => v + (B[i][j] - v) * k));
  function setTime(mode) { TOD.mode = mode || 'auto'; TOD.key = ''; }
  function updateTOD(q) {
    const ch = CHUNKS.get(q.c), o = ch?.d?.origin || [(IDX.line?.[0] || 0) / 1e5, (IDX.line?.[1] || 0) / 1e5], lon = o[0], lat = o[1], m = TOD.mode; let el, az;
    if (m === 'day') { el = 0.6; az = Math.PI * 1.15; } else if (m === 'night') { el = -0.5; az = Math.PI * 0.2; } else if (m === 'dusk') { el = 0.02; az = Math.PI * 1.4; } else if (m === 'dawn') { el = 0.03; az = Math.PI * 0.55; }
    else { let date = new Date(); const t = /^(\d{1,2}):(\d{2})$/.exec(m); if (t) { date = new Date(); date.setUTCHours(+t[1] - Math.round(lon / 15), +t[2], 0, 0); } ({ el, az } = solar(date, lat, lon)); }
    TOD.el = el; TOD.az = az; TOD.moonAz = (az + Math.PI) % (2 * Math.PI); TOD.moonEl = Math.max(0.25, Math.min(0.8, -el + 0.3));
    const deg = el * 180 / Math.PI; TOD.dark = Math.max(0, Math.min(1, (-deg - 2) / 8));
    const pal = deg > 12 ? DAYP : deg > 0 ? mixP(DAYP, DUSKP, 1 - deg / 12) : deg > -9 ? mixP(DUSKP, NIGHTP, -deg / 9) : NIGHTP, key = Math.round(deg * 4);
    if (key !== TOD.key) { TOD.key = key; pal.forEach((c, i) => c.forEach((v, j) => { SKY[i][j] = Math.round(v); })); skyH = -1; } }
  const STARS = Array.from({ length: 140 }, (_, i) => ({ az: (hash(i, 11) % 6283) / 1000, el: 0.03 + (hash(i, 12) % 900) / 1000, b: 0.4 + (hash(i, 13) % 60) / 100 }));
  function nightGlow(hzY) {   // the headlights, painted on the ground before anything stands on it (so houses and trees stay solid)
    if (TOD.dark <= 0) return; g.globalCompositeOperation = 'lighter'; const R = H + 10 - hzY, gr = g.createRadialGradient(VIEW.cx, H + 10, 4, VIEW.cx, H + 10, R);
    gr.addColorStop(0, `rgba(255,228,150,${(0.5 * TOD.dark).toFixed(3)})`); gr.addColorStop(0.55, `rgba(255,228,150,${(0.16 * TOD.dark).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,228,150,0)');
    g.fillStyle = gr; g.fillRect(0, hzY, W, H - hzY); g.globalCompositeOperation = 'source-over'; }
  function nightTint() {   // after everything is painted: the night darkens the whole frame evenly
    if (TOD.dark <= 0) return; g.globalCompositeOperation = 'multiply'; g.fillStyle = `rgba(78,92,150,${(TOD.dark * 0.92).toFixed(3)})`; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
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
    // stars (at night), the moon, then the sun where it really is; all stay put while the road turns under them
    if (TOD.dark > 0) { for (const st of STARS) { const x = toX(st.az); if (x == null) continue; const y = hzY - Math.tan(st.el) * FOCAL; if (y < 0) continue; g.fillStyle = `rgba(255,255,240,${(st.b * TOD.dark).toFixed(2)})`; g.fillRect(Math.round(x), Math.round(y), 1, 1); }
      const mx = toX(TOD.moonAz); if (mx != null) { const my = hzY - Math.tan(TOD.moonEl) * FOCAL; g.fillStyle = `rgba(255,250,225,${(0.35 * TOD.dark).toFixed(2)})`; g.beginPath(); g.arc(Math.round(mx), Math.round(my), 11, 0, 7); g.fill(); g.fillStyle = `rgba(250,246,220,${TOD.dark.toFixed(2)})`; g.beginPath(); g.arc(Math.round(mx), Math.round(my), 6, 0, 7); g.fill(); g.fillStyle = `rgb(${SKY[1].join(',')})`; g.beginPath(); g.arc(Math.round(mx) + 3, Math.round(my) - 1, 5, 0, 7); g.fill(); } }
    const sx = TOD.el > -0.02 ? toX(TOD.az) : null; if (sx != null) { const sy = hzY - Math.tan(Math.max(0.02, TOD.el)) * FOCAL; for (const [r, a] of [[18, 0.06], [11, 0.12]]) { g.fillStyle = `rgba(255,240,200,${a})`; g.beginPath(); g.arc(Math.round(sx), Math.round(sy), r, 0, 7); g.fill(); } g.fillStyle = '#fff6d8'; g.beginPath(); g.arc(Math.round(sx), Math.round(sy), 5, 0, 7); g.fill(); }
    // two small flocks of birds at fixed bearings, wings flapping (not at night)
    for (let f = 0; f < (TOD.dark > 0.3 ? 0 : 2); f++) { const x0 = toX(f * 2.4 + Math.sin(t * 0.05 + f) * 0.3); if (x0 == null) continue; const y0 = hzY - (0.2 + 0.08 * f) * FOCAL + Math.sin(t * 0.3 + f) * 6; g.fillStyle = 'rgba(40,40,50,.8)';
      for (let k = 0; k < 4 + f * 2; k++) { const bx = Math.round(x0 + Math.cos(k * 2.4 + t * 0.4) * (10 + k * 3)), by = Math.round(y0 + Math.sin(k * 1.7 + t * 0.5) * (4 + k)), up = ((t * 6 + k) | 0) % 2; g.fillRect(bx, by, 1, 1); g.fillRect(bx - 1, by - up, 1, 1); g.fillRect(bx + 1, by - up, 1, 1); } }
    // clouds at fixed bearings on a far dome: they swing across as the road turns, and drift slowly
    g.globalAlpha = 1 - TOD.dark * 0.75; for (const c of CLOUDS) { const x = toX(c.az + t * 0.003); if (x == null) continue; const im = cloudImage(c.seed), w = im.width * c.size * (0.7 + c.el * 3), h = im.height * w / im.width, y = hzY - c.el * FOCAL - h * 0.6; g.drawImage(im, Math.round(x - w / 2), Math.round(y), Math.round(w), Math.round(h)); } g.globalAlpha = 1;
  }
  // The real horizon: for each screen column, march outwards over the chunk's 61 x 61 km height grid and keep the
  // steepest angle seen in three distance bands, minus the Earth's curvature (70 m at 30 km). Far bands are hazier.
  const BANDS = [[12000, 30000, [158, 168, 186]], [4000, 12000, [134, 146, 150]], [900, 4000, [112, 124, 118]]];
  let WOOD = null, WOODK = '';   // a 24x24 dithered pattern of tree crowns for the near hillsides
  function woodPattern(c) { const key = c.map(v => v | 0).join(','); if (WOOD && WOODK === key) return WOOD; WOODK = key; const pc = canv(24, 24), x = pc.getContext('2d');
    x.fillStyle = `rgb(${c.map(v => v | 0).join(',')})`; x.fillRect(0, 0, 24, 24);
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) { const h = hash(i * 7 + 3, j * 13 + 1) % 100; if (h < 18) { x.fillStyle = `rgb(${c.map(v => Math.max(0, v - 22) | 0).join(',')})`; x.fillRect(i, j, 1, 1); } else if (h < 30) { x.fillStyle = `rgb(${c.map(v => Math.min(255, v + 16) | 0).join(',')})`; x.fillRect(i, j, 1, 1); } }
    return (WOOD = g.createPattern(pc, 'repeat')); }
  function farHorizon(hzY, camY, b) {
    const F = b.ch && b.ch.far; if (!F || CHECK) return;
    const farH = (x, y) => { const gx = (x - F.x0) / F.cell, gy = (y - F.y0) / F.cell; if (gx < 0 || gy < 0 || gx > F.w - 2 || gy > F.h - 2) return null; const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, Hh = F.heights; return (Hh[j * F.w + i] * (1 - fx) + Hh[j * F.w + i + 1] * fx) * (1 - fy) + (Hh[(j + 1) * F.w + i] * (1 - fx) + Hh[(j + 1) * F.w + i + 1] * fx) * fy; };
    // hilly chunks carry a near grid (±4 km at 100 m): the valley sides within 4 km come from it, the far ridges from the 1 km grid
    const Nn = b.ch.near, nearH = Nn ? (x, y) => { const gx = (x - Nn.x0) / Nn.cell, gy = (y - Nn.y0) / Nn.cell; if (gx < 0 || gy < 0 || gx > Nn.w - 2 || gy > Nn.h - 2) return null; const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, Hh = Nn.heights; return (Hh[j * Nn.w + i] * (1 - fx) + Hh[j * Nn.w + i + 1] * fx) * (1 - fy) + (Hh[(j + 1) * Nn.w + i] * (1 - fx) + Hh[(j + 1) * Nn.w + i + 1] * fx) * fy; } : null;
    const bands = Nn ? [...BANDS.slice(0, 2), [1500, 4000, [104, 118, 104]], [500, 1500, [86, 110, 74]], [120, 500, [70, 98, 58]]] : BANDS, hAt = (x, y, d) => (Nn ? nearH(x, y) : null) ?? farH(x, y);
    const tops = bands.map(() => new Float32Array(W).fill(hzY + 1)), smooth = bands.map(() => new Float32Array(W).fill(hzY + 1));   // smooth: the slope line before its pixel jitter, for the shading
    for (let x = 0; x < W; x++) { const ang = b.hd + Math.atan2(-(x - VIEW.cx), FOCAL), cx = Math.cos(ang), cy = Math.sin(ang);
      bands.forEach(([d0, d1], k) => { let best = -1e9; for (let d = d0; d < d1; d *= 1.04) { const h = hAt(b.x + cx * d, b.y + cy * d, d); if (h == null) break; const e = (h - d * d / (2 * 6371000) - camY) / d; if (e > best) best = e; } smooth[k][x] = hzY - best * FOCAL; tops[k][x] = Math.min(hzY + 1, smooth[k][x] + (k > 1 && Nn ? (hash(x, k) % 3) - 1 : 0)); }); }   // near slopes: a pixel of jitter so a wooded edge is not a ruler line
    bands.forEach(([d0, , col], k) => { const c = col.map((v, i) => v + fogCol[i] * (d0 < 1500 ? 0.05 : 0.15)); for (const [dy, lift] of [[0, 0], [1, 22]]) { g.fillStyle = d0 < 1500 && !dy ? woodPattern(c) : `rgb(${c.map(v => Math.min(255, v + lift) | 0).join(',')})`;
      for (let x = 0; x < W; x++) { const t = Math.round(tops[k][x]), h = hzY + 1 - t; if (h < 2 || (dy && h < 4)) continue; g.globalAlpha = Math.min(1, (h - 1) / 6); g.fillRect(x, t, 1, dy ? 1 : h); } } g.globalAlpha = 1;
      if (d0 < 1500) { const T = tops[k], Sm = smooth[k]; for (let x = 0; x < W; x++) { const t = Math.round(T[x]), h = hzY + 1 - t; if (h < 3) continue; let sl = 0; for (let o = 1; o <= 8; o++) sl += (Sm[Math.max(0, x - o)] - Sm[Math.min(W - 1, x + o)]) / (2 * o); sl *= 0.025;   // a slope lit from the left: faces that rise to the right catch the light, the others fall into shade
          if (Math.abs(sl) < 0.02) continue; g.fillStyle = sl > 0 ? 'rgba(255,245,200,1)' : 'rgba(10,20,10,1)'; g.globalAlpha = Math.min(0.28, Math.abs(sl)); g.fillRect(x, t, 1, h); } g.globalAlpha = 1; } });   // a ridge a pixel or two above the horizon fades into the haze
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
  // A sunflower field's ground: under the near rows of plants (layout.js) leaves and earth; beyond them, where the
  // plants are no longer drawn one by one, a sea of yellow heads with leaves between.
  let ZROW = 0;   // the distance of the ground row being painted
  function sunCol(al, hh, rows) {
    const v = (hh & 15) - 8, k = (hh >>> 8) & 15;
    if (ZROW < 45 && al < rows) return k < 3 ? [92 + v, 72 + v, 44] : k < 9 ? [52 + v, 84 + v, 32] : [70 + v, 108 + v, 40];
    return k < 7 ? [238 + v * 0.5, 186 + v, 42] : k < 10 ? [214 + v, 148 + v, 30] : k < 12 ? [104 + v, 70 + v, 30] : [78 + v, 112 + v, 40];
  }
  function groundCol(q, lat, along, cell, hh, xw) {
    if (q.ch && q.ch.sea) return water(lat, along, cell);   // a stretch crossed by ship: water everywhere, no road
    const rw = q.rw, sw = q.sw, al = Math.abs(lat), cr = q.cross && al < rw + sw + 60; let c;
    if (al < rw || cr) {   // asphalt: patches, the centre line, lane lines and edge lines, a crosswalk at junctions
      const patch = (hash(Math.floor(lat / 3), Math.floor(along / 5)) & 255) / 255, v0 = 70 + patch * 10 + ((hh & 15) - 8) * 0.8; c = [v0, v0, v0 + 5];
      if (q.cls === 'tr') c = [150 + patch * 12, 128 + patch * 10, 96];
      else if (!cr && rw > 3.2) {
        if (q.cls === 'mw') { if (Math.abs(al - rw / 2) < 0.08 && (FAST || along % 12 < 4)) c = [222, 222, 214]; if (al < 0.5 && al > 0.3) c = [200, 200, 192]; }
        else if (q.lanes >= 3 || q.lanes >= 1 && q.oneway) {   // OSM lanes: dashed lines every 3.5 m; two-way roads get a centre line (double on four lanes and more), one-way streets none
          const half = q.oneway ? 0 : rw, n = q.oneway ? q.lanes : Math.round(q.lanes / 2), dashed = FAST || along % 9 < 4;
          if (!q.oneway) { if (q.lanes >= 4 ? (al < 0.3 && Math.abs(al - 0.15) > 0.05) : (IDX.centre === 'yellow' ? al < 0.17 && al > 0.04 : al < 0.08 && dashed)) c = CENTRE; }
          if (dashed) for (let k = 1; k < n; k++) { const at = q.oneway ? -rw + 3.5 * k : 3.5 * k; if (Math.abs((q.oneway ? lat : al) - at) < 0.07) c = [222, 222, 214]; } }
        else if (IDX.centre === 'yellow' ? (al < 0.17 && al > 0.04) : (al < 0.08 && (FAST || along % 9 < 4))) c = CENTRE;
        if (Math.abs(al - (rw - 0.3)) < 0.07 && !q.town) c = [214, 214, 206]; }
      for (const x2 of xw) { const e = along - (x2.at - x2.w / 2), e2 = along - (x2.at + x2.w / 2); if ((e > -4 && e < -1 || e2 > 1 && e2 < 4) && al < rw && (Math.floor(lat / 0.6) & 1)) c = [222, 222, 214]; }
    } else if (q.town && al < rw + 0.25) c = [176, 172, 160];   // the curb
    else if (al < rw + 0.25 + sw) {
      if (q.town) { const sx = Math.floor(al / 1.5), sz = FAST ? 0 : Math.floor(along / 1.5), seam = !FAST && ((al % 1.5 < 0.05) || (along % 1.5 < 0.05)), v0 = 172 + ((hash(sx, sz) & 15) - 8) * 1.2 + ((hh & 7) - 4); c = seam ? [140, 136, 128] : [v0, v0 - 4, v0 - 12]; }   // sidewalk slabs on a fixed 1.5 m grid
      else { const v = (hh & 15) - 8, m = lat > 0 ? q.R : q.L; c = m === 'desert' || m === 'sand' ? [190 + v, 162 + v, 124 + v] : q.bridge ? [140, 140, 146] : [118 + v, 132 + v, 84 + v * 0.6]; }   // a gravel or grass verge
    } else { const m = lat > 0 ? q.R : q.L, sd = lat > 0 ? q.sR : q.sL; c = sd && m === 'farm' && al < sd && al >= (lat > 0 ? q.nR : q.nL) ? sunCol(al, hh, lat > 0 ? q.uR : q.uL) : besideCol(m, lat, along, cell, hh); }   // a sunflower field (layout.js), else the land as it is
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
        const sc = FOCAL / z, Xc = VIEW.cx + (p.xw + (a.xw - p.xw) * u - CAMX) * sc, along = s + z, fog = clamp((z - 250) / 900, 0, 1) * 0.5; ZROW = z;
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
        const z = hF * FOCAL / (y - hzY); if (z <= pl.z) continue; ZROW = z; const j = Math.min(nI - 1.001, (z - pl.z) / DZ), i = Math.floor(j), u = j - i, q = FQ[i], xw = FX[i] + (FX[i + 1] - FX[i]) * u;
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
    seen(b.pic); clipped(p.occ, () => { const m = minified(im.width, im.height, w, h); if (m) g.imageSmoothingEnabled = true; g.drawImage(im, 0, 0, im.width, im.height, Math.round(sx), Math.round(sy), Math.round(w), Math.round(h)); if (m) g.imageSmoothingEnabled = false; });
    if (LAMPS) { lg.globalCompositeOperation = 'destination-out'; lg.drawImage(im, 0, 0, im.width, im.height, Math.round(sx), Math.round(sy), Math.round(w), Math.round(h)); lg.globalCompositeOperation = 'source-over'; }   // this sprite hides any lamp behind it
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
      if (b.code === 'sign') { const im = signImage(b.sign); if (!im) return; const hm = b.hm || 2.4, h = hm * sc, w = h * im.width / im.height; if (h > H * 1.4 || h < 1) return;
        g.drawImage(im, Math.round(x - w / 2), Math.round(y - h), Math.round(w), Math.round(h)); }
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
        { const sw = Math.max(1, dk.width * (wide ? 1 : fu)), m = minified(sw, dk.height, tw, hh); if (m) g.imageSmoothingEnabled = true; for (let t = 0; t < Tn; t++) g.drawImage(dk, 0, 0, sw, dk.height, Math.round(x0 + t * tw), Math.round(ta), Math.ceil(tw), hh); if (m) g.imageSmoothingEnabled = false; }
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
          if (veil < 1) { const sw = Math.max(1, (u1 - u0) * imH.width), m = minified(sw, imH.height, w, hpx); if (m) g.imageSmoothingEnabled = true; g.drawImage(imH, su * imH.width, 0, sw, imH.height, Math.round(x0), Math.round(ta), Math.ceil(w), hpx); if (m) g.imageSmoothingEnabled = false; }
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
    ' ': r('... ... ... ... ... ... ...'), '.': r('. . . . . . #'), ',': r('.. .. .. .. .. .# #.'), '-': r('... ... ... ### ... ... ...'), "'": r('# # . . . . .'), '&': r('.##.. #..#. .##.. .#... #.#.# #..#. .##.#'), '/': r('....# ...#. ...#. ..#.. .#... .#... #....'), '<': r('...#. ..#.. .#... #.... .#... ..#.. ...#.'), '>': r('.#... ..#.. ...#. ....# ...#. ..#.. .#...'),
    // Ukrainian (and the few extra Russian) capitals, 5 x 7 like the Latin ones
    'А': r('.###. #...# #...# ##### #...# #...# #...#'), 'Б': r('##### #.... #.... ####. #...# #...# ####.'), 'В': r('####. #...# #...# ####. #...# #...# ####.'), 'Г': r('##### #.... #.... #.... #.... #.... #....'),
    'Ґ': r('....# ##### #.... #.... #.... #.... #....'), 'Д': r('..##. .#..# .#..# .#..# .#..# ##### #...#'), 'Е': r('##### #.... #.... ####. #.... #.... #####'), 'Є': r('.###. #...# #.... ###.. #.... #...# .###.'),
    'Ж': r('#.#.# #.#.# .###. ..#.. .###. #.#.# #.#.#'), 'З': r('.###. #...# ....# ..##. ....# #...# .###.'), 'И': r('#...# #...# #..## #.#.# ##..# #...# #...#'), 'І': r('### .#. .#. .#. .#. .#. ###'),
    'Ї': r('#.# ... ### .#. .#. .#. ###'), 'Й': r('.#.#. ..#.. #..## #.#.# ##..# #...# #...#'), 'К': r('#...# #..#. #.#.. ##... #.#.. #..#. #...#'), 'Л': r('.#### .#..# .#..# .#..# .#..# .#..# #...#'),
    'М': r('#...# ##.## #.#.# #.#.# #...# #...# #...#'), 'Н': r('#...# #...# #...# ##### #...# #...# #...#'), 'О': r('.###. #...# #...# #...# #...# #...# .###.'), 'П': r('##### #...# #...# #...# #...# #...# #...#'),
    'Р': r('####. #...# #...# ####. #.... #.... #....'), 'С': r('.###. #...# #.... #.... #.... #...# .###.'), 'Т': r('##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..'), 'У': r('#...# #...# #...# .#### ....# #...# .###.'),
    'Ф': r('..#.. .###. #.#.# #.#.# .###. ..#.. ..#..'), 'Х': r('#...# #...# .#.#. ..#.. .#.#. #...# #...#'), 'Ц': r('#..#. #..#. #..#. #..#. #..#. ##### ....#'), 'Ч': r('#...# #...# #...# .#### ....# ....# ....#'),
    'Ш': r('#.#.# #.#.# #.#.# #.#.# #.#.# #.#.# #####'), 'Щ': r('#.#.# #.#.# #.#.# #.#.# #.#.# ##### ....#'), 'Ь': r('#.... #.... #.... ####. #...# #...# ####.'), 'Ю': r('#..#. #.#.# #.#.# ###.# #.#.# #.#.# #..#.'),
    'Я': r('.#### #...# #...# .#### ..#.# .#..# #...#'), 'Ы': r('#...# #...# #...# ##..# #.#.# #.#.# ##..#'), 'Э': r('####. ....# ....# .#### ....# ....# ####.'), 'Ъ': r('##... .#... .#... .###. .#..# .#..# .###.'),
    'Ё': r('.#.#. ##### #.... ####. #.... #.... #####'), '’': r('# # . . . . .'), 'ʼ': r('# # . . . . .') }; })();
  // strip accents from Latin only: in Cyrillic the mark is part of the letter (NFD would turn Й into И and Ї into І)
  const plain = t => [...t.normalize('NFC').toUpperCase()].map(ch => /[\u0400-\u04FF]/.test(ch) ? ch : ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join('');
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
  // ------------------------------------------------------------ traffic (Ukraine branch): cars from the kit move on the road.
  // Same direction in the near lane, seen from behind; oncoming in the far lane, seen from the front. ?traffic=0 turns it off.
  const CARS = Object.entries(KITJ.pictures).filter(([, p]) => p.role === 'car' && !p.drop && !p.placeholder).map(([n]) => n);
  const ONC = Object.entries(KITJ.pictures).filter(([, p]) => p.role === 'oncoming' && !p.drop && !p.placeholder).map(([n]) => n);
  const TRAFFIC = [], TR_ON = opts.traffic !== false && (CARS.length || ONC.length); let trT = null, trSeed = 7;
  const trRnd = () => { trSeed = (trSeed * 1103515245 + 12345) & 0x7fffffff; return trSeed / 0x7fffffff; };
  // where a car (or a rider) sits across the road: the middle of its lane. With OSM lanes a road has n lanes of 3.5 m: a two-way road
  // gives each direction n/2 of them, a one-way street all of them (then -rw is the left edge); pick = 0..1 chooses the lane
  const laneOf = (q, pick = 1) => { if (!q || !(q.lanes >= 2 || q.lanes === 1 && q.oneway)) return (q?.rw || 3.5) * 0.5;
    if (q.oneway) { const k = Math.min(q.lanes - 1, Math.floor(pick * q.lanes)); return DRIVE * (-q.rw + 1.75 + 3.5 * k); }   // signed from the centre, then DRIVE * it puts it on the real side
    const n = Math.max(1, Math.floor(q.lanes / 2)), k = Math.min(n - 1, Math.floor(pick * n)); return 1.75 + 3.5 * k; };
  const TR_FAR = 220, TR_MAX = 22; let JAM = null;   // JAM = { v } (m/s): you are in a jam; the road ahead fills with cars that crawl at that speed   // metres of traffic ahead; above this speed (m/s, about 80 km/h) the road is yours alone
  function traffic(proj, s, draws, speed = 0) {
    if (!TR_ON) return; const dt = trT == null ? 0 : Math.max(0, Math.min(0.2, T.now - trT)); trT = T.now;
    if (Math.abs(speed) > TR_MAX && !JAM) { TRAFFIC.length = 0; return; }
    for (const v of TRAFFIC) v.s += (v.onc ? v.v : JAM ? JAM.v * v.k : Math.max(3, Math.abs(speed) * v.k)) * dt;   // the cars ahead keep about your pace: you never run into them
    for (let i = TRAFFIC.length - 1; i >= 0; i--) { const z = TRAFFIC[i].s - s; if (z < -40 || z > TR_FAR + 60) TRAFFIC.splice(i, 1); }
    const q0 = proj[0].q, mw = q0.cls === 'mw' || q0.cls === 'pr', want = JAM ? 11 : q0.town ? 5 : mw ? 6 : 3;
    while (TRAFFIC.length < want) { const onc = ONC.length && (!CARS.length || trRnd() < 0.45), pool = onc ? ONC : CARS; if (!pool.length) break;
      const z = onc ? TR_FAR + 10 + trRnd() * 30 : JAM ? 14 + trRnd() * (TR_FAR - 40) : 30 + trRnd() * (TR_FAR - 60); TRAFFIC.push({ s: s + z, v: onc ? -(12 + trRnd() * 12) : 0, k: 0.9 + trRnd() * 0.25, onc, ln: trRnd(), pic: pool[Math.floor(trRnd() * pool.length)] }); }
    for (const v of TRAFFIC) { const z = v.s - s; if (z < 2.5 || z > TR_FAR) continue; const n = sliceAt(proj, z), p = proj[n], q = p.q; if (!q || q.L === 'water' && q.R === 'water') continue;
      if (q.oneway && v.onc) continue;   // nothing comes towards you on a one-way street
      const lane = laneOf(q, JAM && !v.onc && (q.oneway ? q.lanes : q.lanes / 2) >= 2 ? v.ln * 0.999 * (1 - 1 / Math.floor(q.oneway ? q.lanes : q.lanes / 2)) : v.ln), side = v.onc ? -DRIVE * lane : DRIVE * lane;   // in a jam the cars leave your lane (the right one) free: a scooter filters past
      draws.push({ z: z - 0.01, f: () => { bill(proj, { z, occ: occAt(proj, z), q }, { pic: v.pic, side, far: true, hm: info(v.pic)?.hm }, 0);
        if (LAMPS) { const inf = info(v.pic), [bx, by, zc] = projectWorld(proj, z, side, 0); if (inf && zc > 2.5) { const sc = FOCAL / zc, h = (inf.hm || 3) * sc, w = h * inf.w / inf.h; lamp(bx, by, w, h, v.onc, occAt(proj, z)); } } } }); } }
  // the cars' lamps live on their own layer: painted in the painter's order, erased by every nearer sprite, blended in after the night tint so they stay bright
  const LC = canv(W, H), lg = LC.getContext('2d'); let LAMPS = false;
  function lamp(x0, by, w, h, onc, occ) { const k = Math.min(1, TOD.dark / 0.6), r = Math.max(1, w * (onc ? 0.085 : 0.07)), y = by - h * (onc ? 0.3 : 0.36); if (y >= occ) return;   // behind a crest
    const tint = onc ? '255,244,200' : '255,40,30', glow = onc ? 4.5 : 2.6;
    for (const sx of [-0.3, 0.3]) { const x = x0 + w * sx, gr = lg.createRadialGradient(x, y, 0, x, y, r * glow); gr.addColorStop(0, `rgba(${tint},${0.75 * k})`); gr.addColorStop(0.35, `rgba(${tint},${0.3 * k})`); gr.addColorStop(1, `rgba(${tint},0)`);
      lg.fillStyle = gr; lg.fillRect(x - r * glow, y - r * glow, r * glow * 2, r * glow * 2); lg.fillStyle = `rgba(${onc ? '255,255,240' : '255,90,70'},${0.95 * k})`; lg.fillRect(Math.round(x - r / 2), Math.round(y - r / 2), Math.max(1, Math.round(r)), Math.max(1, Math.round(r))); } }
  function carLights() { if (!LAMPS) return; g.save(); g.globalCompositeOperation = 'lighter'; g.drawImage(LC, 0, 0); g.restore(); }
  // ------------------------------------------------------------ Ukraine branch: hooks for the page (Mad Max mode) and the cockpit layer
  const HOOKS = { world: [], after: [] };   // world(proj, s, draws): add billboards; after(proj, s, speed): paint on the frame before the cockpit
  const real = n => KITJ.pictures[n] && !KITJ.pictures[n].drop && !KITJ.pictures[n].placeholder && IMG[n];
  let LIFT = 0, CAM_EASE = 0.05; const RIG = { tilt: 0, scale: 1 };   // the cockpit as held: LIFT drops it below the screen, tilt and scale show it lying on the ground   // LIFT 0..1 drops the cockpit below the screen (the intro raises it); CAM_EASE: how fast the camera drifts to its lane
  let COCK = null, COCKN = null; function setVehicle(name) { COCKN = name && real('cockpit-' + name) ? name : null; COCK = COCKN ? look('cockpit-' + COCKN, false, 0) : null; return COCKN; }
  const COCK_H = { scooter: 0.46, moto: 0.46, samokat: 0.42, bike: 0.44, car: 0.5, ship: 0.42 };   // the rig's height as a share of the screen height (the Vespa frame Kyrylo liked was 46%); the ship's bow is opaque to its top edge, so at 42% its tip stays under the horizon (52%) and the sea ahead shows over it (Kyrylo, 14 Oct: «boat need to be fixed ... pov»)
  let CK = null;   // where the cockpit went on the last frame (picture, rect): covers(x, y) tells the page a rider behind it is hidden, so its name tag hides too
  function drawCockpit(speed) { if (!COCK) { CK = null; return; } const ship = COCKN === 'ship', k = ship ? H * COCK_H.ship / COCK.height : Math.min(W / COCK.width, H * (COCK_H[COCKN] || 0.46) / COCK.height), src = ship ? shipWide(Math.max(0, Math.ceil((W / k - COCK.width) / 2) + 1)) : COCK, w = Math.round(src.width * k), h = Math.round(src.height * k), sp = Math.min(1.5, Math.abs(speed) / 12), bob = ship ? Math.round((1 - Math.cos(T.now * 1.7)) * sp) : Math.round(Math.sin(T.now * 11) * sp);   // the ship: its height alone sets the scale (never above the other rigs' size, Kyrylo, 14 Oct: the pixels were huge), the hull is carried on to both edges, and it pitches slowly, only down (no sea line under it)
    const m = minified(src.width, src.height, w, h); if (m) g.imageSmoothingEnabled = true; const x0 = Math.round((W - w) / 2), y0 = H - h + bob + Math.round(h * LIFT), rig = !ship && (RIG.tilt || RIG.scale !== 1); if (rig) { g.save(); g.translate(W / 2, H); g.rotate(RIG.tilt); g.scale(RIG.scale, RIG.scale); g.drawImage(src, x0 - W / 2, y0 - H, w, h); g.restore(); } else g.drawImage(src, x0, y0, w, h);   // nobody picks a ship up off the ground: the intro's tilt and scale skip it (they threw the deck off-centre and 1.3x too big)
    if (COCKN === 'car') { if (x0 > 0) g.drawImage(COCK, 0, 0, 1, COCK.height, 0, y0, x0, h); if (x0 + w < W) g.drawImage(COCK, COCK.width - 1, 0, 1, COCK.height, x0 + w, y0, W - x0 - w, h); }   // a dashboard runs on to both edges of a wide screen: its outer columns stretched sideways
    CK = rig ? null : { src, x0, y0, w, h, car: COCKN === 'car' }; if (m) g.imageSmoothingEnabled = false; }
  const alphaOf = c => c.__a || (c.__a = (() => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height); for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]; return a; })());
  function covers(x, y) { if (!CK || y < CK.y0 || y >= CK.y0 + CK.h) return false; const s = CK.src; if (x < CK.x0 || x >= CK.x0 + CK.w) return CK.car; const u = Math.floor((x - CK.x0) / CK.w * s.width), v = Math.floor((y - CK.y0) / CK.h * s.height); return alphaOf(s)[v * s.width + u] > 128; }
  // The ship's deck as wide as the screen (Kyrylo, 14 Oct: the bow was a picture pasted mid-sea, sea at both sides). The picture is a 2:1 bow; past its
  // edges each side goes on from its own outer column: the handrail and its posts keep falling outward (the bow widening towards you) and level off,
  // the deck and the hull under them are that column's colours moved down with the rail. Built once per width (pad = art pixels added per side).
  const WIDE = new Map();
  function shipWide(pad) { if (!pad) return COCK; const key = COCKN + pad; if (WIDE.has(key)) return WIDE.get(key); const a = COCK, cw = a.width, ch = a.height, c = canv(cw + 2 * pad, ch), x = c.getContext('2d'); x.drawImage(a, pad, 0);
    const sd = a.getContext('2d').getImageData(0, 0, cw, ch).data, out = x.getImageData(0, 0, c.width, ch), od = out.data, D = 64, PER = 12, RH = 13;   // D: art pixels outward until the rail is level; PER: post spacing; RH: handrail to deck (the posts' true height, the edge column's slanted rail reads taller)
    const at = (cx, y) => { const i = (y * cw + cx) * 4; return [sd[i], sd[i + 1], sd[i + 2], sd[i + 3]]; }, put = (X, y, p) => { if (y < 0 || y >= ch || !p || p[3] < 128) return; const i = (y * c.width + X) * 4; od[i] = p[0]; od[i + 1] = p[1]; od[i + 2] = p[2]; od[i + 3] = 255; };
    for (const side of [-1, 1]) { const ex = side < 0 ? 1 : cw - 2; let e0 = 0; while (e0 < ch && at(ex, e0)[3] < 128) e0++; if (e0 >= ch - 8) continue;   // e0: the handrail's top at the edge
      let dk = e0 + 4; while (dk < ch - 1) { const p = at(ex, dk); if (p[3] > 128 && p[0] + p[1] + p[2] > 600) break; dk++; }   // dk: the first deck row (the white planks) under the rail
      const rail = [0, 1, 2, 3].map(i => at(ex, Math.min(ch - 1, e0 + i))), post = [rail[1], rail[2], rail[3]], deck = r => { for (let i = 0; i < 16; i++) { const p = at(ex - side * i, r); if (p[3] >= 128) return p; } return null; };   // a gap in the outer column (a notch in the art's edge) takes the nearest pixel further in
      for (let d = 1; d <= pad; d++) { const X = side < 0 ? pad - d : pad + cw - 1 + d, sh = Math.round(d < D ? d - d * d / (2 * D) : D / 2), yd = dk + sh, yr = Math.max(e0 + sh, yd - RH);   // yd: the deck line here, yr: the handrail's top
        for (let i = 0; i < 4; i++) put(X, yr + i, rail[i]); if ((d + 4) % PER < 3) for (let y = yr + 4; y < yd; y++) put(X, y, post[(d + 4) % PER]);
        for (let y = yd; y < ch; y++) put(X, y, deck(Math.min(ch - 1, y - sh))); }
      for (let i = 0; i < 3; i++) { const X = side < 0 ? pad + i : pad + cw - 1 - i; for (let y = dk; y < ch; y++) if (od[(y * c.width + X) * 4 + 3] < 128) put(X, y, deck(y)); } }   // the art's own notch at its edge (2 px, under the rail) is filled too: it showed as a thin strip of sea at the seam (QA, 15 Oct)
    x.putImageData(out, 0, 0); WIDE.set(key, c); return c; }
  // ---- speed: the world shakes and the wind streaks past (the cockpit, drawn after, only bobs: the rider is in the shaking frame)
  function shake(speed) { const v = Math.abs(speed) * 3.6; if (v < 70) return; const a = Math.min(3, (v - 70) / 40) * (W / 320), jx = Math.round((Math.random() * 2 - 1) * a * 0.6), jy = Math.round((Math.random() * 2 - 1) * a), m = Math.ceil(a);
    if (!jx && !jy) return; g.drawImage(canvas, 0, 0, W, H, jx - m, jy - m, W + 2 * m, H + 2 * m); }   // the frame, nudged and zoomed by the nudge so no edge shows through
  function wind(speed) { const v = Math.abs(speed) * 3.6; if (v < 90) return; const n = Math.min(28, 4 + ((v - 90) / 4 | 0)), R = Math.hypot(W, H) * 0.5, cx = VIEW.cx, cy = VIEW.hzY, len = R * (0.08 + Math.min(0.2, (v - 90) / 500));
    g.save(); g.strokeStyle = TOD.dark > 0.5 ? 'rgba(220,230,255,0.35)' : 'rgba(255,255,255,0.5)'; g.lineWidth = 1; g.beginPath();
    for (let i = 0; i < n; i++) { const ang = ((i * 0.618034) % 1) * Math.PI * 2, u = (T.now * (1.2 + (i % 5) * 0.25) + i * 0.173) % 1, r0 = R * (0.15 + 0.75 * u), dx = Math.cos(ang), dy = Math.sin(ang) * 0.8;
      g.moveTo(cx + dx * r0, cy + dy * r0); g.lineTo(cx + dx * (r0 + len), cy + dy * (r0 + len)); }
    g.stroke(); g.restore(); }
  const drawBill = (proj, z, b) => { if (z < 2.5 || z > DRAW - 2) return; const q = proj[sliceAt(proj, z)].q; bill(proj, { z, occ: occAt(proj, z), q }, b, 0); };
  function render(s, speed) {
    const base = Math.min(N - 2, Math.floor(s / SEG)), frac = (s % SEG) / SEG, b = S(base), b1 = S(base + 1);
    const kerb = COCKN === 'samokat' || !COCKN;   // a kick scooter and a walker keep to the right: the middle of the sidewalk, or the road's edge where there is none
    const want = kerb ? (b.town && b.sw > 0.8 ? b.rw + 0.25 + b.sw * 0.5 : Math.max(0.8, b.rw - 0.7)) : b.lanes >= 2 || b.lanes === 1 && b.oneway ? laneOf(b, 1) : Math.min(b.rw * 0.5, 2.2 + (b.cls === 'mw' ? b.rw * 0.25 : 0));   // with OSM lanes: the right-hand lane of your direction
    CAMX += (DRIVE * want - CAMX) * CAM_EASE;   // drift smoothly into your place: the middle of your lane, or the kerb
    const camY = b.hs + (b1.hs - b.hs) * frac + CAM_H, proj = project(base, frac), hzY = Math.round(H * 0.52 + PITCH);   // the horizon a little below the middle: more street, less asphalt
    for (const p of proj) p.Y = hzY + (camY - p.q.hs) * p.sc; VIEW.hzY = hzY; VIEW.camY = camY; updateTOD(b);
    let occ = H; for (const p of proj) { p.occ = occ; if (p.Y < occ) occ = p.Y; }   // for each slice, the highest nearer crest
    STATS.pictures.clear(); LAMPS = TOD.dark > 0.15; if (LAMPS) lg.clearRect(0, 0, W, H); if (mg) mg.clearRect(0, 0, W, H);
    g.fillStyle = '#e6dcc4'; g.fillRect(0, 0, W, H);
    drawSky(hzY, b.hd); farHorizon(hzY, camY, b); drawGround(proj, s, hzY, Math.abs(speed)); nightGlow(hzY);
    // everything standing, sorted far to near and painted in that order (the painter's algorithm)
    const draws = [];
    for (let n = DRAW - 1; n > 0; n--) { const p = proj[n]; for (const bl of p.q.bill) { if (bl.zmax && p.z > bl.zmax) continue; draws.push({ z: p.z, f: () => bill(proj, p, bl, Math.abs(speed)) }); } }   // zmax: a field's far rows give way to its painted ground
    traffic(proj, s, draws, speed); for (const h of HOOKS.world) h(proj, s, draws);
    for (const pl of planesNear(s, -60, proj[DRAW - 1].z)) planeDraws(proj, pl, s, draws);
    draws.sort((a, c) => c.z - a.z); for (const d of draws) d.f();
    nightTint(); carLights(); for (const h of HOOKS.after) h(proj, s, speed); wind(speed); shake(speed); drawCockpit(speed);
    return b;
  }

  // ------------------------------------------------------------ the corner map: the chunk's own roads, water and land
  function drawLocalMap(cx2, s, size, span = 900, o = {}) {
    const q = S(Math.floor(s / SEG)), ch = CHUNKS.get(q.c); if (!ch || !ch.d || !ch.d.map) return; const m = ch.d.map, k = size / span, x0 = q.x, y0 = q.y, rot = q.hd - Math.PI / 2, hgt = o.h || size, dark = !!o.dark;
    cx2.save(); cx2.clearRect(0, 0, size, hgt); cx2.fillStyle = ch.d.sea ? (dark ? '#1d3550' : '#9cc3dc') : dark ? '#161b23' : '#e9e2cf'; cx2.fillRect(0, 0, size, hgt); cx2.translate(size / 2, hgt * 0.62); cx2.rotate(rot); cx2.scale(k, -k);   // heading up: after the y flip a heading hd points at hd − rot on screen, so rot = hd − 90° (it was 90° − hd: right only going due north or south, at sea off Odesa the route ran sideways out of the arrow, 2026-10-14); a chunk crossed by ship is open water (it has no map features)
    const path = pts => { cx2.beginPath(); pts.forEach(([x, y], i) => i ? cx2.lineTo(x - x0, y - y0) : cx2.moveTo(x - x0, y - y0)); };
    const AREA = dark ? { lot: '#242a33', water: '#1d3550', forest: '#1f3327', grass: '#243528', farm: '#2a2e27', pave: '#262b33', marsh: '#25332c', sand: '#3a3626', desert: '#3a3426', rock: '#2d2f33' }
      : { lot: '#c9c4bc', water: '#9cc3dc', forest: '#9cbf86', grass: '#bfd8a0', farm: '#e2dcae', pave: '#d8d2c4', marsh: '#c8d0a8', sand: '#efe0b4', desert: '#e8d4ac', rock: '#cfc6b8' };
    for (const [g2, pts] of m.areas) { if (!AREA[g2]) continue; cx2.fillStyle = AREA[g2]; path(pts); cx2.fill(); }
    cx2.lineCap = 'round'; cx2.lineJoin = 'round';
    for (const [k2, pts] of m.lines) { cx2.strokeStyle = k2 === 'rv' ? (dark ? '#2c5c80' : '#7fb0d0') : (dark ? '#4a4f58' : '#8a7f78'); cx2.lineWidth = (k2 === 'rv' ? 6 : 3) / k; path(pts); cx2.stroke(); }
    for (const [cls, pts] of m.roads) { cx2.strokeStyle = dark ? (cls === 'mw' ? '#c9a24a' : cls === 'pr' ? '#d3d6db' : cls === 'mi' ? '#9aa0a8' : '#5f656e') : (cls === 'mw' ? '#d9a050' : cls === 'pr' ? '#f4f0e6' : '#ffffff'); cx2.lineWidth = (cls === 'mw' || cls === 'pr' ? 4.5 : cls === 'mi' ? 3 : 1.8) / k; path(pts); cx2.stroke(); }
    { const st = ch.d.step || 10, near = ch.d.xy.map((p, i) => [p, i * st + ch.d.s0]).filter(([, m]) => Math.abs(m - s) < span), wet = m => IDX.sea.some(([a, b]) => m >= a && m <= b);   // the route: solid on land, dashed blue where the ship goes
      cx2.strokeStyle = dark ? '#b04df0' : '#d2453a'; cx2.lineWidth = (dark ? 4 : 3) / k; path(near.filter(([, m]) => !wet(m)).map(([p]) => p)); cx2.stroke();
      const sea = near.filter(([, m]) => wet(m)).map(([p]) => p); if (sea.length > 1) { cx2.setLineDash([12 / k, 8 / k]); cx2.strokeStyle = dark ? '#8fd0ff' : '#1f5f93'; path(sea); cx2.stroke(); cx2.setLineDash([]); } }
    // live or typical jams, over the route like a traffic layer (o.jams: [{ ll: [[lon, lat], …], level 1..5 }]) in this chunk's metres, drawn over the roads like a traffic layer
    if (o.jams && o.jams.length && ch.d.origin) { const [lon0, lat0] = ch.d.origin, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540, JC = { 1: '#e8c84a', 2: '#e8c84a', 3: '#f08a2c', 4: '#e0342a', 5: '#b3140e' };
      cx2.lineWidth = 7 / k; cx2.lineCap = 'round'; for (const j of o.jams) { const pts = j.ll.map(([lo, la]) => [(lo - lon0) * KX, (la - lat0) * KY]); cx2.strokeStyle = JC[Math.max(1, Math.min(5, j.level | 0))]; path(pts.map(([x, y]) => [x, y])); cx2.stroke(); } }
    // landmark markers (o.marks: landmarks with s and side) in this chunk: a gold dot with a dark ring
    if (o.marks) { const xy = ch.d.xy, st = ch.d.step || 10; for (const lm of o.marks) { if (Math.abs(lm.s - s) > span) continue; const i = Math.round((lm.s - ch.d.s0) / st); if (i < 1 || i >= xy.length - 1) continue;
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i + 1], L = Math.hypot(bx - ax, by - ay) || 1, rx = (by - ay) / L, ry = -(bx - ax) / L, px = xy[i][0] + rx * lm.side - x0, py = xy[i][1] + ry * lm.side - y0;
      cx2.beginPath(); cx2.arc(px, py, 6 / k, 0, Math.PI * 2); cx2.fillStyle = '#1b1b1f'; cx2.fill(); cx2.beginPath(); cx2.arc(px, py, 4 / k, 0, Math.PI * 2); cx2.fillStyle = lm.art ? '#ffd23f' : '#e0b84a'; cx2.fill(); } }
    // other riders (o.dots: {s, side, col}): a coloured dot with a white ring
    if (o.dots) { const xy = ch.d.xy, st = ch.d.step || 10; for (const d of o.dots) { if (Math.abs(d.s - s) > span) continue; const i = Math.round((d.s - ch.d.s0) / st); if (i < 1 || i >= xy.length - 1) continue;
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i + 1], L = Math.hypot(bx - ax, by - ay) || 1, rx = (by - ay) / L, ry = -(bx - ax) / L, px = xy[i][0] + rx * (d.side || 0) - x0, py = xy[i][1] + ry * (d.side || 0) - y0;
      cx2.beginPath(); cx2.arc(px, py, 7 / k, 0, Math.PI * 2); cx2.fillStyle = '#ffffff'; cx2.fill(); cx2.beginPath(); cx2.arc(px, py, 5 / k, 0, Math.PI * 2); cx2.fillStyle = d.col || '#5ad1ff'; cx2.fill(); } }
    cx2.restore();
    if (dark) { cx2.lineJoin = 'round'; cx2.beginPath(); cx2.moveTo(size / 2, hgt * 0.62 - 9); cx2.lineTo(size / 2 + 6, hgt * 0.62 + 6); cx2.lineTo(size / 2, hgt * 0.62 + 3); cx2.lineTo(size / 2 - 6, hgt * 0.62 + 6); cx2.closePath(); cx2.fillStyle = '#ffffff'; cx2.fill(); cx2.strokeStyle = '#111'; cx2.lineWidth = 1.5; cx2.stroke(); }
    else { cx2.fillStyle = '#1c1c22'; cx2.beginPath(); cx2.moveTo(size / 2, hgt * 0.62 - 6); cx2.lineTo(size / 2 + 4, hgt * 0.62 + 4); cx2.lineTo(size / 2 - 4, hgt * 0.62 + 4); cx2.fill(); }
  }

  // ------------------------------------------------------------ the API for the page, tests and the self-check
  // where you are: the last named place passed (or the start), the town or city around it
  const FROM = IDX.from.split(',')[0], TO = IDX.to.split(',')[0];
  const placeAt = s => { let here = FROM; for (const [at, name] of IDX.places) { if (at <= s + 300) here = name; else break; } if (s > LEN - 500) here = TO;
    const cityOf = n => { const p = n.split(',').map(x => x.trim()); return p.length >= 3 ? p[1] : p[0]; };   // 'Хрещатик, Київ, Україна' names the city, not the street
    const towns = [[0, cityOf(IDX.from || FROM)], [LEN, cityOf(IDX.to || TO)], ...IDX.places.filter(p => p[2] >= 2).map(p => [p[0], p[1]])]; let area = towns[0]; for (const t of towns) if (Math.abs(t[0] - s) < Math.abs(area[0] - s)) area = t;
    return { here, area: area[1] !== here ? area[1] : null }; };
  return {
    W, H, IDX, KITJ, LEN, LMS, T, CHECK, setLook: deg => { VIEW.cx = W / 2 + Math.tan(deg * Math.PI / 180) * FOCAL; },
    streamAround, ready, render, drawLocalMap, placeAt, roadAt: s => S(Math.floor(s / SEG)),
    stats: () => ({ pictures: Object.fromEntries(STATS.pictures), visible: STATS.pictures.size }),
    mask: () => MASK, audit: () => audit([...CHUNKS.values()].filter(c => c.segs)),
    chunks: CHUNKS,
    hooks: HOOKS, setTime, tod: TOD, cars: () => CARS.slice(), pushBill: (proj, draws, z, b) => { if (z < 2.5 || z > DRAW - 2) return; const q = proj[sliceAt(proj, z)].q; if (!q) return; draws.push({ z: z - 0.015, f: () => bill(proj, { z, occ: occAt(proj, z), q }, b, 0) }); }, laneAt: z => { const q = sliceAt.__proj && sliceAt.__proj[sliceAt(sliceAt.__proj, z)]?.q; return DRIVE * laneOf(q, 1); }, setVehicle, vehicle: () => COCKN, setJam: j => { JAM = j && j.v >= 0 ? { v: j.v } : null; }, covers, setLift: v => { LIFT = Math.max(0, Math.min(1, v)); }, setRig: o => { RIG.tilt = o.tilt || 0; RIG.scale = o.scale || 1; }, setCamH: v => { CAM_H = v; }, setPitch: px => { PITCH = px; }, setCamEase: k => { CAM_EASE = k; }, kit: () => KITJ, drawBill, ctx: g, VIEW, FOCAL, DRAW, DRIVE, real, look: n => look(n, false, 0), projectWorld, sliceAt, cockpits: () => ['scooter', 'moto', 'samokat', 'bike'].filter(v => real('cockpit-' + v)),
  };
}

// ============================================================ THE BOAT (Ukraine branch)
// Another rider on a sea stretch, seen from behind (Kyrylo, 14 Oct: the name tag floated over the bow with nobody under it): a small white motor
// boat, stern on, a dark rear window, a blue stripe, the outboard, a little flag and foam at the water line. ~boat sits on the water like any picture.
function boatArt() {
  const w = 40, h = 30, c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), id = x.createImageData(w, h), d = id.data;
  const px = (X, Y, col) => { if (X < 0 || Y < 0 || X >= w || Y >= h) return; const i = (Y * w + X) * 4; d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; }, box = (x0, y0, x1, y1, col) => { for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) px(X, Y, col); };
  box(30, 0, 30, 11, [150, 150, 156]); box(31, 1, 37, 3, [38, 98, 196]); box(31, 4, 37, 6, [250, 208, 40]);   // the flag
  box(9, 8, 29, 8, [196, 198, 200]); box(9, 9, 29, 17, [234, 234, 228]); box(12, 10, 26, 14, [44, 62, 86]); box(13, 10, 17, 10, [120, 150, 180]); box(27, 9, 29, 17, [204, 204, 198]);   // the cabin: roof, walls, the rear window with a glint, the shaded side
  for (let Y = 17; Y <= 25; Y++) { const n = Math.round((Y - 17) / 2), x0 = 2 + n, x1 = 37 - n; box(x0, Y, x1, Y, Y === 20 || Y === 21 ? [30, 80, 150] : Y > 21 ? [198, 202, 208] : [244, 244, 240]); box(x1 - 3, Y, x1, Y, Y === 20 || Y === 21 ? [22, 60, 116] : [176, 180, 188]); }   // the hull: white, a blue stripe, grey below, the right side in shade
  box(18, 23, 22, 27, [62, 62, 68]); box(19, 23, 21, 24, [96, 96, 104]);   // the outboard
  const o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = d[i * 4 + 3]; for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) if (!o[Y * w + X] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => o[(Y + b) * w + X + a] && X + a >= 0 && X + a < w && Y + b >= 0 && Y + b < h)) px(X, Y, [20, 24, 32]);   // a dark outline round the silhouette
  for (let Y = 27; Y < h; Y++) for (let X = 3; X < w - 3; X++) if (((X * 7 + Y * 13) % 5) < 2 + (Y === 27 ? 2 : 0)) px(X, Y, Y === 27 ? [226, 238, 246] : [176, 204, 226]);   // foam where it meets the water
  x.putImageData(id, 0, 0); c.hm = 2.6; c.avg = [200, 204, 210]; return { '~boat': c };
}

// ============================================================ SUNFLOWERS (Ukraine branch)
// The plants of the sunflower fields, drawn by code once at start-up as small pixel-art pictures (crisp, free, and the
// same on every device): ~sun1-4 a patch of about a dozen plants in two ranks, heads facing the road; ~sun5-6 one tall
// plant for the field's ragged edge. Light comes from the upper left, as in the kit's art.
function sunflowerArt() {
  const out = {}, PET = [[255, 224, 76], [246, 190, 36], [214, 138, 22]], CEN = [[132, 88, 40], [92, 58, 26], [56, 34, 16]], LEAF = [[118, 168, 64], [76, 130, 44], [46, 88, 30], [30, 62, 24]], STEM = [62, 104, 36];
  const make = (name, w, h, hm, seed, paint) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), id = x.createImageData(w, h), d = id.data;
    let st = seed * 2654435761 >>> 0; const rnd = () => { st = (Math.imul(st ^ (st >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return (st >>> 8) / 16777216; };
    const px = (X, Y, col, k = 1) => { X = Math.round(X); Y = Math.round(Y); if (X < 0 || Y < 0 || X >= w || Y >= h) return; const i = (Y * w + X) * 4; d[i] = col[0] * k; d[i + 1] = col[1] * k; d[i + 2] = col[2] * k; d[i + 3] = 255; };
    const leaf = (x0, y0, dir, len, k) => { for (let i = 1; i <= len; i++) { const droop = i > len - 2 ? 1 : 0, th = i === 1 || i === len ? 0 : 1; for (let j = -th; j <= th; j++) px(x0 + dir * i, y0 + j + droop, LEAF[j < 0 ? 0 : j > 0 ? 2 : 1], k); } };
    const head = (cx, cy, r, k, tip) => { for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) { const e = Math.hypot(dx, dy * 1.1); if (e > r + 0.35) continue;
        if (e > r - 0.6 && ((dx * 3 + dy * 5 + tip) & 1)) continue;   // ragged petal tips
        if (e <= r * 0.5 + 0.25) { const dot = ((dx * 3 + dy * 5 + 8) & 3) === 0; px(cx + dx, cy + dy, dot ? CEN[2] : dx + dy < -1 ? CEN[0] : CEN[1], k); continue; }
        px(cx + dx, cy + dy, PET[dx + dy < -r * 0.5 ? 0 : dx + dy > r * 0.6 ? 2 : 1], k); } };
    const plant = (x0, cy, r, k, bottom) => { for (let y = cy + r - 1; y < bottom; y++) px(x0, y, STEM, k); const n = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) leaf(x0, cy + r + 2 + i * 4 + Math.floor(rnd() * 2), (i + Math.floor(rnd() * 2)) & 1 ? 1 : -1, 3 + Math.floor(rnd() * 3), k); head(x0, cy, r, k, Math.floor(rnd() * 2)); };
    const foliage = (y0, k) => { for (let y = y0; y < h; y++) for (let X = 0; X < w; X++) { const t = (y - y0) / (h - y0), q = rnd(); if (q > 0.35 + t * 0.9) continue; px(X, y, LEAF[t > 0.86 ? 3 : q < 0.18 && t < 0.5 ? 0 : q < 0.62 ? 1 : 2], k); } };
    paint({ plant, foliage, rnd, w, h });
    x.putImageData(id, 0, 0); let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    c.hm = hm; c.avg = [r / n | 0, gg / n | 0, b / n | 0]; out[name] = c;
  };
  for (let v = 0; v < 4; v++) make('~sun' + (v + 1), 48, 34, 1.55, 11 + v * 7, ({ plant, foliage, rnd, w, h }) => {
    for (let i = 0; i < 6; i++) plant(Math.min(w - 4, 3 + i * 8 + Math.floor(rnd() * 3)), 5 + Math.floor(rnd() * 4), 4, 0.84, h);   // the rank behind: smaller heads, in shade
    foliage(h - 10, 0.86);
    for (let i = 0; i < 6; i++) plant(Math.min(w - 5, 7 + i * 8 + Math.floor(rnd() * 3) - 1), 12 + Math.floor(rnd() * 4), 5, 1, h);
    foliage(h - 7, 1); });
  for (let v = 0; v < 2; v++) make('~sun' + (v + 5), 16, 44, 2.0, 41 + v * 5, ({ plant, foliage, rnd, h }) => { plant(8 + (v ? -1 : 0), 6, 5, 1, h); plant(v ? 12 : 3, 16, 3, 0.86, h); foliage(h - 6, 1); });
  return out;
}
