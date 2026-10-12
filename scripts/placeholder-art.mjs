// Free art: a code-drawn stand-in for every picture in the plan, so the whole trip works before (or without)
// spending anything. Real pictures, once cleaned, replace these one by one (clean.mjs never lets a placeholder
// overwrite real art). The stand-ins are simple but in proportion, so the street reads as a street.
//   node placeholder-art.mjs --trip TRIP [--force]
import { join } from 'node:path';
import { args, readJSON, writeJSON, writePNG } from './lib.mjs';

const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node placeholder-art.mjs --trip TRIP'); process.exit(1); }
const ART = join(TRIP, 'art'), plan = readJSON(join(ART, 'plan.json'));
if (!plan) { console.error('no art/plan.json: run plan-art.mjs first (any --detail; placeholders cost nothing)'); process.exit(1); }
const kit = readJSON(join(ART, 'kit.json'), { themes: plan.themes, pictures: {} }); kit.themes = plan.themes; kit.landmarks = plan.landmarks || {}; kit.detail = plan.detail;

function canvas(w, h) {
  const data = new Uint8Array(w * h * 4), put = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
  return { width: w, height: h, data, put,
    rect(x, y, rw, rh, c) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) put(x + i, y + j, c); },
    oval(cx, cy, rx, ry, c) { for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) put(cx + x, cy + y, c); },
    tri(x0, x1, yb, xt, yt, c) { for (let y = yt; y <= yb; y++) { const k = (y - yt) / Math.max(1, yb - yt), a = xt + (x0 - xt) * k, b = xt + (x1 - xt) * k; for (let x = Math.round(a); x <= Math.round(b); x++) put(x, y, c); } } };
}
const shade = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
const H = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
const WALLS = [[214, 196, 160], [196, 120, 92], [232, 226, 210], [176, 160, 140], [160, 176, 186], [222, 204, 150], [150, 92, 72]];
const ROOFS = [[110, 70, 60], [70, 72, 84], [120, 84, 60], [92, 96, 104]];
function win(g, x, y, w, h, frame, glass) { g.rect(x - 1, y - 1, w + 2, h + 2, frame); g.rect(x, y, w, h, glass); g.rect(x, y + Math.floor(h / 2), w, 1, frame); }
function windows(g, x0, y0, x1, y1, cw, ch, gx, gy, frame, glass) { for (let y = y0; y + ch <= y1; y += ch + gy) for (let x = x0; x + cw <= x1; x += cw + gx) win(g, x, y, cw, ch, frame, glass); }

function draw(j) {
  const w = j.width, h = j.height, g = canvas(w, h), r = H(j.name), wall = WALLS[r % WALLS.length], roof = ROOFS[(r >>> 3) % ROOFS.length], glass = [72, 98, 122], frame = shade(wall, 0.62), dark = [52, 44, 40];
  switch (j.role) {
    case 'house': g.tri(6, w - 7, 46, w / 2, 10, roof); g.rect(16, 46, w - 32, h - 50, wall); g.rect(16, 46, w - 32, 3, shade(wall, 0.8)); g.rect(w - 44, 14, 8, 22, shade(wall, 0.7)); windows(g, 26, 58, w - 26, h - 34, 16, 16, 20, 10, frame, glass); g.rect(w / 2 - 8, h - 34, 16, 30, dark); break;
    case 'terrace': g.rect(0, 22, w, h - 22, wall); g.rect(0, 14, w, 8, roof); g.rect(w - 30, 2, 12, 14, shade(wall, 0.75)); windows(g, 14, 34, w - 14, h - 40, 20, 24, 18, 14, frame, glass); g.rect(18, h - 38, 20, 38, dark); g.rect(14, h - 40, 28, 3, shade(wall, 0.7)); win(g, 56, h - 34, 50, 22, frame, glass); break;
    case 'shop': g.rect(0, 10, w, h - 10, wall); g.rect(0, 6, w, 6, shade(wall, 0.7)); windows(g, 14, 22, w - 14, h - 66, 22, 24, 20, 12, frame, glass); g.rect(0, h - 62, w, 12, [[170, 50, 44], [44, 90, 130], [40, 110, 70]][r % 3]); for (let x = 0; x < w; x += 12) g.rect(x, h - 50, 6, 6, [240, 236, 220]); win(g, 10, h - 40, w - 60, 34, dark, [96, 124, 140]); g.rect(w - 40, h - 42, 24, 42, dark); break;
    case 'apartment': g.rect(0, 8, w, h - 8, wall); g.rect(0, 4, w, 6, shade(wall, 0.7)); windows(g, 10, 18, w - 10, h - 30, 16, 20, 12, 10, frame, glass); g.rect(0, h - 28, w, 28, shade(wall, 0.82)); g.rect(w / 2 - 14, h - 26, 28, 26, dark); break;
    case 'tower': g.rect(6, 6, w - 12, h - 6, [124, 140, 156]); for (let y = 12; y < h - 20; y += 8) for (let x = 12; x < w - 12; x += 10) g.rect(x, y, 7, 5, [86, 112, 140]); g.rect(6, h - 22, w - 12, 22, [70, 80, 92]); break;
    case 'civic': g.rect(6, 40, w - 12, h - 40, [222, 214, 196]); g.tri(2, w - 3, 40, w / 2, 12, shade([222, 214, 196], 0.85)); for (let x = 20; x < w - 20; x += 24) g.rect(x, 56, 8, h - 70, [240, 236, 226]); g.rect(w / 2 - 12, h - 34, 24, 34, dark); g.rect(0, h - 6, w, 6, [180, 176, 166]); break;
    case 'church': g.rect(20, 80, w - 40, h - 80, [200, 190, 170]); g.tri(16, w - 17, 82, w / 2, 56, roof); g.rect(w / 2 - 16, 30, 32, h - 30, [210, 200, 182]); g.tri(w / 2 - 18, w / 2 + 18, 30, w / 2, 2, roof); g.oval(w / 2, 56, 8, 8, glass); g.rect(w / 2 - 8, h - 34, 16, 34, dark); break;
    case 'industrial': g.rect(4, 40, w - 8, h - 40, [168, 170, 172]); for (let x = 4; x < w - 36; x += 36) g.tri(x, x + 36, 40, x + 36, 18, [120, 124, 130]); g.rect(24, 64, 64, h - 64, [110, 112, 116]); windows(g, 110, 54, w - 16, 74, 14, 12, 8, 0, frame, glass); break;
    case 'farm': g.tri(8, w - 9, 44, w / 2, 8, [120, 50, 40]); g.rect(18, 44, w - 36, h - 44, [168, 54, 44]); g.rect(w / 2 - 22, h - 56, 44, 56, [236, 228, 214]); g.rect(w / 2 - 19, h - 53, 38, 53, [150, 46, 38]); break;
    case 'tree': { const f = [[66, 112, 58], [82, 120, 60], [58, 100, 66]][r % 3]; g.rect(w / 2 - 6, h * 0.55, 12, h * 0.45, [96, 70, 48]); for (const [dx, dy, rr, k] of [[0, -0.2, 0.34, 0.9], [-0.2, 0, 0.27, 0.85], [0.2, 0, 0.27, 0.95], [0, 0.07, 0.3, 1], [0.1, -0.08, 0.2, 1.15]]) g.oval(w / 2 + dx * w, h * 0.38 + dy * h, rr * w, rr * w * 1.05, shade(f, k)); break; }
    case 'bush': for (const [dx, rr, k] of [[-0.18, 0.26, 0.9], [0.18, 0.26, 1], [0, 0.32, 1.1]]) g.oval(w / 2 + dx * w, h * 0.6, rr * w, rr * h, shade([82, 128, 66], k)); break;
    case 'street': g.rect(10, h - 40, w - 20, 6, [110, 80, 56]); g.rect(10, h - 54, w - 20, 5, [110, 80, 56]); g.rect(14, h - 34, 4, 34, [50, 50, 54]); g.rect(w - 18, h - 34, 4, 34, [50, 50, 54]); break;
    case 'landmark': g.rect(w * 0.2, h * 0.35, w * 0.6, h * 0.65, [206, 196, 176]); g.tri(w * 0.15, w * 0.85, h * 0.36, w / 2, h * 0.1, shade([206, 196, 176], 0.8)); for (let x = w * 0.26; x < w * 0.74; x += 14) g.rect(x, h * 0.45, 6, h * 0.5, [232, 226, 212]); break;
    default: g.rect(4, 4, w - 8, h - 8, wall);
  }
  return g;
}
const inPlan = new Set(plan.jobs.map(j => j.name)); for (const k of Object.keys(kit.pictures)) if (!inPlan.has(k)) delete kit.pictures[k];   // a picture from an earlier plan is not part of this kit
let n = 0;
for (const j of plan.jobs) {
  if (kit.pictures[j.name] && !kit.pictures[j.name].placeholder && !A.force) continue;   // never replace real art
  const full = draw(j);
  let x0 = full.width, y0 = full.height, x1 = -1, y1 = -1, r = 0, g2 = 0, b = 0, c = 0; for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) { const i = (y * full.width + x) * 4; if (!full.data[i + 3]) continue; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); r += full.data[i]; g2 += full.data[i + 1]; b += full.data[i + 2]; c++; }
  const cx0 = x0, cx1 = x1, cy1 = y1, img = { width: cx1 - cx0 + 1, height: cy1 - y0 + 1, data: new Uint8Array((cx1 - cx0 + 1) * (cy1 - y0 + 1) * 4) };
  for (let y = 0; y < img.height; y++) img.data.set(full.data.subarray(((y0 + y) * full.width + cx0) * 4, ((y0 + y) * full.width + cx1 + 1) * 4), y * img.width * 4);
  writePNG(join(ART, j.name + '.png'), img);
  kit.pictures[j.name] = { file: `art/${j.name}.png`, role: j.role, theme: j.theme, kind: j.kind, w: img.width, h: img.height, hm: j.hm, avg: [r / c, g2 / c, b / c].map(Math.round), ...(j.label ? { label: j.label } : {}), placeholder: true, drop: false, flags: [] }; n++;
}
writeJSON(join(ART, 'kit.json'), kit, true);
console.log(`placeholder art: ${n} pictures (${plan.jobs.length - n} real ones kept); art/kit.json written`);
