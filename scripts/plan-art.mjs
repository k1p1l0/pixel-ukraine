// Step 3a: plan the art kit (free: writes prompts, spends nothing).
//   node plan-art.mjs --trip TRIP --detail sparse|moderate|detailed \
//     --theme "bath|0|Georgian Bath in Somerset, England: honey-coloured Bath stone terraces" \
//     --theme "bristol|14|Bristol, England: brick and painted Victorian terraces, harbourside warehouses" \
//     [--subject "bath:terrace=a Georgian Bath stone townhouse with sash windows|..."]
//     [--landmarks N] [--no-landmarks] [--style rd_pro__default] [--palette PATH|none]
// A theme is "id|starts at km|description of the region". One kit is drawn per theme; the viewer switches kit at
// that km. Subjects: "theme:role=first|second|third" gives each variant its own subject (better than reseeding).
// The levels are nested: the sparse kit is the first pictures of the moderate kit, which is the start of the
// detailed kit, with the same names, prompts and seeds. Moving up a level only pays for the new pictures.
// Writes TRIP/art/plan.json. Read it, improve the subjects if they are generic, then quote it with rd.mjs.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { args, multi, readJSON, writeJSON } from './lib.mjs';
import { STYLE, PRICE, RECIPE, FACADES, SPRITES, LANDMARK, LEVELS } from './kit.mjs';
import { rolesFor } from '../templates/layout.js';

const A = args(), TRIP = A.trip, detail = A.detail || 'moderate';
if (!TRIP || !LEVELS[detail]) { console.error('usage: node plan-art.mjs --trip TRIP --detail sparse|moderate|detailed --theme "id|km|description"'); process.exit(1); }
const IDX = readJSON(join(TRIP, 'data/index.json')); if (!IDX) throw Error('no data/index.json: run bake.mjs first');
const LMS = readJSON(join(TRIP, 'data/landmarks.json'), []);
let themes = multi('--theme').map(t => { const [id, km, ...d] = t.split('|'); return { id: id.trim().replace(/[^a-z0-9-]/gi, '').toLowerCase(), from: Math.round(+km * 1000) || 0, name: d.join('|').trim() }; });
if (!themes.length) { console.error('give at least one --theme "id|0|description of the region" (look at the places and land mix the bake printed)'); process.exit(1); }
themes.sort((a, b) => a.from - b.from); themes[0].from = 0;
const subjects = {}; for (const s of multi('--subject')) { const [k, ...v] = s.split('='); subjects[k.trim()] = v.join('=').split('|').map(x => x.trim()).filter(Boolean); }
const subj = (theme, role, i, fallback) => { const l = subjects[`${theme.id}:${role}`] || subjects[role]; return (l && l[i % l.length]) || fallback; };
const here = dirname(fileURLToPath(import.meta.url)), defPal = join(here, '../templates/palette.png'), palette = A.palette === 'none' ? null : A.palette || (existsSync(defPal) ? defPal : null);
const L = LEVELS[detail], style = A.style || STYLE;
const seedOf = name => parseInt(createHash('sha1').update(name).digest('hex').slice(0, 7), 16);
const job = (name, o) => ({ name, style, remove_bg: true, seed: seedOf(name), ...(palette ? { palette } : {}), ...o });

// what each theme's stretch is made of: frontage metres by facade role (from the bake), plus what the land use will fill
function roleShare(t, next) {
  const share = {}; const add = (r, m) => (share[r] = (share[r] || 0) + m);
  for (const c of (IDX.chunks || []).flatMap(c => c.perKm || [c])) { if (c.s0 < t.from || c.s0 >= next) continue; const dense = (c.land.pave || 0) > 30;
    for (const [type, m] of Object.entries(c.types || {})) add(rolesFor(type, type === 'commercial' || type === 'residential' ? (c.maxH > 30 ? 20 : 9) : 9, dense)[0], m);
    add('house', (c.land.lawn || 0) * 8); add('farm', (c.land.farm || 0) * 0.6); add('shop', (c.land.pave || 0) * 5); if (c.maxH > 40) add('tower', 120); }
  const tot = Object.values(share).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(share).filter(([r, m]) => FACADES[r] && m / tot >= 0.03).sort((a, b) => b[1] - a[1]).map(([r, m]) => [r, m / tot]);   // roles under 3% of the frontage are not worth a picture
}
// the level's facade budget, shared out by how much frontage each role covers (at least one each, at most six)
function allocate(ranked, total, maxRoles) {
  const roles = ranked.slice(0, maxRoles), n = roles.map(() => 1); let left = total - roles.length;
  while (left > 0) { let best = -1, bv = -1; roles.forEach(([, w], i) => { const v = w / n[i]; if (n[i] < 6 && v > bv) { bv = v; best = i; } }); if (best < 0) break; n[best]++; left--; }
  return roles.map(([r], i) => [r, n[i]]);
}
const jobs = [];
themes.forEach((t, ti) => {
  const next = themes[ti + 1]?.from ?? Infinity, ranked = roleShare(t, next);
  for (const r of ['house', 'terrace', 'shop']) if (ranked.length < 3 && !ranked.some(x => x[0] === r)) ranked.push([r, 0.01]);   // at least three kinds of building
  allocate(ranked, L.facades.reduce((a, b) => a + b, 0), L.maxFacadeRoles).forEach(([role, count]) => { const F = FACADES[role];
    for (let v = 0; v < count; v++) jobs.push(job(`${t.id}-${role}-${v + 1}`, { role, theme: t.id, kind: 'facade', width: F.w, height: F.h, hm: F.hm, prompt: RECIPE.facade(subj(t, role, v, F.subject.replace('{place}', t.name)) + (v && !(subjects[`${t.id}:${role}`] || subjects[role]) ? ', a different colour and design from the most common one' : '')) })); });
  for (const [role, n] of Object.entries(L.sprites)) for (let v = 0; v < n; v++) { const S = SPRITES[role]; jobs.push(job(`${t.id}-${role}-${v + 1}`, { role, theme: t.id, kind: 'sprite', width: S.w, height: S.h, hm: S.hm, prompt: RECIPE.sprite(subj(t, role, v, S.subject.replace('{place}', t.name) + (v ? ', a different kind from the first' : ''))) })); }
});
// landmarks: the best known near the road (Wikidata sitelinks), one picture each, placed at their real spot
const nLm = A['no-landmarks'] ? 0 : A.landmarks != null ? +A.landmarks : L.landmarks, lmMap = {};
const picked = []; for (const l of LMS) { if (picked.length >= nLm) break; if (Math.abs(l.side) >= 900 || l.links < 2 || (l.kind === 'bridge' && Math.abs(l.side) < 40)) continue;   // not the bridge you are driving over
  const nm = l.name.toLowerCase(); if (picked.some(o => Math.abs(o.s - l.s) < 120 && Math.sign(o.side) === Math.sign(l.side) || o.name.toLowerCase().includes(nm) || nm.includes(o.name.toLowerCase()))) continue;   // one picture per building, not one per Wikidata item in it
  picked.push(l); }
for (const lm of picked) {   // not the bridge you are driving over
  const t = [...themes].reverse().find(t2 => t2.from <= lm.s) || themes[0], size = ['tower', 'lighthouse', 'church', 'windmill', 'monument'].includes(lm.kind) ? LANDMARK.tall : ['bridge', 'stadium', 'station', 'castle'].includes(lm.kind) ? LANDMARK.wide : LANDMARK;
  const name = `lm-${lm.qid}`; lmMap[lm.qid] = name;
  jobs.push(job(name, { role: 'landmark', theme: t.id, kind: 'landmark', width: size.w, height: size.h, hm: lm.h, qid: lm.qid, label: lm.name, prompt: RECIPE.landmark(subj(t, name, 0, `${lm.name}${lm.desc ? ` (${lm.desc})` : ''} in ${t.name}`)) }));
}

const old = readJSON(join(TRIP, 'art/plan.json'));
writeJSON(join(TRIP, 'art/plan.json'), { detail, themes, landmarks: lmMap, jobs }, true);
const byKind = {}; for (const j of jobs) byKind[j.kind] = (byKind[j.kind] || 0) + 1;
console.log(`art/plan.json: ${detail} kit, ${jobs.length} pictures for ${themes.length} region${themes.length > 1 ? 's' : ''} (${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}), about $${(jobs.length * PRICE).toFixed(2)} at $${PRICE} each${old ? ' (replaced the previous plan; finished pictures are kept)' : ''}`);
for (const j of jobs) console.log(`  ${j.name.padEnd(22)} ${String(j.width).padStart(3)}x${j.height}  ${j.prompt.slice(0, 96)}...`);
if (!LMS.length && L.landmarks) console.log('No landmarks found near the road (none with a Wikidata id within 1.2 km).');
console.log(`Next: node placeholder-art.mjs --trip ${TRIP}   (free stand-ins), then node rd.mjs quote --trip ${TRIP}   (free)`);
