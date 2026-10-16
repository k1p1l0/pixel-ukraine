// Multiplayer room logic shared by relay.mjs (Node) and worker.mjs (Cloudflare, one Durable Object per room name).
// A room is a set of riders on one trip. Each connection is { send(text), close() }. Messages are one JSON object per frame:
//   client → room:  hi {name, veh, s, len, b, u, ho, col}   pos {s, v, veh}   chat {text}   chatmode {all}   radio {st: {name, url}, on}   ho {}
//   room → client:  you {id, col, players, room, k, c, sec, tot}   join {p, h}   leave {id, name, h}   name {id, name}
//                   ps {p: [[id, s, v, veh, name?, col?]…]}   pos {id, s, v, veh} (old pages)   gone {ids}   all {p: [[id, s, v, veh, name, col]…], sec, tot}
//                   chat {id, name, col, text}   radio {id, name, i, st, on}   full {to}
// hi: b = 1 the page takes the batched ps; u = a random key of the page (it finds the same rider in two rooms during a handover); ho = 1 joins as a
// handover (no «приєднався» line); col = the colour the page had in its last room. ho {} tells the old room that the rider moves on (no «поїхав» line).
//
// Positions are batched (load test 2026-10-14: a cast per incoming pos broke a room of 50-75 riders at the Kyiv start). A pos only stores the latest
// value; every TICK ms each rider gets ONE ps with the riders that changed among its NEAR_MAX nearest within NEAR metres (name and colour the first
// time one comes into view). A page without b gets the same riders as single pos messages. Every ALL_EVERY ms everyone gets the roll call 'all'
// (every rider of the room, plus the riders of the neighbour sections it knows of), so far riders still move on the maps.
//
// The open world (a base name in WORLDS, 'ukraine') is cut into sections of SEC metres along the route: room '<base>-s<k>' holds the riders of
// section k = floor(s / SEC); the page hands over to the next section 2 km (HYST) past a border. The last and the first section are neighbours on a
// loop (len known). A full section room (max riders) answers full {to: '<base>-s<k>-<c>'}, a copy of it; riders in copies of one section do not see
// each other's positions, but chat reaches them. Rooms of the world talk through o.link(roomName, text): every tick a room sends each live room of a
// neighbour section the riders within FWD of the shared border (pos) and the chat lines that may reach it; every roll call also the riders within
// CHAT_NEAR + HYST of it (far), so the chat box and the maps know them. A room delivers what comes in by its own rules. A hub per world
// ('<base>-hub', makeHub) keeps the count of every live room: each room reports to it (o.report) every REPORT_EVERY ms and gets the table back,
// which gives the live rooms to talk to, the copy to name when full, and the counts per section that the roll call carries (sec, tot).
// The report also carries a short roster (ro: up to ROSTER_MAX rows [s to 100 m, name cut to ROSTER_NAME, col] of the riders that said hi); the hub
// keeps the latest one per room with its count and drops it with the room. The table it answers with never carries rosters (rooms do not need
// them); hub.world() joins them for the overview map (GET /_world: every rider of the world as a dot, at most WORLD_MAX rows).
//
// chat is local: it reaches rider r when r is within CHAT_NEAR metres of the sender by route distance (positions as the room holds them when the line
// arrives), or when both the sender and r have the global chat on (chatmode {all: true}; a rider who never sends chatmode is local). The sender gets
// no copy: the page shows its own line. len is the route length in metres: on a loop (Kyiv to Kyiv) the distance wraps,
// d = min(|s1 - s2|, len - |s1 - s2|); a chat pair wraps only when both sent the same len. Positions wrap with the room's len (the last valid one).
export const MAX_PLAYERS = 150, NEAR = 1000, NEAR_MAX = 30, CHAT_NEAR = 100000, ALL_EVERY = 2000, TICK = 125, SEC = 500000, HYST = 2000,
  FWD = NEAR + HYST + 500, FOREIGN_TTL = 1000, FAR_TTL = 5000, REPORT_EVERY = 2000, HUB_TTL = 15000, MAX_COPIES = 20, MSG_PER_S = 60,
  FWD_MAX = 30, FAR_MAX = 200, ROLL_FOREIGN_MAX = 300, CAST_EVERY = 2000, STALE_V = 2000, JOIN_MS = 1500, ROSTER_MAX = 150, ROSTER_NAME = 16, WORLD_MAX = 2000,
  COLS = ['#ffd23f', '#5ad1ff', '#ff6b6b', '#7cff8a', '#ff9f43', '#d08cff', '#4ef0c2', '#ff7be5', '#c8ff5a', '#ffb3b3'];
export const WORLDS = ['ukraine'];   // room bases cut into sections; any other name is one room (?room=NAME, a private room)
// The route length of each world, fixed on the server (review 2026-10-14: one hi {len: 1000} re-cut the sections of a whole room). A page's len only
// tells whether it rides the loop; in a private room the first valid len stays. Change it here when the trip's route changes (route.json total).
export const WORLD_LEN = { ukraine: 5846355 };
// What a room forwards to a neighbour: the FWD_MAX riders nearest the border every tick, the FAR_MAX nearest with a roll call; a roll call carries at most
// ROLL_FOREIGN_MAX riders of other rooms (those within CHAT_NEAR + HYST of a rider here). A rename or a radio line goes out at most every CAST_EVERY ms
// per rider (the latest one waits), and no radio at all in the open world (its pages ignore it). A rider with no pos for STALE_V ms (a hidden tab,
// a phone in the background) shows standing.
const clean = (t, n) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n).trim();
const num = (v, lo, hi) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : 0;
const r1 = x => Math.round(x * 10) / 10;
const arr = a => Array.isArray(a) ? a.slice(0, 2000) : [];
const pub = p => ({ id: p.id, name: p.name, veh: p.veh, s: p.s, v: p.v, col: p.col });
export const cleanName = n => String(n || 'lobby').replace(/[^\w-]/g, '').slice(0, 32) || 'lobby';
export const routeDist = (a, b, L) => { const d = Math.abs(a - b); return L >= Math.max(a, b) && L > d ? Math.min(d, L - d) : d; };   // metres along the route, wrapped on a loop of length L (an L shorter than a position is wrong: no wrap)
export const nSections = L => L >= 1000 ? Math.max(1, Math.ceil(L / SEC)) : 0;   // 0: the route length is not known
export const sectionOf = (s, L) => { const n = nSections(L), k = Math.floor(Math.max(0, s) / SEC); return n ? Math.min(n - 1, k) : k; };
export const roomName = (base, k, c = 1) => `${base}-s${k}${c > 1 ? '-' + c : ''}`;
export const hubName = base => `${base}-hub`;
export function parseRoom(name, worlds = WORLDS) {   // '<base>-s<k>' or '<base>-s<k>-<c>' of a world → {base, k, c}, else null
  const m = /^(\w+?)-s(\d{1,2})(?:-(\d{1,2}))?$/.exec(name || ''); if (!m || !worlds.includes(m[1])) return null;
  const k = +m[2], c = m[3] ? +m[3] : 1; if (k > 39 || c < 1 || c > MAX_COPIES || roomName(m[1], k, c) !== name) return null; return { base: m[1], k, c };
}

// The hub of a world: live rooms and their counts. report({name, n, ro}) stores one room (n = 0 drops it) and returns the table {t, rooms: {name: n}, at: {name: t}}
// (at: when each room last reported, so a full room knows which of the riders it sent there the count already holds). world(max) → {t, n, riders: [[s, name, col]…]}:
// the rosters of the live rooms (n: the riders the rooms count, riders: at most max rows of them).
const cut = (t, n) => Array.from(String(t ?? '')).slice(0, n).join('').trim();   // by code points: an emoji is not cut in half
const roster = a => { const out = []; if (Array.isArray(a)) for (const e of a.slice(0, ROSTER_MAX)) if (Array.isArray(e)) out.push([Math.round(num(e[0], 0, 1e8) / 100) * 100, cut(clean(e[1], 64), ROSTER_NAME), COLS.includes(e[2]) ? e[2] : '#5ad1ff']); return out; };
export function makeHub(now = Date.now) {
  const R = new Map();
  const table = () => { const t = now(), rooms = {}, at = {}; for (const [n, e] of R) { if (t - e.t > HUB_TTL) R.delete(n); else { rooms[n] = e.n; at[n] = e.t; } } return { t, rooms, at }; };
  const world = (max = WORLD_MAX) => { const tb = table(), riders = []; let n = 0; for (const [nm, c] of Object.entries(tb.rooms)) { n += c; for (const e of R.get(nm).ro) { if (riders.length >= max) break; riders.push(e); } } return { t: tb.t, n, riders }; };
  return { table, world, report(b) { const n = cleanName(b && b.name), c = num(b && b.n, 0, 10000) | 0; if (b && b.name) { if (c) R.set(n, { n: c, t: now(), ro: roster(b.ro) }); else R.delete(n); } return table(); } };
}

// o: { now, timers (false: the host calls tick()), max, worlds, link(roomName, text), report(hubName, {name, n}) → table, a promise of one, or nothing
//      (the host then hands the table in later with room.setTable) }
export function makeRoom(name, o = {}) {
  const now = o.now || Date.now, worlds = o.worlds || WORLDS, sec = parseRoom(name, worlds), max = o.max || MAX_PLAYERS;
  const tag = sec ? 1 + sec.k * MAX_COPIES + (sec.c - 1) : 0;   // ids of a section room end in its tag (id % 1000): unique across the world
  const P = new Map(), F = new Map(), Q = new Map(), seenFrom = new Map();   // P riders here, F riders of other rooms, Q what goes to other rooms this tick
  let nextN = 1, allT = 0, L = sec ? o.len || WORLD_LEN[sec.base] || 0 : 0, table = null, repT = -1e9, repN = -1, timer = null;
  const fixedL = !!L, HEAD = Math.max(1, Math.round(max * 0.05)), sentTo = new Map();   // sentTo: copy number → when this room sent riders there lately
  const S = v => { const x = num(v, 0, 1e8); return L ? Math.min(x, L - 1) : x; };   // a position on the route: [0, L) once the length is known
  const send = (c, m) => { try { c.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch {} };
  const cast = (m, but) => { const t = JSON.stringify(m); for (const p of P.values()) if (p !== but && p.hi) send(p.conn, t); };
  const queue = to => { let q = Q.get(to); if (!q) Q.set(to, q = { pos: [], far: [], chat: [] }); return q; };
  // the world around this room
  const N = () => nSections(L);
  const bounds = () => { const n = N(), lo = sec.k * SEC, hi = n && sec.k === n - 1 ? L : (sec.k + 1) * SEC; return [lo, hi]; };
  const sides = () => { const n = N(), [lo, hi] = bounds(), out = [], kl = sec.k > 0 ? sec.k - 1 : n > 1 ? n - 1 : null, ku = !n || sec.k < n - 1 ? sec.k + 1 : n > 1 ? 0 : null;
    if (kl != null) out.push({ edge: lo, k: kl }); if (ku != null) out.push({ edge: hi, k: ku }); return out; };   // the lower and the upper border; on a loop section 0 and the last one meet at Kyiv
  const live = () => { const t = now(), out = new Map(); if (table) for (const [n, c] of Object.entries(table.rooms || {})) { const r = parseRoom(n, worlds); if (r && r.base === sec.base && c > 0 && n !== name) out.set(n, r); }
    for (const [n, at] of seenFrom) { if (t - at > FAR_TTL) { seenFrom.delete(n); continue; } const r = parseRoom(n, worlds); if (r && n !== name) out.set(n, r); } return out; };   // rooms with riders: the hub's table and whoever talked to us lately
  const liveIn = (rooms, k) => [...rooms].filter(([, r]) => r.k === k).map(([n]) => n);
  const counts = () => { const n = N(); let m = n; const c = []; if (table) for (const [nm, v] of Object.entries(table.rooms || {})) { const r = parseRoom(nm, worlds); if (r && r.base === sec.base && nm !== name) { c[r.k] = (c[r.k] || 0) + v; if (!n) m = Math.max(m, r.k + 1); } }
    m = Math.max(m, sec.k + 1); let here = 0; for (const p of P.values()) if (p.hi) here++; c[sec.k] = (c[sec.k] || 0) + here; const out = Array.from({ length: m }, (_, i) => c[i] || 0); return { sec: out, tot: out.reduce((a, b) => a + b, 0) }; };   // riders here: a socket that never said hi is not one
  const copyFor = () => {   // a full room names the first higher copy with space: never a lower one, so a join burst cannot ping-pong between two rooms
    if (!sec) return undefined; const t = now(), cnt = new Map(), at = new Map();   // the count: the hub's table (two report rounds old at worst) plus the riders this room sent there since
    if (table) for (const [nm, v] of Object.entries(table.rooms || {})) { const r = parseRoom(nm, worlds); if (r && r.base === sec.base && r.k === sec.k && r.c > sec.c) { cnt.set(r.c, v); at.set(r.c, num(table.at && table.at[nm], 0, 1e15)); } }
    for (const [c, ts] of sentTo) { const seen = (at.get(c) || 0) - JOIN_MS;   // a rider sent JOIN_MS before the copy's last report has joined by then: the count holds it
      while (ts.length && (ts[0] < seen || t - ts[0] > 30000)) ts.shift(); if (!ts.length) sentTo.delete(c); else cnt.set(c, (cnt.get(c) || 0) + ts.length); }
    for (let c = sec.c + 1; c <= MAX_COPIES; c++) if ((cnt.get(c) || 0) < max - HEAD) { let ts = sentTo.get(c); if (!ts) sentTo.set(c, ts = []); ts.push(t); return roomName(sec.base, sec.k, c); }
    return undefined; };
  const rosterRows = () => { const out = []; for (const p of P.values()) { if (out.length >= ROSTER_MAX) break; if (p.hi && !p.ho) out.push([Math.round(p.s / 100) * 100, cut(p.name, ROSTER_NAME), p.col]); } return out; };   // who rides here, for the overview map (a rider leaving on a handover is in its new room)
  const report = n => { if (!sec || !o.report) return; repT = now(); repN = n; try { Promise.resolve(o.report(hubName(sec.base), n ? { name, n, ro: rosterRows() } : { name, n })).then(tb => room.setTable(tb), () => {}); } catch {} };
  const castSoon = (p, key, m, t) => { if (t - (p.ct[key] || -1e9) >= CAST_EVERY) { p.ct[key] = t; delete p.pend[key]; cast(m, p); } else p.pend[key] = m; };   // a rename or a radio line: at once, or the latest one when its turn comes
  const vNow = (p, t) => t - p.posT > STALE_V ? 0 : r1(p.v);
  const putForeign = (e, kind, t) => {   // [id, s, v, veh, name, col, u] from another room of the world
    if (!Array.isArray(e)) return; const id = num(e[0], 0, 1e9) | 0; if (!id || id % 1000 === tag || (!F.has(id) && F.size >= 2000)) return;
    let f = F.get(id); if (!f) F.set(id, f = { id, t: 0, tf: 0, hid: false }); f.s = S(e[1]); f.v = num(e[2], -80, 80); f.veh = clean(e[3], 12); f.name = clean(e[4], 24) || `гість ${id}`;
    f.col = COLS.includes(e[5]) ? e[5] : '#5ad1ff'; f.u = clean(e[6], 16); if (kind === 'pos') f.t = t; else f.tf = t; };
  const deliver = (c, but) => {   // a chat line {id, name, col, text, s, L, all, u} by the local rule or the global switch
    const t = JSON.stringify({ t: 'chat', id: c.id, name: c.name, col: c.col, text: c.text });
    for (const q of P.values()) if (q !== but && q.hi && (!c.u || q.u !== c.u) && (routeDist(c.s, q.s, c.L && c.L === q.L ? c.L : 0) <= CHAT_NEAR || (c.all && q.all))) send(q.conn, t); };
  const ensure = () => { if (timer || o.timers === false) return; timer = setInterval(() => room.tick(), TICK); if (timer && timer.unref) timer.unref(); };

  const room = {
    name, sec, tag, size: () => P.size, idle: () => !timer && !P.size, table: () => table, setTable(tb) { if (tb && typeof tb === 'object' && tb.rooms && typeof tb.rooms === 'object') table = tb; },
    players: () => [...P.values()].filter(p => p.hi).map(pub),
    add(conn) {
      if (P.size >= max) { const to = copyFor(); send(conn, to ? { t: 'full', to } : { t: 'full' }); try { conn.close(); } catch {} return null; }
      const n = nextN++, t = now(); const p = { id: tag ? n * 1000 + tag : n, conn, name: '', veh: '', s: 0, v: 0, L: 0, all: false, col: COLS[(n - 1) % COLS.length], last: t, chatT: 0, wt: t, wn: 0, hi: false, b: false, u: '', ho: false, seen: new Map(), posT: t, ct: {}, pend: {} };
      P.set(conn, p); ensure(); if (sec && P.size >= max - HEAD && repN < max - HEAD) report(P.size);   // full now: tell the hub at once, not up to 2 s later
      return p;
    },
    msg(conn, text) {
      const p = P.get(conn); if (!p) return; const t = now(); p.last = t;
      if (t - p.wt >= 1000) { p.wt = t; p.wn = 0; } if (++p.wn > MSG_PER_S) return;   // a flood is dropped, not parsed
      let m; try { m = JSON.parse(text); } catch { return; } if (!m || typeof m !== 'object') return;
      if (m.t === 'hi') {
        const was = p.hi; p.name = clean(m.name, 24) || `гість ${p.id}`; p.veh = clean(m.veh, 12); p.s = S(m.s); p.posT = t;
        if (m.len != null) p.L = fixedL ? L : num(m.len, 0, 1e8) >= 1000 ? num(m.len, 0, 1e8) : 0;   // a world wraps at its own length; a route shorter than 1 km is not a route
        if (p.L && !L) { L = p.L; p.s = S(p.s); }   // a private room keeps its first valid length: a later hi cannot re-cut it
        if (!was) { p.hi = true; p.b = m.b === 1 || m.b === true; p.u = clean(m.u, 16).replace(/[^\w-]/g, ''); if (COLS.includes(m.col)) p.col = m.col;   // b, u and col belong to the first hi; a later one only renames
          send(conn, { t: 'you', id: p.id, col: p.col, room: name, players: this.players().filter(q => q.id !== p.id), ...(sec ? { k: sec.k, c: sec.c, ...counts() } : {}) });
          cast({ t: 'join', p: pub(p), ...(m.ho ? { h: 1 } : {}) }, p); }
        else castSoon(p, 'name', { t: 'name', id: p.id, name: p.name }, t);
      } else if (!p.hi) return;
      else if (m.t === 'pos') { p.s = S(m.s); p.posT = t; p.v = num(m.v, -80, 80); if (m.veh != null) p.veh = clean(m.veh, 12); }   // the latest value only: the tick sends it on
      else if (m.t === 'chat') { if (t - p.chatT < 600) return; const text = clean(m.text, 200); if (!text) return; p.chatT = t;
        const c = { id: p.id, name: p.name, col: p.col, text, s: p.s, L: p.L, all: p.all, u: p.u }; deliver(c, p);
        if (sec) { const rooms = live(), to = new Set(liveIn(rooms, sec.k));   // the copies of this section, the neighbours within reach, everyone when global
          for (const sd of sides()) if (routeDist(p.s, sd.edge, L) <= CHAT_NEAR + HYST) for (const n of liveIn(rooms, sd.k)) to.add(n);
          if (p.all) for (const n of rooms.keys()) to.add(n);
          for (const n of to) queue(n).chat.push(c); } }
      else if (m.t === 'chatmode') p.all = m.all === true;
      else if (m.t === 'ho') p.ho = true;
      else if (m.t === 'radio') { if (sec) return; const st = m.st && typeof m.st === 'object' && /^https:\/\/\S{1,300}$/.test(String(m.st.url || '')) ? { name: clean(m.st.name, 60), url: String(m.st.url) } : undefined; castSoon(p, 'radio', { t: 'radio', id: p.id, name: p.name, i: num(m.i, 0, 99) | 0, st, on: !!m.on }, t); }
    },
    del(conn) { const p = P.get(conn); if (!p) return; P.delete(conn); if (p.hi) cast({ t: 'leave', id: p.id, name: p.name, ...(p.ho ? { h: 1 } : {}) }); },
    sweep(maxIdle = 70000) { const t = now(); for (const [c, p] of P) if (t - p.last > maxIdle || !p.hi && t - p.last > 15000) {  try { c.close(); } catch {} this.del(c); } },   // silent for 70 s, or no hi 15 s after the start (a socket its page gave up on)
    link(text) {   // what another room of the world sends (only rooms call this: the hosts never route a viewer's request here)
      if (!sec || !P.size) return; let m; try { m = JSON.parse(text); } catch { return; } const from = m && parseRoom(m.from, worlds); if (!from || from.base !== sec.base || m.from === name) return;
      const t = now(); seenFrom.set(m.from, t); if (!L && num(m.L, 0, 1e8) >= 1000) L = num(m.L, 0, 1e8);   // a section room has its world's length: this is for a world without one
      for (const e of arr(m.pos)) putForeign(e, 'pos', t); for (const e of arr(m.far)) putForeign(e, 'far', t);
      for (const c of arr(m.chat)) { if (!c || typeof c !== 'object') continue; const text = clean(c.text, 200); if (!text) continue;
        deliver({ id: num(c.id, 0, 1e9) | 0, name: clean(c.name, 24), col: COLS.includes(c.col) ? c.col : '#5ad1ff', text, s: S(c.s), L: num(c.L, 0, 1e8), all: c.all === true, u: clean(c.u, 16) }); }
    },
    tick() {
      const t = now(), flush = () => { if (o.link) for (const [to, q] of Q) { const body = JSON.stringify({ from: name, L, ...q }); try { Promise.resolve(o.link(to, body)).catch(() => {}); } catch {} } Q.clear(); };
      if (!P.size) { flush(); if (repN > 0) report(0); F.clear(); seenFrom.clear(); if (timer) { clearInterval(timer); timer = null; } return; }
      if (P.size !== repN && repN <= 0 || t - repT >= REPORT_EVERY) report(P.size);
      // who is around: the riders here and the fresh ones of the neighbour rooms (one rider in two rooms during a handover counts once: its own room wins)
      for (const p of P.values()) for (const key in p.pend) if (t - (p.ct[key] || -1e9) >= CAST_EVERY) castSoon(p, key, p.pend[key], t);   // renames and radio lines that waited their turn
      const mine = new Set(), E = [], gone = [];
      for (const p of P.values()) if (p.hi) { if (p.u) mine.add(p.u); E.push({ id: p.id, s: p.s, v: vNow(p, t), veh: p.veh, name: p.name, col: p.col, p }); }
      const roll = [];
      for (const [id, f] of F) {
        const fresh = t - f.t <= FOREIGN_TTL, alive = fresh || t - f.tf <= FAR_TTL;
        if (!alive) { F.delete(id); if (!f.hid) gone.push(id); continue; }
        if (f.u && mine.has(f.u)) { if (!f.hid) { f.hid = true; gone.push(id); } continue; } f.hid = false;
        roll.push(f); if (fresh) E.push({ id, s: f.s, v: r1(f.v), veh: f.veh, name: f.name, col: f.col }); }
      const K = L > 0 ? e => ((e.s % L) + L) % L : e => e.s, M = E.length; for (const e of E) { e.k = K(e); e.key = `${r1(e.s)}|${e.v}|${e.veh}`; } E.sort((a, b) => a.k - b.k);
      if (gone.length) { const g = JSON.stringify({ t: 'gone', ids: gone }); for (const p of P.values()) if (p.hi && p.b) send(p.conn, g); }
      for (let i = 0; i < M; i++) {
        const e = E[i], p = e.p; if (!p) continue; const seen = new Map(), out = []; let a = i - 1, b = i + 1, taken = 0;
        while (taken < NEAR_MAX && taken < M - 1) {   // the nearest first, both ways along the road (round the loop when it is one)
          const ea = L > 0 ? E[((a % M) + M) % M] : E[a], eb = L > 0 ? E[b % M] : E[b];
          const da = ea ? routeDist(e.s, ea.s, L) : Infinity, db = eb ? routeDist(e.s, eb.s, L) : Infinity;
          if (Math.min(da, db) > NEAR) break; const q = da <= db ? ea : eb; if (da <= db) a--; else b++; taken++;
          seen.set(q.id, q.key); const was = p.seen.get(q.id); if (was === q.key) continue;
          out.push(was == null ? [q.id, r1(q.s), q.v, q.veh, q.name, q.col] : [q.id, r1(q.s), q.v, q.veh]); }
        p.seen = seen; if (!out.length) continue;
        if (p.b) send(p.conn, { t: 'ps', p: out }); else for (const x of out) send(p.conn, { t: 'pos', id: x[0], s: x[1], v: x[2], veh: x[3] });   // an old page: one pos each
      }
      const rollNow = t - allT >= ALL_EVERY;
      if (rollNow) { allT = t; const own = E.filter(e => e.p), os = own.map(e => e.k);   // os: the positions of the riders here, sorted (E is)
        const dOwn = s => { if (!os.length) return Infinity; let lo = 0, hi = os.length; while (lo < hi) { const m = (lo + hi) >> 1; if (os[m] < s) lo = m + 1; else hi = m; }
          return Math.min(...[lo - 1, lo, 0, os.length - 1].filter(i => i >= 0 && i < os.length).map(i => routeDist(s, os[i], L))); };   // the nearest rider here (both ends too: the loop wraps)
        const far = roll.map(f => [dOwn(f.s), f]).filter(([d]) => d <= CHAT_NEAR + HYST).sort((a, b) => a[0] - b[0]).slice(0, ROLL_FOREIGN_MAX).map(([, f]) => f);
        const m = { t: 'all', p: [...own, ...far].map(e => [e.id, Math.round(e.s), r1(e.v), e.veh, e.name, e.col]) }; if (sec) Object.assign(m, counts()); cast(m); }
      if (sec && o.link) {   // the border: riders near it go to the live rooms of the neighbour section, every tick (pos) and with each roll call (far)
        const rooms = live(), sd = rooms.size ? sides().map(x => ({ ...x, to: liveIn(rooms, x.k) })).filter(x => x.to.length) : [];
        for (const x of sd) { const near = [], far = [];
          for (const p of P.values()) { if (!p.hi) continue; const d = routeDist(p.s, x.edge, L); if (d <= FWD) near.push([d, p]); if (rollNow && d <= CHAT_NEAR + HYST) far.push([d, p]); }
          const rows = (a, cap) => a.sort((u, w) => u[0] - w[0]).slice(0, cap).map(([, p]) => [p.id, r1(p.s), vNow(p, t), p.veh, p.name, p.col, p.u]);   // the nearest to the border: a launch crowd does not all cross the link
          if (near.length) { const r = rows(near, FWD_MAX); for (const n of x.to) queue(n).pos.push(...r); }
          if (far.length) { const r = rows(far, FAR_MAX); for (const n of x.to) queue(n).far.push(...r); } }
      }
      flush();
    },
  };
  return room;
}
