#!/usr/bin/env node
// Multiplayer relay for the viewer (no dependencies): rooms of riders who see each other on the road, chat and share the radio.
//   node relay.mjs --port 8787 --static trips/my-trip     serves the trip too, so one process is the whole game
//   node relay.mjs --port 8787                             relay only (the page then needs ?relay=ws://host:8787)
//   --max N                                                riders per room (default 150; small for a local test of the overflow copies)
// The page joins with ?room=NAME. GET /_rooms lists the rooms and who is in them, GET /_sections the hub's table of the open world,
// GET /_world every rider of it ({t, n, riders: [[s, name, col]…]}).
// The open world (core.mjs WORLDS) runs here as in the Worker: one room per section, linked in this process, one hub per world.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { makeRoom, makeHub, cleanName, WORLDS, hubName } from './core.mjs';

const A = Object.fromEntries(process.argv.slice(2).map((a, i, v) => a.startsWith('--') ? [a.slice(2), v[i + 1] && !v[i + 1].startsWith('--') ? v[i + 1] : true] : []).filter(x => x.length));
const PORT = +A.port || 8787, STATIC = A.static ? resolve(A.static) : null, MAX = +A.max || undefined;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const ROOMS = new Map(), HUBS = new Map(), hub = n => { if (!HUBS.has(n)) HUBS.set(n, makeHub()); return HUBS.get(n); };
const LINKS = { max: MAX, link: (to, text) => { const R = ROOMS.get(to); if (R) setImmediate(() => R.link(text)); }, report: (h, b) => hub(h).report(b) };   // rooms of the world talk in process; an absent room has nobody to tell
const room = n => { n = cleanName(n); if (/-hub$/.test(n)) return null; if (!ROOMS.has(n)) ROOMS.set(n, makeRoom(n, LINKS)); return ROOMS.get(n); };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/_sections') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify(hub(hubName(WORLDS[0])).table())); }
  if (u.pathname === '/_world') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'max-age=5' }); return res.end(JSON.stringify(hub(hubName(WORLDS[0])).world())); }   // every rider of the world, for the overview map
  if (u.pathname === '/_rooms') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify([...ROOMS.values()].map(r => ({ room: r.name, players: r.players().map(p => ({ name: p.name, veh: p.veh, km: +(p.s / 1000).toFixed(1) })) })))); }
  if (!STATIC) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('pixel-path relay: connect a viewer with ?room=NAME&relay=ws://this-host'); }
  let file = resolve(join(STATIC, decodeURIComponent(u.pathname))); if (!(file + sep).startsWith(STATIC + sep)) { res.writeHead(403); return res.end(); }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'max-age=3600' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});

// ---- a small RFC 6455 server: text frames in, text frames out, ping/pong, close
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const frame = (str, op = 1) => { const d = Buffer.from(str), n = d.length; let h; if (n < 126) h = Buffer.from([0x80 | op, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); } return Buffer.concat([h, d]); };
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'], u = new URL(req.url, 'http://x');
  const R = key && u.pathname === '/ws' ? room(u.searchParams.get('room')) : null;
  if (!R) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
  const conn = { send: t => sock.write(frame(t)), close: () => { try { sock.write(frame('', 8)); } catch {} sock.end(); } };
  if (!R.add(conn)) return; let buf = Buffer.alloc(0), parts = [];
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return; const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let n = buf[1] & 0x7f, o = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); o = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      if (n > 1 << 16) return conn.close();   // nobody needs frames that big here
      if (buf.length < o + (masked ? 4 : 0) + n) return;
      const mask = masked ? buf.subarray(o, o + 4) : null, p = Buffer.from(buf.subarray(o + (masked ? 4 : 0), o + (masked ? 4 : 0) + n)); buf = buf.subarray(o + (masked ? 4 : 0) + n);
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      if (op === 8) return conn.close(); if (op === 9) { sock.write(frame(p.toString(), 10)); continue; } if (op === 10) continue;
      if (op === 1 || op === 0) { parts.push(p); if (fin) { R.msg(conn, Buffer.concat(parts).toString('utf8')); parts = []; } }
    }
  });
  const bye = () => R.del(conn);
  sock.on('close', bye); sock.on('error', bye); sock.setTimeout(90000, () => conn.close());
});
setInterval(() => { for (const [n, R] of ROOMS) { R.sweep(); if (R.idle()) ROOMS.delete(n); } }, 15000).unref();   // an empty room goes once its last tick has told the hub
server.listen(PORT, () => console.log(`relay on http://0.0.0.0:${PORT}${STATIC ? ` serving ${STATIC}` : ''}; open /?room=NAME`));
