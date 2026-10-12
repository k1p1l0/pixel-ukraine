// Step 4: put the viewer into the trip folder (and optionally serve it).
//   node viewer.mjs --trip TRIP [--serve 8080]
// The trip folder is then a static site: index.html, road.js, layout.js, data/, art/. Host it anywhere static
// files are served (not .cache/, art/raw/ or art/ledger.json).
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from './lib.mjs';

export function install(TRIP) {
  if (!existsSync(join(TRIP, 'data/index.json'))) throw Error('no data/index.json: run bake.mjs first');
  if (!existsSync(join(TRIP, 'art/kit.json'))) console.warn('no art/kit.json yet: run plan-art.mjs and placeholder-art.mjs (free); the viewer will draw without pictures');
  const T = join(dirname(fileURLToPath(import.meta.url)), '../templates');
  copyFileSync(join(T, 'viewer.html'), join(TRIP, 'index.html')); copyFileSync(join(T, 'road.js'), join(TRIP, 'road.js')); copyFileSync(join(T, 'layout.js'), join(TRIP, 'layout.js'));
}
export function serve(TRIP, port = 0) {   // a tiny static server (any other static server works too); dot-folders stay private
  const root = resolve(TRIP), TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript' };
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
