// Step 5: the self-check. Run it after every build and look at what it writes before calling the trip done.
//   node check.mjs --trip TRIP [--points 8 | --at 1.2,5,9.8] [--fix --budget USD] [--no-browser]
// Writes TRIP/check/report.json, TRIP/check/montage.png (every sample frame, labelled: LOOK AT IT) and
// TRIP/check/shot-*.png (each frame as the page shows it, with the HUD and maps).
//
// What it checks, and why (each is a way a fly-through can look wrong):
//   1. gaps      along every built-up side of the road, stretches with no building longer than 10 m in a city or
//                18 m in a town that no cross street, park, water, bridge or railway explains (the layout itself,
//                in Node, exactly as the viewer builds it)
//   2. repeats   a building the same picture as the one next door, or the same look (picture + mirror + tint)
//                again within 40 m on one side; and in each frame, any facade picture drawn three or more times
//   3. art       pictures dropped by clean.mjs (painted background, sky, cut off, empty), placeholders still standing
//                in for real art, and roles with a single picture over a long stretch
//   4. sky       in a special render (sky painted magenta, every building also drawn into a mask), magenta pixels
//                inside a building with building above them: the sky showing through a wall or a hole in the art
//   5. light     frames too dark or too flat to read (mean brightness under 40, or almost no contrast)
//   6. place     every frame has a place name in the HUD; frames with no building, sign or landmark in a town
// Frames need a headless Chromium through Playwright (npx playwright install chromium, or PLAYWRIGHT_MODULE=path).
// Without it the layout and art checks still run and say the frame checks were skipped.
// --fix: re-rolls dropped pictures within --budget (rd.mjs run --regen), cleans them and checks again (twice at most).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import { args, readJSON, writeJSON, decodePNG, writePNG, newImage, fillRect, drawText, blit } from './lib.mjs';
import { install, serve } from './viewer.mjs';

const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node check.mjs --trip TRIP [--points 8] [--fix --budget USD]'); process.exit(1); }
const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(TRIP, 'check'); mkdirSync(OUT, { recursive: true });
const { makeKit, buildChunk, audit } = await import(pathToFileURL(join(HERE, '../templates/layout.js')).href);

async function run() {
  install(TRIP); for (const f of readdirSync(OUT)) if (/^(shot-.*|worst-frames)\.png$/.test(f)) unlinkSync(join(OUT, f));   // no stale frames from an earlier run
  const IDX = readJSON(join(TRIP, 'data/index.json')), KITJ = readJSON(join(TRIP, 'art/kit.json'), { themes: [{ id: 'default', from: 0 }], pictures: {} }), LMS = readJSON(join(TRIP, 'data/landmarks.json'), []);
  for (const lm of LMS) { const a = KITJ.landmarks?.[lm.qid]; if (a && KITJ.pictures[a] && !KITJ.pictures[a].drop && !KITJ.pictures[a].placeholder) lm.art = a; }
  const kit = makeKit(KITJ), env = { idx: IDX, kit, landmarks: LMS }, chunks = [];
  for (let c = 0; c < IDX.count; c++) { const f = join(TRIP, `data/c${String(c).padStart(4, '0')}.json`); if (existsSync(f)) chunks.push(buildChunk(JSON.parse(readFileSync(f, 'utf8')), env)); }
  const R = { trip: TRIP, detail: KITJ.detail || null, at: new Date().toISOString(), problems: [], warnings: [] };
  // 1 + 2: the layout
  const au = audit(chunks); R.layout = { planes: au.planes, frontage_m: Math.round(au.frontage), gaps: au.gaps.length, repeats: au.repeats.length, distinctFacades: Object.keys(au.pictures).length };
  const gapM = au.gaps.reduce((s, g) => s + g.len, 0); R.layout.gap_m = gapM;
  if (au.gaps.length) (gapM > au.frontage * 0.02 ? R.problems : R.warnings).push(`${au.gaps.length} gaps in built-up frontage (${gapM} m, ${(gapM / Math.max(1, au.frontage) * 100).toFixed(1)}% of ${Math.round(au.frontage)} m), worst at ${au.gaps.sort((a, b) => b.len - a.len).slice(0, 4).map(g => `km ${(g.at / 1000).toFixed(2)} (${g.len} m ${g.side < 0 ? 'left' : 'right'}, ${g.land})`).join(', ')}`);
  const pic = au.repeats.filter(r => r.kind === 'picture'), lk = au.repeats.filter(r => r.kind === 'look');
  const small = KITJ.detail === 'sparse' || R.layout.distinctFacades < 6 * Math.max(1, (KITJ.themes || []).length);   // a sparse kit: one picture per role, so the same picture next door is expected (mirrored and tinted looks vary it)
  if (pic.length) (pic.length > au.planes * 0.02 && !small ? R.problems : R.warnings).push(`${pic.length} buildings are the same picture as the one next door (e.g. ${pic.slice(0, 3).map(r => `${r.pic} at km ${(r.at / 1000).toFixed(2)}`).join(', ')}): the kit has too few pictures for that role${small ? ' (expected at --detail sparse)' : ''}`);
  if (lk.length) (lk.length > au.planes * (small ? 0.2 : 0.03) ? R.problems : R.warnings).push(`${lk.length} identical looks (picture, mirror and tint) within 40 m on one side`);
  // 3: the art
  const P = KITJ.pictures, real = Object.values(P).filter(p => !p.placeholder), dropped = Object.entries(P).filter(([, p]) => p.drop).map(([n, p]) => `${n} (${p.flags.join(', ') || 'drop.txt'})`);
  R.art = { pictures: Object.keys(P).length, real: real.length, placeholders: Object.keys(P).length - real.length, dropped };
  const byHand = Object.entries(P).filter(([, p]) => p.drop && !(p.flags || []).length).map(([n]) => n); if (byHand.length) R.warnings.push(`${byHand.length} pictures left out by hand (art/drop.txt): ${byHand.join(', ')}; their roles use the other pictures`);
  dropped.splice(0, dropped.length, ...dropped.filter(x => !byHand.some(n => x.startsWith(n + ' '))));
  if (dropped.length) R.problems.push(`${dropped.length} pictures dropped by the cleanup: ${dropped.join('; ')}. Re-roll them: node rd.mjs run --trip ${TRIP} --budget <USD> --regen ${Object.entries(P).filter(([, p]) => p.drop).map(([n]) => n).join(',')}`);
  const ph = Object.entries(P).filter(([, p]) => p.placeholder && p.role !== 'landmark').map(([n]) => n), lmNo = Object.entries(P).filter(([, p]) => p.role === 'landmark' && (p.placeholder || p.drop)).map(([, p]) => p.label || p.qid);
  if (real.length && ph.length) R.warnings.push(`${ph.length} placeholders still stand in for real art: ${ph.slice(0, 12).join(', ')}`);
  if (lmNo.length) R.warnings.push(`${lmNo.length} landmarks have no usable picture, so only their brown sign shows: ${lmNo.join(', ')}`);
  for (const p of Object.entries(P).filter(([, p]) => !p.drop && p.flags?.includes('ground?'))) R.warnings.push(`${p[0]} may stand on its own painted ground: look at it in art/contact.png`);
  // 4-6: frames in a headless browser
  const pw = await findPlaywright();
  if (!pw || A['no-browser']) { R.frames = null; R.warnings.push(pw ? 'frame checks skipped (--no-browser)' : 'frame checks skipped: they need Node 20+ and Playwright with Chromium (npm i -D playwright && npx playwright install chromium, or set PLAYWRIGHT_MODULE)'); return R; }
  const pts = A.at ? String(A.at).split(',').map(Number) : (() => { const n = +(A.points || 8), out = []; for (let i = 0; i < n; i++) out.push(+((IDX.total * (0.03 + 0.94 * i / Math.max(1, n - 1))) / 1000).toFixed(2));
    for (const lm of LMS.filter(l => l.art).slice(0, 2)) out.push(+(Math.max(0, lm.s - 140) / 1000).toFixed(2)); return [...new Set(out)].sort((a, b) => a - b); })();
  const { srv, port } = await serve(TRIP, 0), browser = await pw.chromium.launch(), frames = [], sweepStats = { frames: 0, bad: 0, holes: 0, gapCols: 0 };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), chk = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message)); chk.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?paused=1&h=180`); await chk.goto(`http://127.0.0.1:${port}/?paused=1&check=1&h=180`);
    await page.waitForFunction(() => window.__trip, null, { timeout: 60000 }); await chk.waitForFunction(() => window.__trip, null, { timeout: 60000 });
    const shots = pts.map(km => ({ km }));
    for (const s of shots) { try {
      const info = await page.evaluate(async o => { const r = await window.__trip.goto(o.km); const c = document.getElementById('c'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data; let sum = 0, sq = 0, n = 0;
        for (let i = 0; i < d.length; i += 16) { const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; sum += l; sq += l * l; n++; } const mean = sum / n; return { ...r, mean, std: Math.sqrt(sq / n - mean * mean), png: c.toDataURL('image/png') }; }, s);
      const name = `shot-${String(s.km).replace('.', '_')}${s.tag ? '-' + s.tag : ''}.png`; await page.screenshot({ path: join(OUT, name) });
      let holes = null; if (!s.tag) holes = await chk.evaluate(async o => { await window.__trip.goto(o.km); const c = document.getElementById('c'), m = window.__trip.road.mask(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data, md = m.getContext('2d').getImageData(0, 0, W, H).data;
        const mag = i => d[i * 4] > 245 && d[i * 4 + 1] < 10 && d[i * 4 + 2] > 245, ins = i => md[i * 4 + 3] > 0; let n = 0, inside = 0;
        const hz = Math.round(H * 0.52) + 1;   // a pixel row of sky under buildings standing on the horizon is not a hole
        for (let x = 0; x < W; x++) { let wall = false; for (let y = 0; y < H; y++) { const i = y * W + x; if (!ins(i)) { wall = false; continue; } inside++; if (!mag(i)) wall = true; else if (wall && y > hz) n++; } }
        let png = null; if (n > 30) { const x = c.getContext('2d'); for (let xx = 0; xx < W; xx++) { let wall = false; for (let y = 0; y < H; y++) { const i = y * W + xx; if (!ins(i)) { wall = false; continue; } if (!mag(i)) wall = true; else if (wall && y > hz) { x.fillStyle = '#00ff00'; x.fillRect(xx, y, 1, 1); } } } png = c.toDataURL('image/png'); }   // where: the holes in green
        return { px: n, inside, png }; }, s);
      if (holes?.png) { writeFileSync(join(OUT, name.replace('.png', '-holes.png')), Buffer.from(holes.png.split(',')[1], 'base64')); delete holes.png; }
      const facades = Object.entries(info.stats.pictures).filter(([k]) => KITJ.pictures[k]?.kind === 'facade'), many = facades.filter(([, v]) => v >= 3);
      const f = { km: s.km, tag: s.tag || 'day', place: info.place, road: info.road, mean: Math.round(info.mean), std: Math.round(info.std), visible: info.stats.visible, facades: facades.length, holes, shot: name, png: info.png };
      if (holes && holes.px > 30) R.problems.push(`sky through buildings at km ${s.km}: ${holes.px} px`);
      if (f.mean < 40 || f.std < 10) R.problems.push(`frame at km ${s.km}${s.tag ? ' (' + s.tag + ')' : ''} too dark or flat to read (brightness ${f.mean}, contrast ${f.std})`);
      if (!f.place) R.problems.push(`no place name at km ${s.km}`);
      if (many.length && !small) R.warnings.push(`km ${s.km}: ${many.map(([k, v]) => `${k} x${v}`).join(', ')} in one frame`);
      frames.push(f);
    } catch (e) { R.problems.push(`the frame at km ${s.km} failed: ${e.message.split('\n')[0]}`); } }
    // THE SWEEP: every 75 m of built-up road, the camera moving, looking ahead and 30 degrees to each side. Each frame is
    // rendered with the sky magenta and every building also drawn into a mask, and two things are counted:
    //   holes  magenta inside a building with building above it (sky through a wall or a hole in the art)
    //   gaps   columns where the sky reaches down to the horizon right under a building, or through a slit between two
    //          tall stretches of street wall (a see-through gap, a card's edge, a missing side wall)
    const sweep = []; for (const ch of chunks) for (let k = 0; k < ch.segs.length; k += 37) { const q = ch.segs[k]; if (q.town && q.s > 60 && q.s < IDX.total - 60) sweep.push(q.s); }
    const step = Math.max(1, Math.ceil(sweep.length / +(A['sweep-max'] || 400))), at = sweep.filter((_, i) => i % step === 0), looks = [0, -30, 30], found = [];
    for (const s0 of at) for (const look of looks) { try {
      const r = await chk.evaluate(async o => { const T = window.__trip, road = T.road; await T.goto(Math.max(0, o.s - 24) / 1000); road.setLook(o.look); for (let i = 0; i < 4; i++) await T.step(6, 1 / 30);   // moving: 24 m in four frames
        const c = document.getElementById('c'), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data, md = road.mask().getContext('2d').getImageData(0, 0, W, H).data, hz = Math.round(H * 0.52);
        const mag = (x, y) => { const i = (y * W + x) * 4; return d[i] > 245 && d[i + 1] < 10 && d[i + 2] > 245; }, ins = (x, y) => md[(y * W + x) * 4 + 3] > 0, sideOf = (x, y) => md[(y * W + x) * 4] > 128 ? -1 : 1, wallAt = (x, y) => ins(x, y) && !mag(x, y);
        let holes = 0; const hx = [], gx = [];
        for (let x = 0; x < W; x++) { let wall = false; for (let y = 0; y < H; y++) { if (!ins(x, y)) { wall = false; continue; } if (!mag(x, y)) wall = true; else if (wall && y > hz + 1) { holes++; hx.push([x, y]); } } }
        const y0 = hz - 2, tall = x => { if (x < 0 || x >= W || !wallAt(x, y0)) return 0; let t = 0; for (let y = y0; y >= 0 && wallAt(x, y); y--) t++; return t >= 15 ? sideOf(x, y0) : 0; };
        for (let x = 0; x < W; x++) { if (!mag(x, y0)) continue; let above = false; for (let y = 0; y < y0 - 2; y++) if (wallAt(x, y)) { above = true; break; }
          let l = 0, r = 0; for (let k = 1; k <= 6; k++) { l ||= tall(x - k); r ||= tall(x + k); }
          if (above || (l && l === r)) gx.push(x); }   // a slit between two tall stretches of the SAME street wall (not the view down the street)
        let png = null; if (holes > 30 || gx.length >= 3) { const g = c.getContext('2d'); g.fillStyle = '#00ff00'; for (const [x, y] of hx) g.fillRect(x, y, 1, 1); g.fillStyle = '#ff2020'; for (const x of gx) g.fillRect(x, 0, 1, hz); png = c.toDataURL('image/png'); }
        road.setLook(0); return { holes, gaps: gx.length, png, place: road.placeAt(o.s).here }; }, { s: s0, look });
      if (r.png) found.push({ km: +(s0 / 1000).toFixed(3), look, holes: r.holes, gaps: r.gaps, place: r.place, png: r.png });
      sweepStats.frames++; sweepStats.holes += r.holes; sweepStats.gapCols += r.gaps; if (r.png) sweepStats.bad++;
    } catch (e) { R.problems.push(`sweep frame at km ${(s0 / 1000).toFixed(2)} failed: ${e.message.split('\n')[0]}`); } }
    // the worst frames, each shown as it really looks (normal render, same place, same look) above its marked check frame
    found.sort((a, b) => (b.holes + 8 * b.gaps) - (a.holes + 8 * a.gaps));
    for (const f of found.slice(0, 20)) { f.view = await page.evaluate(async o => { const T = window.__trip; await T.goto(Math.max(0, o.s - 24) / 1000); T.road.setLook(o.look); for (let i = 0; i < 4; i++) await T.step(6, 1 / 30); const u = document.getElementById('c').toDataURL('image/png'); T.road.setLook(0); return u; }, { s: f.km * 1000, look: f.look }); }
    R.sweep = { ...sweepStats, worst: found.slice(0, 20).map(({ png, view, ...f }) => f) };
    if (found.length) R.problems.push(`the sweep found ${found.length} of ${sweepStats.frames} frames with sky through or between buildings (worst: ${found.slice(0, 4).map(f => `km ${f.km} look ${f.look}: ${f.holes} px, ${f.gaps} columns`).join('; ')}); see check/worst-frames.png`);
    if (found.length) { const ims = found.slice(0, 20).flatMap(f => [decodePNG(Buffer.from(f.view.split(',')[1], 'base64')), decodePNG(Buffer.from(f.png.split(',')[1], 'base64'))]), fw = 320, fh = Math.round(fw * ims[0].height / ims[0].width), WS = newImage(4 * (fw + 6) + 6, Math.ceil(ims.length / 4) * (fh + 18) + 6, [18, 16, 22]);
      ims.forEach((im, i) => { const f = found[i >> 1], x = 6 + (i % 4) * (fw + 6), y = 6 + Math.floor(i / 4) * (fh + 18); blit(WS, im, x, y, fw, fh); drawText(WS, x, y + fh + 4, i & 1 ? `CHECK: ${f.holes} PX, ${f.gaps} COLS` : `KM ${f.km} LOOK ${f.look}`, i & 1 ? [240, 120, 110] : [220, 214, 200]); });
      writePNG(join(OUT, 'worst-frames.png'), WS); }
    if (errors.length) R.problems.push(`page errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
  } finally { await browser.close(); srv.close(); }
  // the montage: every frame at 2x with its label (km, place, brightness, holes)
  if (!frames.length) { R.frames = []; return R; }
  const fw = 640, ims = frames.map(f => decodePNG(Buffer.from(f.png.split(',')[1], 'base64'))), fh = Math.round(fw * ims[0].height / ims[0].width), cols = 2, M = newImage(cols * (fw + 8) + 8, Math.ceil(frames.length / cols) * (fh + 22) + 8, [18, 16, 22]);
  frames.forEach((f, i) => { const x = 8 + (i % cols) * (fw + 8), y = 8 + Math.floor(i / cols) * (fh + 22); blit(M, ims[i], x, y, fw, fh); drawText(M, x, y + fh + 5, `KM ${f.km} ${f.tag.toUpperCase()}  ${(f.place || '-').slice(0, 30)}  ${(f.road || '').slice(0, 30)}  L${f.mean}${f.holes ? ' HOLES ' + f.holes.px : ''}`, f.holes?.px > 30 ? [240, 110, 100] : [220, 214, 200], 2); });
  writePNG(join(OUT, 'montage.png'), M);
  R.frames = frames.map(({ png, ...f }) => f); return R;
}
async function findPlaywright() {
  if (+process.versions.node.split('.')[0] < 20) { console.log('frame checks need Node 20 or newer (Playwright does); this is Node ' + process.versions.node); return null; }
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', pathToFileURL(join(process.cwd(), 'node_modules/playwright/index.mjs')).href];
  try { tries.push(pathToFileURL(join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright/index.mjs')).href); } catch {}
  for (const t of tries.filter(Boolean)) { try { const m = await import(t.startsWith('/') ? pathToFileURL(t).href : t); const pw = m.chromium ? m : m.default; if (!pw?.chromium) continue; const b = await pw.chromium.launch(); await b.close(); return pw; } catch {} }
  return null;
}

let R = await run();
for (let round = 0; A.fix && round < 2 && R.art?.dropped.length; round++) {
  const names = Object.entries(readJSON(join(TRIP, 'art/kit.json')).pictures).filter(([, p]) => p.drop && !p.placeholder).map(([n]) => n);
  if (!A.budget) { console.log('--fix needs --budget USD (the trip total, as for rd.mjs run)'); break; }
  console.log(`re-rolling ${names.length} dropped pictures: ${names.join(', ')}`);
  const r = spawnSync(process.execPath, [join(HERE, 'rd.mjs'), 'run', '--trip', TRIP, '--budget', String(A.budget), '--regen', names.join(',')], { stdio: 'inherit' });
  spawnSync(process.execPath, [join(HERE, 'clean.mjs'), '--trip', TRIP, '--only', names.join(',')], { stdio: 'inherit' });
  R = await run(); if (r.status === 2) { R.warnings.push('the budget stopped the re-rolls: some pictures are still dropped (their roles use other pictures)'); break; }
}
writeJSON(join(OUT, 'report.json'), R, true);
console.log(`\nSELF-CHECK ${R.problems.length ? 'FOUND PROBLEMS' : 'PASSED'}: ${TRIP}`);
console.log(`layout: ${R.layout.planes} buildings over ${R.layout.frontage_m} m of frontage, ${R.layout.distinctFacades} different facade pictures, ${R.layout.gaps} gaps (${R.layout.gap_m} m), ${R.layout.repeats} repeats`);
console.log(`art: ${R.art.real} real pictures, ${R.art.placeholders} placeholders, ${R.art.dropped.length} dropped`);
if (R.sweep) console.log(`sweep: ${R.sweep.frames} moving frames (every 75 m of built-up road, looking ahead and 30 degrees to each side), ${R.sweep.bad} with sky through or between buildings`);
if (R.frames) console.log(`frames: ${R.frames.length} (${R.frames.map(f => `${f.km}${f.tag !== 'day' ? f.tag[0] : ''}:${f.place || '?'}`).join(', ')})`);
for (const p of R.problems) console.log('PROBLEM ' + p); for (const w of R.warnings) console.log('warning ' + w);
console.log(R.frames ? `Now look at ${join(OUT, 'montage.png')} and ${join(TRIP, 'art/contact.png')}: can you tell where you are? any gaps, sky through walls, repeats or broken pictures?` : `No frames were rendered, so nothing has been looked at yet: look at ${join(TRIP, 'art/contact.png')}, then open the page (viewer.mjs --serve) and check it by eye, or install Playwright and run this again.`);
process.exit(R.problems.length ? 1 : 0);
