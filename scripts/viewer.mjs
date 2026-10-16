// Step 4: put the viewer into the trip folder (and optionally serve it).
//   node viewer.mjs --trip TRIP [--serve 8080]
// The trip folder is then a static site: index.html, road.js, layout.js, fonts/, sfx/, data/, art/. Host it anywhere static
// files are served (not .cache/, art/raw/ or art/ledger.json).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from './lib.mjs';

export function install(TRIP) {
  if (!existsSync(join(TRIP, 'data/index.json'))) throw Error('no data/index.json: run bake.mjs first');
  if (!existsSync(join(TRIP, 'art/kit.json'))) console.warn('no art/kit.json yet: run plan-art.mjs and placeholder-art.mjs (free); the viewer will draw without pictures');
  const T = join(dirname(fileURLToPath(import.meta.url)), '../templates');
  const site = existsSync(join(TRIP, 'site.json')) ? JSON.parse(readFileSync(join(TRIP, 'site.json'), 'utf8')) : {};   // optional trip settings: "support": "https://…" puts a donation link on the start card and in the dock; "posthog": "phc_…" (and optional "posthog_host") turns on PostHog; "vote": true shows the city vote (it needs the Worker's /api/votes)
  const ph = typeof site.posthog === 'string' && /^ph[a-z]_[A-Za-z0-9]+$/.test(site.posthog) ? { key: site.posthog, host: /^https:\/\/[^\s"'<>]+$/.test(site.posthog_host || '') ? site.posthog_host.replace(/\/$/, '') : undefined } : {};   // PostHog only with a project key in site.json ({"posthog": "phc_…"}); no key, no analytics
  const { posthog, posthog_host, ...pub } = site, js = o => JSON.stringify(o).replace(/</g, '\\u003c');
  writeFileSync(join(TRIP, 'index.html'), readFileSync(join(T, 'viewer.html'), 'utf8').replace('/*PH*/{}/*/PH*/', () => js(ph)).replace('/*SITE*/{}/*/SITE*/', () => js(pub)).replace('/*VOTE*/false/*/VOTE*/', () => js(site.vote === true)).replace('/*SUP*/false/*/SUP*/', () => js(/^https:\/\//.test(site.support || '')))); copyFileSync(join(T, 'road.js'), join(TRIP, 'road.js')); copyFileSync(join(T, 'layout.js'), join(TRIP, 'layout.js'));
  mkdirSync(join(TRIP, 'fonts'), { recursive: true }); for (const f of readdirSync(join(T, 'fonts'))) copyFileSync(join(T, 'fonts', f), join(TRIP, 'fonts', f));   // the self-hosted fonts and their licence (OFL.txt)
  mkdirSync(join(TRIP, 'sfx'), { recursive: true }); for (const f of readdirSync(join(T, 'sfx'))) if (f.endsWith('.mp3')) copyFileSync(join(T, 'sfx', f), join(TRIP, 'sfx', f));   // the sound loops: engines, steps, wind, city and country
}
export function serve(TRIP, port = 0) {   // a tiny static server (any other static server works too); dot-folders stay private
  const root = resolve(TRIP), TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8' };
  const srv = createServer((req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, ''); let f = join(root, p || 'index.html');
    if (!f.startsWith(root) || /[/\\]\./.test(f.slice(root.length)) || /[/\\]raw[/\\]|ledger\.json$/.test(f.slice(root.length))) { res.writeHead(404); return res.end('not found'); }
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html'); if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(f));
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node viewer.mjs --trip TRIP [--serve PORT]'); process.exit(1); }
  install(TRIP); console.log(`viewer: ${join(TRIP, 'index.html')}`);
  if (A.serve) { const { port } = await serve(TRIP, A.serve === true ? 8080 : +A.serve); console.log(`open http://127.0.0.1:${port}/  (Ctrl+C to stop)`); }
}
