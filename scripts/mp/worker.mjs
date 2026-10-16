// Cloudflare Worker host for a trip: static files from the assets binding, rooms as Durable Objects (one per room name).
// Deploy from a folder that holds this file, core.mjs, wrangler.toml and the trip in ./site (see wrangler.toml.example).
// The open world (core.mjs WORLDS) is one DO per section ('ukraine-s3', copies 'ukraine-s3-2' …) and one hub DO ('ukraine-hub'), all of class Room.
// Rooms talk over one WebSocket per pair, opened once (/_peer): border riders and chat lines every tick to the live rooms next door, the count to
// the hub every 2 s (the hub answers with its table on the same socket). Not a fetch per tick: a DO's fetch counts as a subrequest of the request
// the DO is handling, often the neighbour's own, and the chain hit «Subrequest depth limit exceeded» on staging (2026-10-14, up to 64 % of links lost).
// /_peer exists only between DOs: the Worker routes a viewer to /ws and /_room only.
import { makeRoom, makeHub, cleanName, hubName, WORLDS } from './core.mjs';
import { votesRoute, votesCitiesRoute } from './votes.mjs';
export { Votes } from './votes.mjs';   // the city vote by donation (needs the VOTES binding; see votes.mjs)
const SWEEP_EVERY = 15000, CHAN_IDLE = 20000, CHAN_RETRY = 2000;   // the alarm frees half-open sockets (no message for 70 s) and closes idle channels

export class Room {
  constructor(state, env) { this.state = state; this.env = env; this.room = null; this.hub = null; this.chans = new Map(); this.st = { sent: 0, queued: 0, dropped: 0, opened: 0, failed: 0, got: 0, lastErr: '' }; }
  log(msg) { const t = Date.now(); if (t - (this.errT || 0) > 10000) { this.errT = t; console.log(`room ${this.name}: ${msg}`); } }   // one line per 10 s at most
  chan(name, onmsg) {   // the socket to another DO of this class, opened on first use; until it is open the last 16 messages wait
    let c = this.chans.get(name); if (c && (c.ws || c.opening || Date.now() - c.failT < CHAN_RETRY)) return c;
    c = { ws: null, q: [], opening: true, failT: 0, used: Date.now() }; this.chans.set(name, c); this.st.opened++;
    this.env.ROOM.get(this.env.ROOM.idFromName(name)).fetch(`https://room/_peer?room=${encodeURIComponent(name)}`, { headers: { upgrade: 'websocket' } }).then(r => {
      const ws = r.webSocket; if (!ws) throw Error(`no socket (${r.status})`); ws.accept(); c.ws = ws; c.opening = false;
      for (const t of c.q.splice(0)) { try { ws.send(t); this.st.sent++; } catch {} }
      ws.addEventListener('message', e => { if (onmsg && typeof e.data === 'string') onmsg(e.data); });
      const gone = () => { if (this.chans.get(name) === c) this.chans.delete(name); }; ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    }).catch(e => { c.opening = false; c.failT = Date.now(); c.q = []; this.st.failed++; this.st.lastErr = String(e && e.message || e).slice(0, 160); this.log(`channel to ${name} failed: ${this.st.lastErr}`); });
    return c;
  }
  tell(name, text, onmsg) { const c = this.chan(name, onmsg); c.used = Date.now();
    if (c.ws) { try { c.ws.send(text); this.st.sent++; } catch (e) { this.chans.delete(name); this.st.dropped++; } }
    else if (c.opening && c.q.length < 16) { c.q.push(text); this.st.queued++; } else this.st.dropped++; }
  init(name) {   // the DO learns its name from the first request (the Worker routes by idFromName of the same clean name)
    if (this.room || this.hub) return; this.name = name;
    if (/-hub$/.test(name)) { this.hub = makeHub(); return; }
    this.room = makeRoom(name, {
      link: (to, text) => this.tell(to, text),
      report: (hub, b) => { this.tell(hub, JSON.stringify(b), t => { try { this.room.setTable(JSON.parse(t)); } catch {} }); },
    });
  }
  peer() {   // another DO opens a channel to this one: room links in, or reports to the hub (answered with the table)
    const pair = new WebSocketPair(), [client, server] = [pair[0], pair[1]]; server.accept();
    server.addEventListener('message', e => { if (typeof e.data !== 'string' || e.data.length > 1 << 20) return; this.st.got++;
      if (this.hub) { let b = null; try { b = JSON.parse(e.data); } catch {} if (b) { try { server.send(JSON.stringify(this.hub.report(b))); } catch {} } }
      else this.room.link(e.data); });
    return new Response(null, { status: 101, webSocket: client });
  }
  async fetch(req) {
    const u = new URL(req.url); this.init(cleanName(u.searchParams.get('room')));
    if (u.pathname === '/_peer' && req.headers.get('upgrade') === 'websocket') return this.peer();
    if (this.hub) return new Response(JSON.stringify(u.pathname === '/_world' ? this.hub.world() : this.hub.table()), { headers: { 'content-type': 'application/json' } });   // /_world: every rider of the world (core.mjs makeHub)
    if (req.headers.get('upgrade') !== 'websocket') return new Response(JSON.stringify(u.searchParams.get('stats') ? { n: this.room.size(), table: this.room.table(), chans: [...this.chans.keys()], ...this.st } : this.room.players()), { headers: { 'content-type': 'application/json' } });   // ?stats=1: the talk with the other rooms
    const pair = new WebSocketPair(), [client, server] = [pair[0], pair[1]]; server.accept();
    const conn = { send: t => server.send(t), close: () => { try { server.close(1000); } catch {} } };
    if (this.room.add(conn)) {
      server.addEventListener('message', e => { if (typeof e.data === 'string' && e.data.length < 4096) this.room.msg(conn, e.data); });
      const bye = () => this.room.del(conn); server.addEventListener('close', bye); server.addEventListener('error', bye);
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + SWEEP_EVERY);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm() {
    if (!this.room) return; this.room.sweep(); const t = Date.now(), empty = !this.room.size();
    for (const [n, c] of this.chans) if (empty || t - c.used > CHAN_IDLE) { this.chans.delete(n); try { c.ws && c.ws.close(1000); } catch {} }   // a channel nobody uses keeps two DOs awake
    if (!empty) await this.state.storage.setAlarm(t + SWEEP_EVERY);
  }
}

// /ph/static/* and /ph/array/* are the script files (us-assets), the rest is ingestion (us.i). Cookies stay here; the client IP goes on as X-Forwarded-For.
async function posthog(req, u) {
  const rest = u.pathname.slice(3), host = /^\/(static|array)\//.test(rest) ? 'us-assets.i.posthog.com' : 'us.i.posthog.com';
  const h = new Headers(req.headers); h.delete('cookie'); h.set('host', host); const ip = req.headers.get('cf-connecting-ip'); if (ip) h.set('x-forwarded-for', ip);
  return fetch(`https://${host}${rest}${u.search}`, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'follow' });
}

let SECT = { t: 0, body: '' };   // the hub's table, kept 10 s in this isolate (the Cache API does nothing on workers.dev)
const WRLD = { t: 0, body: '' };   // every rider of the world for the overview map, kept 5 s (no promise shared between requests: the runtime forbids I/O across them)
async function worldBody(env) { if (Date.now() - WRLD.t <= 5000 && WRLD.body) return WRLD.body;
  try { const h = hubName(WORLDS[0]), r = await env.ROOM.get(env.ROOM.idFromName(h)).fetch(`https://room/_world?room=${h}`), b = await r.text(); if (!r.ok || b[0] !== '{') throw Error(`hub ${r.status}`); WRLD.body = b; WRLD.t = Date.now(); }
  catch { if (!WRLD.body) WRLD.body = '{"t":0,"n":0,"riders":[]}'; WRLD.t = Date.now() - 3000; }   // a failed fetch is tried again in 2 s, the last body meanwhile
  return WRLD.body; }
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/ws' || u.pathname === '/_room') {
      const name = cleanName(u.searchParams.get('room'));
      if (/-hub$/.test(name)) return new Response('no such room', { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
    }
    if (u.pathname === '/_sections') {   // live rooms of the open world and their counts
      if (Date.now() - SECT.t > 10000) { try { const h = hubName(WORLDS[0]), r = await env.ROOM.get(env.ROOM.idFromName(h)).fetch(`https://room/_hub?room=${h}`); SECT = { t: Date.now(), body: await r.text() }; } catch { if (!SECT.body) SECT.body = '{"rooms":{}}'; } }
      return new Response(SECT.body, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=10' } });
    }
    if (u.pathname === '/_world') return new Response(await worldBody(env), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=5' } });   // read only: [[s, name, col]…]
    if (u.pathname.startsWith('/ph/')) return posthog(req, u);   // PostHog through our own host (only used when the trip's site.json has a key): ad blockers drop us.i.posthog.com, not this site
    if (u.pathname === '/api/votes') return votesRoute(req, env);
    if (u.pathname === '/api/votes/cities') return votesCitiesRoute(req, env);
    return env.ASSETS.fetch(req);
  },
};

