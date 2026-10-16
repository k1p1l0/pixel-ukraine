// The picture checks that clean.mjs runs on a cleaned, cropped picture, shared with art-check.mjs (which runs them on the
// finished pictures in a trip, for example in CI on a pull request). Each takes an RGBA image { width, height, data }.
//   outlineOpaque  share of the outline that is opaque: over 0.55 on a sprite = 'boxed' (it still has a painted background)
//   skyTop         share of the top rows that is one flat, light, cool fill: over 0.35 on a facade or landmark = 'sky'
//   groundPatch    true when a sprite stands on its own painted patch of ground ('ground?', a warning)
export function outlineOpaque({ width: W, height: H, data: d }) { let n = 0, o = 0; const a = (x, y) => d[(y * W + x) * 4 + 3] > 40; for (let x = 0; x < W; x++) { n += 2; o += a(x, 0) + a(x, H - 1); } for (let y = 0; y < H; y++) { n += 2; o += a(0, y) + a(W - 1, y); } return o / n; }
export function skyTop(img) {   // painted sky: one flat sky-coloured fill across the top of the picture (a glass tower has its window grid instead)
  const { width: W, data: d } = img, rows = Math.max(2, Math.round(img.height * 0.08)), cnt = new Map();
  for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (d[i + 3] < 128) continue; const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); cnt.set(k, (cnt.get(k) || 0) + 1); }
  let sky = 0; for (const [k, v] of cnt) { const [r, g, b] = k.split(',').map(x => x * 8 + 4), share = v / (W * rows); if (share > 0.1 && 0.3 * r + 0.59 * g + 0.11 * b > 150 && b >= r - 10) sky += share; }   // flat, light and cool: sky, not a warm cornice
  return sky; }
export function groundPatch(img) { const { width: W, height: H, data: d } = img, wid = y => { let a = W, b = -1; for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { a = Math.min(a, x); b = Math.max(b, x); } return b - a + 1; };
  const ws = []; for (let y = Math.round(H * 0.3); y < Math.round(H * 0.85); y++) ws.push(wid(y)); ws.sort((a, b) => a - b); const med = ws[ws.length >> 1] || 1; let bottom = 0; for (let y = Math.round(H * 0.92); y < H; y++) bottom = Math.max(bottom, wid(y)); return bottom > med * 1.8 && bottom > W * 0.75; }
