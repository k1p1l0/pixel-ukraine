#!/usr/bin/env node
// Checks finished pictures in a trip before they go into the game (free, no network). CI runs it on every pull request
// that changes art (.github/workflows/art-check.yml); run it yourself before you open one.
//   node scripts/art-check.mjs --trip trips/ukraine-loop [--only NAME,NAME] [--cards] [--report] [--json FILE]
// Every picture of the kit (art/kit.json, dropped ones skipped), or only the names after --only, must be:
//   rgba     an 8-bit RGBA PNG (colour type 6)
//   alpha    every pixel fully clear or fully opaque (alpha 0 or 255): no soft edges
//   size     no bigger than its job in art/plan.json (width x height); a picture with no plan job is not size-checked
//   colours  at most 48 different colours in its opaque pixels
//   bytes    at most 16 KB on disk
//   flat     no single colour covers more than 80% of the opaque pixels (a picture that is mostly one fill)
//   empty    at least one opaque pixel
//   and none of the clean.mjs flags that make the game drop a picture (art-checks.mjs): boxed (a sprite with its painted
//   background), sky (a facade or landmark with painted sky across its top), narrow (a facade under 40% of its plan width).
//   'ground?' (a sprite on its own patch of ground) is printed as a warning only. A kit entry with "keep": true (looked at and
//   approved by a maintainer) skips boxed, sky and narrow, as clean.mjs does.
// --cards checks the city cards in art/cards.json too (all but the size rule; a card, an opaque square, may be 8-bit RGB). --report prints everything and exits 0;
// without it the exit code is 1 when any picture fails.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, readJSON, decodePNG } from './lib.mjs';
import { outlineOpaque, skyTop, groundPatch } from './art-checks.mjs';

const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node scripts/art-check.mjs --trip TRIP [--only NAME,NAME] [--cards] [--report] [--json FILE]'); process.exit(2); }
const MAX_COLOURS = 48, MAX_BYTES = 16 * 1024, MAX_SHARE = 0.8;
const kit = readJSON(join(TRIP, 'art/kit.json')); if (!kit) { console.error(`no ${join(TRIP, 'art/kit.json')}`); process.exit(2); }
const plan = readJSON(join(TRIP, 'art/plan.json'), { jobs: [] }), jobs = new Map(plan.jobs.map(j => [j.name, j]));
const only = typeof A.only === 'string' ? new Set(A.only.split(',').map(s => s.trim()).filter(Boolean)) : null;

function check(file, job, kind, keep = false) {
  const fails = [], warns = [];
  if (!existsSync(file)) return { fails: ['missing file'], warns };
  const buf = readFileSync(file), bytes = statSync(file).size;
  if (buf.length < 33 || buf.readUInt32BE(12) !== 0x49484452) return { fails: ['not a PNG'], warns };
  const depth = buf[24], ctype = buf[25];
  if (depth !== 8 || !(ctype === 6 || kind === 'card' && ctype === 2)) fails.push(`rgba: colour type ${ctype}, ${depth}-bit (want 8-bit RGBA, type 6${kind === 'card' ? ', or 8-bit RGB, type 2' : ''})`);   // a city card is an opaque square: RGB is fine
  if (bytes > MAX_BYTES) fails.push(`bytes: ${(bytes / 1024).toFixed(1)} KB (max 16 KB)`);
  let img; try { img = decodePNG(buf); } catch (e) { fails.push(`decode: ${e.message}`); return { fails, warns }; }
  const { width: W, height: H, data: d } = img;
  if (job && (W > job.width || H > job.height)) fails.push(`size: ${W}x${H}, plan ${job.width}x${job.height}`);
  let soft = 0, opaque = 0; const cols = new Map();
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a !== 0 && a !== 255) soft++; if (a === 255) { opaque++; const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; cols.set(k, (cols.get(k) || 0) + 1); } }
  if (soft) fails.push(`alpha: ${soft} pixels neither clear nor opaque`);
  if (!opaque) { fails.push('empty'); return { fails, warns, W, H, bytes, colours: 0 }; }
  if (cols.size > MAX_COLOURS) fails.push(`colours: ${cols.size} (max ${MAX_COLOURS})`);
  const top = Math.max(...cols.values()) / opaque; if (top > MAX_SHARE) fails.push(`flat: one colour is ${(top * 100).toFixed(0)}% of the picture (max 80%)`);
  if (!keep && kind === 'sprite' && outlineOpaque(img) > 0.55) fails.push('boxed (clean.mjs): a painted background around the sprite');
  if (!keep && (kind === 'facade' || kind === 'landmark') && skyTop(img) > 0.35) fails.push('sky (clean.mjs): painted sky across the top');
  if (!keep && kind === 'facade' && job && W < job.width * 0.4) fails.push(`narrow (clean.mjs): ${W} px wide, under 40% of the plan's ${job.width}`);
  if (kind === 'sprite' && groundPatch(img)) warns.push('ground? (clean.mjs): it may stand on its own patch of ground');
  return { fails, warns, W, H, bytes, colours: cols.size };
}

const rows = [];
for (const [name, p] of Object.entries(kit.pictures)) {
  if (only && !only.has(name)) continue; if (p.drop) { if (only) rows.push({ name, skip: 'dropped in kit.json' }); continue; }
  rows.push({ name, file: p.file, ...check(join(TRIP, p.file), jobs.get(name), p.kind, !!p.keep) });
}
if (A.cards) { const cards = readJSON(join(TRIP, 'art/cards.json'), {}); for (const f of new Set(Object.values(cards))) { const name = 'card:' + f; if (only && !only.has(name) && !only.has(f)) continue; rows.push({ name, file: 'art/' + f, ...check(join(TRIP, 'art', f), null, 'card') }); } }
if (only) for (const n of only) if (!rows.some(r => r.name === n || r.file === 'art/' + n)) rows.push({ name: n, fails: ['not in art/kit.json'], warns: [] });

let bad = 0, warned = 0; const why = {};
for (const r of rows) { if (r.skip) { console.log(`skip  ${r.name}: ${r.skip}`); continue; }
  if (r.fails.length) { bad++; for (const f of r.fails) { const k = f.split(/[ :(]/)[0]; why[k] = (why[k] || 0) + 1; } }
  if (r.warns.length) warned++;
  const s = r.fails.length ? 'FAIL' : r.warns.length ? 'warn' : 'ok  ';
  if (r.fails.length || r.warns.length || A.verbose) console.log(`${s}  ${r.name}${r.W ? ` (${r.W}x${r.H}, ${r.colours} colours, ${(r.bytes / 1024).toFixed(1)} KB)` : ''}${[...r.fails, ...r.warns].map(x => '\n      ' + x).join('')}`); }
const checked = rows.filter(r => !r.skip).length;
console.log(`\n${checked} pictures checked: ${checked - bad} pass, ${bad} fail, ${warned} with warnings.${bad ? ' Failures by rule: ' + Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ') + '.' : ''}`);
if (typeof A.json === 'string') writeFileSync(A.json, JSON.stringify({ checked, pass: checked - bad, fail: bad, warned, byRule: why, rows }, null, 1));
process.exit(bad && !A.report ? 1 : 0);
