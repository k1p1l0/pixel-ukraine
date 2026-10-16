// node rooms-test.mjs: the batched room and the sectioned open world (core.mjs) with fake connections and a fake clock.
// Batching, the 30-nearest cap, old pages, border forwarding between two section rooms, a handover, the wrap at Kyiv, chat across a border,
// the global chat across the world, overflow copies, the counts per section, the flood guard, the hub and its rosters (GET /_world).
import { makeRoom, makeHub, parseRoom, roomName, sectionOf, nSections, routeDist, NEAR, NEAR_MAX, SEC, ALL_EVERY, TICK, FOREIGN_TTL, MAX_PLAYERS, CAST_EVERY, STALE_V, FWD_MAX, ROSTER_MAX, ROSTER_NAME, WORLD_MAX, REPORT_EVERY, COLS } from './core.mjs';
const L = 5846000, km = 1000;
let fails = 0, checks = 0; const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL', msg); } };

// a world: rooms by name, one hub, links delivered after every room has ticked (as DO-to-DO fetches arrive after the sender's tick)
function world(o = {}) {
  let t = 1e6; const now = () => t, hub = makeHub(now), rooms = new Map(), wire = [];
  const get = n => { if (!rooms.has(n)) rooms.set(n, makeRoom(n, { now, timers: false, max: o.max, len: o.len || L, link: (to, text) => { wire.push([to, text]); }, report: (h, b) => hub.report(b) })); return rooms.get(n); };
  const step = async (ms = TICK) => { t += ms; for (const r of rooms.values()) r.tick(); await null; const w = wire.splice(0); for (const [to, text] of w) rooms.get(to)?.link(text); await null; };
  const settle = async () => { await step(); t += 2000; await step(); await step(); };   // every room has reported and has the hub's table with the others
  return { get, step, settle, hub, rooms, now, adv: ms => { t += ms; }, wire };
}
let uid = 0;
function rider(R, name, s, o = {}) {
  const c = { name, got: [], closed: false, send: t => c.got.push(JSON.parse(t)), close() { c.closed = true; } };
  if (!R.add(c)) return c; c.u = o.u || `u${++uid}`;
  R.msg(c, JSON.stringify({ t: 'hi', name, veh: 'car', s, ...(o.old ? {} : { b: 1, u: c.u }), ...(o.len === false ? {} : { len: L }), ...(o.ho ? { ho: 1 } : {}) }));
  c.id = c.got.find(m => m.t === 'you')?.id; c.R = R; return c;
}
const pos = (c, s, v = 10, R = c.R) => R.msg(c, JSON.stringify({ t: 'pos', s, v, veh: 'car' }));
const take = (c, t) => { const out = c.got.filter(m => m.t === t); c.got = c.got.filter(m => m.t !== t); return out; };
const psIds = c => take(c, 'ps').flatMap(m => m.p.map(e => e[0]));
const clear = (...cs) => { for (const c of cs) c.got.length = 0; };

// ---- names and sections
ok(nSections(L) === 12 && sectionOf(L - 1, L) === 11 && sectionOf(499999, L) === 0 && sectionOf(500000, L) === 1, '12 sections of 500 km, the last one 346 km');
ok(parseRoom('ukraine-s3')?.k === 3 && parseRoom('ukraine-s3-2')?.c === 2 && !parseRoom('ukraine-s03') && !parseRoom('ukraine-s3-1') && !parseRoom('friends-s3') && !parseRoom('ukraine'), 'room names of the world');
ok(roomName('ukraine', 11, 2) === 'ukraine-s11-2', 'roomName');

// ---- batching in one room (a private room: no sections)
{ const w = world(), R = w.get('friends'); ok(!R.sec, 'a private room has no section');
  const a = rider(R, 'a', 10 * km), b = rider(R, 'b', 10 * km + 50), c = rider(R, 'c', 10 * km + 120); clear(a, b, c);
  for (let i = 1; i <= 5; i++) { pos(a, 10 * km + i); pos(b, 10 * km + 50 + i); }   // five reports between ticks
  ok(!a.got.length && !b.got.length && !c.got.length, 'a pos is not cast on arrival');
  await w.step(); const pc = take(c, 'ps');
  ok(pc.length === 1 && pc[0].p.length === 2, 'one ps per tick with both others');
  const ea = pc[0].p.find(e => e[0] === a.id); ok(ea && ea[1] === 10 * km + 5 && ea[4] === 'a' && ea[5], 'the latest value, with name and colour the first time');
  ok(take(a, 'ps')[0].p.length === 2 && take(b, 'ps').length === 1, 'everyone gets one');
  await w.step(); ok(!take(c, 'ps').length, 'nothing changed: no ps');
  pos(a, 10 * km + 30); await w.step(); const p2 = take(c, 'ps'); ok(p2.length === 1 && p2[0].p.length === 1 && p2[0].p[0][0] === a.id && p2[0].p[0].length === 4, 'only the changed rider, without the name again');
  ok(!take(a, 'ps').length, 'a sees nothing new: b and c stood still');
  w.adv(ALL_EVERY); await w.step(); const all = take(c, 'all').slice(-1); ok(all.length === 1 && all[0].p.length === 3 && !all[0].sec, 'the roll call of a private room: everyone, no section counts');
  R.msg(c, JSON.stringify({ t: 'chat', text: 'hi friends' })); ok(take(a, 'chat')[0]?.text === 'hi friends' && take(b, 'chat').length === 1 && !take(c, 'chat').length, 'chat in a room stays immediate, no echo');
}

// ---- the 30 nearest within 1 km, an old page, the flood guard
{ const w = world(), R = w.get('crowd'), rs = [];
  for (let i = 0; i < 60; i++) rs.push(rider(R, `r${i}`, 100 * km + i * 8));   // 60 riders over 472 m
  const lone = rider(R, 'lone', 100 * km + 2500), old = rider(R, 'old', 100 * km + 240, { old: true });
  for (const r of rs) clear(r); clear(lone, old); await w.step();
  const me = rs[30], got = take(me, 'ps'); ok(got.length === 1 && got[0].p.length === NEAR_MAX, `the cap: ${NEAR_MAX} riders, not 61`);
  const ids = new Set(got[0].p.map(e => e[0])), all = [...rs, old].filter(r => r !== me), sIn = [], sOut = [];
  for (const r of all) (ids.has(r.id) ? sIn : sOut).push(Math.abs(R.players().find(p => p.id === r.id).s - (100 * km + 30 * 8)));
  ok(Math.max(...sIn) <= Math.min(...sOut), 'the nearest ones');
  ok(!take(lone, 'ps').length, `nobody within ${NEAR} m: nothing`);
  const op = take(old, 'pos'); ok(!take(old, 'ps').length && op.length === NEAR_MAX && op.every(m => m.id && m.s && m.veh), 'an old page gets single pos messages, capped too');
  pos(rs[0], 100 * km + 1); await w.step(); ok(take(old, 'pos').length <= 1, 'an old page: only what changed');
  w.adv(ALL_EVERY); await w.step(); const ao = take(old, 'all').slice(-1); ok(ao.length === 1 && ao[0].p.length === 62, 'an old page gets the full roll call');
  const f = rs[5]; for (let i = 0; i < 100; i++) pos(f, 100 * km + 40 + i); R.msg(f, JSON.stringify({ t: 'chat', text: 'flood' }));
  ok(!take(rs[6], 'chat').length, 'a flood past 60 messages a second is dropped');
  w.adv(1000); R.msg(f, JSON.stringify({ t: 'chat', text: 'later' })); ok(take(rs[6], 'chat').length === 1, 'and taken again the next second');
}

// ---- two section rooms: border forwarding, a handover, counts
{ const w = world(), S0 = w.get('ukraine-s0'), S1 = w.get('ukraine-s1');
  ok(S0.sec && S0.tag !== S1.tag, 'section rooms have their own id tags');
  const a = rider(S0, 'a', 499.6 * km), deep = rider(S0, 'deep', 300 * km), b = rider(S1, 'b', 500.3 * km), c = rider(S1, 'c', 503.0 * km);
  ok(a.id % 1000 === S0.tag && b.id % 1000 === S1.tag && a.id !== b.id, 'ids unique across the world');
  await w.settle(); clear(a, b, c, deep); pos(a, 499.6 * km + 1); pos(b, 500.3 * km + 1); pos(c, 503 * km + 1); pos(deep, 300 * km + 1); await w.step(); await w.step();   // the hub tables come back, then the rooms talk; everyone moves a metre
  ok(psIds(a).includes(b.id), 'a (s0, 400 m before the border) sees b (s1)');
  ok(psIds(b).includes(a.id), 'b sees a across the border');
  const ca = psIds(c); ok(!ca.includes(a.id), 'c, 3.4 km from a, does not');
  ok(!psIds(deep).length, 'a rider deep in s0 gets nothing of s1');
  for (let i = 0; i < ALL_EVERY / TICK; i++) await w.step(); const rb = take(b, 'all').at(-1); ok(rb && rb.p.some(e => e[0] === a.id) && rb.p.some(e => e[0] === c.id), 'the roll call of s1 carries a (a neighbour near the border)');
  ok(rb.sec.length === 12 && rb.sec[0] === 2 && rb.sec[1] === 2 && rb.tot === 4, 'counts per section in the roll call');
  const rd = take(deep, 'all').at(-1); ok(rd.p.some(e => e[0] === b.id) && rd.p.some(e => e[0] === c.id), 'the roll call of s0 carries b and c (within 100 km of the border: far)');
  // the handover: a rides on to 502.1 km, joins s1 (ho), then leaves s0
  pos(a, 502.1 * km); clear(a, b, c, deep); const a2 = rider(S1, 'a', 502.1 * km, { u: a.u, ho: true });
  ok(take(b, 'join')[0]?.h === 1, 'a handover join is marked (no «приєднався» line)');
  await w.step(); await w.step(); w.adv(ALL_EVERY); await w.step();
  const roll = take(c, 'all').at(-1), aIds = roll.p.filter(e => e[4] === 'a').map(e => e[0]); ok(aIds.length === 1 && aIds[0] === a2.id, 'during the overlap s1 shows a once (its own room wins)');
  const gb = take(b, 'gone'); ok(gb.some(m => m.ids.includes(a.id)), 's1 tells its riders that the old a is gone');
  S0.msg(a, JSON.stringify({ t: 'ho' })); S0.del(a); const lv = take(deep, 'leave')[0]; ok(lv?.h === 1 && lv.id === a.id, 'a handover leave is marked (no «поїхав» line)');
  clear(b, c, deep); await w.step(); pos(a2, 502.2 * km); await w.step(); ok(psIds(c).includes(a2.id), 'c sees the new a');
  pos(c, 503.1 * km); await w.step(); ok(!take(a2, 'ps').some(m => m.p.some(e => e[0] === a.id)), 'no ghost of the old a');
  w.adv(FOREIGN_TTL + 6000); await w.step(); ok(!S1.players().some(p => p.id === a.id), 'the old a is not a rider of s1');
}

// ---- the wrap at Kyiv: the last section and the first are neighbours
{ const w = world(), S11 = w.get('ukraine-s11'), S0 = w.get('ukraine-s0');
  const x = rider(S11, 'x', L - 300), y = rider(S0, 'y', 400), z = rider(S0, 'z', 499 * km);
  await w.settle(); clear(x, y, z); pos(x, L - 299); pos(y, 401); pos(z, 499 * km + 1); await w.step(); await w.step();
  ok(psIds(x).includes(y.id), 'x (300 m before the end) sees y (400 m after the start)');
  ok(psIds(y).includes(x.id), 'y sees x over the wrap');
  ok(!psIds(z).includes(x.id), 'z at 499 km does not');
  w.wire.length = 0; await w.step(); ok(!w.wire.some(([to]) => to === 'ukraine-s1'), 'no link to an empty section');
  // chat over the wrap: x at L-300 to y within 100 km, z far
  S11.msg(x, JSON.stringify({ t: 'chat', text: 'over kyiv' })); await w.step();
  ok(take(y, 'chat')[0]?.text === 'over kyiv' && !take(z, 'chat').length, 'chat over the wrap: y hears it, z (499 km) does not');
}

// ---- chat across a border, the global chat across the world
{ const w = world(), S0 = w.get('ukraine-s0'), S1 = w.get('ukraine-s1'), S5 = w.get('ukraine-s5');
  const a = rider(S0, 'a', 450 * km), b = rider(S1, 'b', 520 * km), c = rider(S1, 'c', 621 * km), g = rider(S5, 'g', 2700 * km), loc = rider(S5, 'loc', 2710 * km), old = rider(S1, 'old', 540 * km, { len: false });
  await w.settle(); clear(a, b, c, g, loc, old);
  S0.msg(a, JSON.stringify({ t: 'chat', text: 'from a' })); ok(!take(b, 'chat').length, 'a line for another room waits for the tick');
  await w.step(); ok(take(b, 'chat')[0]?.text === 'from a', 'b (70 km, s1) hears a (s0)'); ok(!take(c, 'chat').length, 'c (171 km) does not');
  ok(!take(g, 'chat').length && !take(loc, 'chat').length, 's5 does not'); ok(take(old, 'chat').length === 1, 'a page without len, 90 km away, does');
  S1.msg(b, JSON.stringify({ t: 'chat', text: 'from b' })); await w.step(); ok(take(a, 'chat').length === 1 && take(c, 'chat').length === 0 && take(old, 'chat').length === 1, 'and back: a (70 km) yes, c (101 km) no');
  S0.msg(a, JSON.stringify({ t: 'chatmode', all: true })); S5.msg(g, JSON.stringify({ t: 'chatmode', all: true })); w.adv(700);
  S0.msg(a, JSON.stringify({ t: 'chat', text: 'global a' })); await w.step();
  ok(take(g, 'chat')[0]?.text === 'global a' && !take(loc, 'chat').length, 'global: g (s5, global on) hears a; loc (local) does not');
  ok(take(b, 'chat').length === 1 && !take(c, 'chat').length, 'global from a still reaches b by the 100 km rule, c (local) not');
  S5.msg(g, JSON.stringify({ t: 'chat', text: 'global g' })); await w.step(); ok(take(a, 'chat')[0]?.text === 'global g' && take(loc, 'chat').length === 1 && !take(b, 'chat').length, 'global g: a (global) and loc (10 km) hear it, b does not');
  ok(!take(a, 'chat').some(m => m.text === 'global a'), 'no echo of a forwarded line');
}

// ---- overflow copies
{ const w = world({ max: 3 }), S0 = w.get('ukraine-s0'), rs = [0, 1, 2].map(i => rider(S0, `p${i}`, 10 * km + i * 30));
  const x = rider(S0, 'x', 10 * km + 100); const full = x.got.find(m => m.t === 'full');
  ok(x.closed && full?.to === 'ukraine-s0-2', 'a full section names its first copy');
  const C2 = w.get(full.to), x2 = rider(C2, 'x', 10 * km + 100); ok(C2.sec.c === 2 && x2.id % 1000 === C2.tag, 'the copy is a room of section 0');
  await w.settle(); for (const r of rs) clear(r); clear(x2); await w.step(); await w.step();
  ok(!psIds(x2).length && !rs.some(r => psIds(r).includes(x2.id)), 'copies of a section do not see each other ride');
  S0.msg(rs[0], JSON.stringify({ t: 'chat', text: 'to the copy' })); await w.step(); ok(take(x2, 'chat')[0]?.text === 'to the copy', 'chat within 100 km reaches the copy');
  for (const r of rs) clear(r); C2.msg(x2, JSON.stringify({ t: 'chat', text: 'from the copy' })); await w.step(); ok(rs.every(r => take(r, 'chat').length === 1), 'and back');
  w.adv(ALL_EVERY); await w.step(); const rc = take(x2, 'all').at(-1); ok(rc.sec[0] === 4 && rc.tot === 4, 'the section count adds its copies');
  const y = rider(S0, 'y', 0); ok(y.got.find(m => m.t === 'full')?.to === 'ukraine-s0-2', 'with space in copy 2, a full room still sends there');
  for (let i = 0; i < 2; i++) rider(C2, `q${i}`, 20 * km); for (let i = 0; i < 4500 / TICK; i++) await w.step();   // a table can be two report rounds old
  const z = rider(S0, 'z', 0); ok(z.got.find(m => m.t === 'full')?.to === 'ukraine-s0-3', 'copy 2 full too: copy 3');
  const z2 = rider(C2, 'z', 0); ok(z2.got.find(m => m.t === 'full')?.to === 'ukraine-s0-3', 'a full copy names the next copy, not the full main room');
  const solo = world({ max: 1 }), P = solo.get('friends'); rider(P, 'a', 0); const pf = rider(P, 'b', 0); ok(pf.got.find(m => m.t === 'full') && !pf.got.find(m => m.t === 'full').to, 'a full private room has no copy');
}

// ---- the hub and an emptied room
{ let t = 0; const h = makeHub(() => t); h.report({ name: 'ukraine-s1', n: 4 }); h.report({ name: 'ukraine-s2', n: 1 });
  ok(Object.keys(h.table().rooms).length === 2, 'the hub keeps live rooms'); h.report({ name: 'ukraine-s2', n: 0 }); ok(!('ukraine-s2' in h.table().rooms), 'n 0 drops a room');
  t = 16000; ok(!Object.keys(h.table().rooms).length, 'a room that stops reporting drops out after 15 s');
  const w = world(), S3 = w.get('ukraine-s3'), r = rider(S3, 'r', 1600 * km); await w.step(); ok(w.hub.table().rooms['ukraine-s3'] === 1, 'a room reports its count');
  S3.del(r); await w.step(); ok(!('ukraine-s3' in w.hub.table().rooms), 'and its end');
  ok(routeDist(0, L - 30 * km, L) === 30 * km, 'routeDist still wraps');
}

// ---- a join burst at the Kyiv start (review F1): a full room never names a lower copy, and counts the riders it sent itself
for (const per of [5, 25, 50]) { const w = world(), hops = []; let refused = 0;
  const join = (name, depth = 0, path = []) => { const R = w.get(name), c = rider(R, 'r', 100); const f = c.got.find(m => m.t === 'full');
    if (!f) { hops.push(depth); return; } if (!f.to || depth >= 6) { refused++; return; } join(f.to, depth + 1, [...path, name]); };
  for (let i = 0; i < 1000; i += per) { for (let j = 0; j < per; j++) join('ukraine-s0'); await w.step(); }
  ok(!refused && Math.max(...hops) <= 2, `a burst of ${per} joins per tick: ${refused} refused, at most ${Math.max(...hops)} hops`);
  ok([...w.rooms.values()].every(r => r.size() <= MAX_PLAYERS), 'no room over its cap'); }

// ---- one rider cannot re-cut the world (review F2): a fixed length per world, positions clamped to it
{ const w = world(), S0 = w.get('ukraine-s0'), S1 = w.get('ukraine-s1'), cl = [];
  for (let i = 0; i < 10; i++) cl.push(rider(S0, `c${i}`, 100 * km + i * 50)); const e = rider(S1, 'e', 500.4 * km), d = rider(S0, 'd', 499.5 * km);
  await w.settle(); const bad = rider(S0, 'bad', 0);
  S0.msg(bad, JSON.stringify({ t: 'pos', s: L + 100225, v: 0 })); w.adv(700); S0.msg(bad, JSON.stringify({ t: 'hi', name: 'bad', len: 1000 }));
  for (const c of cl) clear(c); clear(d, e); for (let i = 0; i < 10; i++) pos(cl[i], 100 * km + i * 50 + 1); pos(d, 499.5 * km + 1); pos(e, 500.4 * km + 1); await w.step(); await w.step();
  ok(cl.every(c => new Set(psIds(c)).size >= 9), 'a fake s or len does not blind a cluster');
  ok(psIds(e).includes(d.id), 'and the border still works');
  ok(S0.players().find(p => p.name === 'bad').s < L, 'a position past the end is clamped');
  const P = world().get('friends'), a = rider(P, 'a', 0, { len: false }), b = rider(P, 'b', 0, { len: false }); P.msg(a, JSON.stringify({ t: 'hi', name: 'a', len: 777000 })); P.msg(b, JSON.stringify({ t: 'hi', name: 'b', len: 1000 }));
  P.msg(a, JSON.stringify({ t: 'pos', s: 776900 })); P.msg(b, JSON.stringify({ t: 'pos', s: 200 })); clear(a, b); P.tick(); ok(psIds(a).includes(b.id), 'a private room keeps its first length (wraps at 777 km)'); }

// ---- radio and renames (review F3): no radio in the open world; in a private room one per CAST_EVERY, the latest one waits
{ const w = world(), S0 = w.get('ukraine-s0'), rs = [0, 1, 2].map(i => rider(S0, `r${i}`, 10 * km + i * 30)); for (const r of rs) clear(r);
  S0.msg(rs[0], JSON.stringify({ t: 'radio', st: { name: 'x', url: 'https://x.ua/a' }, on: true })); ok(!take(rs[1], 'radio').length, 'no radio in a section room');
  const P = world().get('band'), a = rider(P, 'a', 0), b = rider(P, 'b', 0); clear(a, b);
  for (let i = 0; i < 20; i++) P.msg(a, JSON.stringify({ t: 'radio', i, on: true })); for (let i = 0; i < 20; i++) P.msg(a, JSON.stringify({ t: 'hi', name: `a${i}` }));
  ok(take(b, 'radio').length === 1 && take(b, 'name').length === 1, 'a radio and a rename flood: one each');
  P.tick(); ok(!take(b, 'radio').length, 'the rest waits'); }
{ const w = world(), P = w.get('band2'), a = rider(P, 'a', 0), b = rider(P, 'b', 0); clear(a, b); P.msg(a, JSON.stringify({ t: 'hi', name: 'x' })); P.msg(a, JSON.stringify({ t: 'hi', name: 'y' }));
  await w.step(CAST_EVERY); const nm = take(b, 'name'); ok(nm.length === 2 && nm[0].name === 'x' && nm[1].name === 'y', 'the first rename at once, the latest one on its turn'); }

// ---- a rider with no pos for STALE_V shows standing (a hidden tab, a phone in the background)
{ const w = world(), R = w.get('park'), a = rider(R, 'a', 1000), b = rider(R, 'b', 1100); pos(a, 1001, 27.8); pos(b, 1101, 5); await w.step(); clear(a, b);
  for (let i = 0; i < (STALE_V + 500) / TICK; i++) { pos(b, 1101 + i, 5); await w.step(); }
  const last = take(b, 'ps').flatMap(m => m.p).filter(e => e[0] === a.id).at(-1); ok(last && last[2] === 0, 'a silent rider: v 0'); }

// ---- the launch crowd on the Kyiv border (review F5): a room forwards at most FWD_MAX riders a tick to a neighbour
{ const w = world(), S0 = w.get('ukraine-s0'), S11 = w.get('ukraine-s11'); for (let i = 0; i < 120; i++) rider(S0, `k${i}`, 50 + i * 2); rider(S11, 'lone', L - 500);
  await w.settle(); const into = [], ln = S11.link; S11.link = t => { into.push(JSON.parse(t)); return ln(t); }; await w.step(); await w.step();
  ok(into.length && into.every(m => m.pos.length <= FWD_MAX), `at most ${FWD_MAX} border rows a tick`); }

// ---- the rosters for the overview map (hub.world, GET /_world): rows capped, names cut, removed with the room, never in the table
{ let t = 0; const h = makeHub(() => t), long = 'Олександра-Велика-Мандрівниця', emo = 'аб' + '🚗'.repeat(20);
  const rows = Array.from({ length: 220 }, (_, i) => [1234567 + i * 1000 + 49, i === 0 ? long : i === 1 ? emo : `r${i}`, i === 2 ? 'javascript:x' : COLS[i % COLS.length]]);
  h.report({ name: 'ukraine-s2', n: 220, ro: rows }); const w = h.world();
  ok(w.riders.length === ROSTER_MAX && w.n === 220, `a roster is capped at ${ROSTER_MAX} rows (the count stays 220)`);
  ok(w.riders[0][0] === 1234600 && w.riders[0][1] === long.slice(0, ROSTER_NAME) && w.riders[0][2] === COLS[0], 's to 100 m, a long name cut to 16');
  ok(Array.from(w.riders[1][1]).length === ROSTER_NAME && !/[\ud800-\udbff]$/.test(w.riders[1][1]), 'an emoji name is cut by code points, not in half');
  ok(w.riders[2][2] === '#5ad1ff', 'a colour not of the palette is replaced');
  h.report({ name: 'ukraine-s3', n: 2, ro: 'junk' }); h.report({ name: 'ukraine-s4', n: 1, ro: [[1, '<b>x</b>\u0007', '#ff6b6b'], 'bad', null, [NaN, null, null]] });
  const w2 = h.world(); ok(w2.n === 223 && w2.riders.length === ROSTER_MAX + 2, 'a bad roster is empty, bad rows are skipped');
  ok(w2.riders.some(e => e[1] === '<b>x</b>') && w2.riders.every(e => Number.isFinite(e[0]) && typeof e[1] === 'string'), 'control characters go, rows stay plain data');
  ok(!JSON.stringify(h.table()).includes('[') && !JSON.stringify(h.table()).includes('r1') && JSON.stringify(h.table()).length < 300, 'the table the rooms get carries no rosters');
  h.report({ name: 'ukraine-s2', n: 0 }); ok(h.world().riders.length === 2 && h.world().n === 3, 'n 0 drops the room with its roster');
  t = 16000; ok(!h.world().riders.length && !h.world().n, 'a room that stops reporting drops out, roster and all');
  for (let k = 0; k < 20; k++) h.report({ name: roomName('ukraine', k % 12, 1 + (k / 12 | 0)), n: 150, ro: Array.from({ length: 150 }, (_, i) => [k * 1e5 + i, `k${k}`, COLS[0]]) });
  const big = h.world(); ok(big.riders.length === WORLD_MAX && big.n === 3000, `the world holds at most ${WORLD_MAX} rows`);
  ok(JSON.stringify(big).length < 70000, `2000 rows: ${JSON.stringify(big).length} bytes`); }
{ const w = world(), S1 = w.get('ukraine-s1'), S7 = w.get('ukraine-s7'), P = w.get('friends');
  const a = rider(S1, 'Олександра-Велика-Мандрівниця', 512345), b = rider(S1, 'b', 600049), c = rider(S7, 'c', 3600000), f = rider(P, 'friend', 1000);
  const silent = { send() {}, close() {} }; S1.add(silent);   // a socket that never says hi
  await w.step(); w.adv(REPORT_EVERY); await w.step(); const rs = w.hub.world().riders;
  ok(rs.length === 3 && !rs.some(e => e[1] === 'friend'), 'every rider of the world that said hi; a private room is not in it');
  ok(rs.find(e => e[1] === 'b')[0] === 600000 && rs.some(e => e[1] === 'Олександра-Велик' && e[0] === 512300 && e[2] === a.got.find(m => m.t === 'you').col), 'a room sends s to 100 m, the name cut, the colour it gave');
  S1.msg(a, JSON.stringify({ t: 'ho' })); S1.msg(b, JSON.stringify({ t: 'hi', name: 'b2' })); w.adv(REPORT_EVERY); await w.step();
  const r2 = w.hub.world().riders; ok(!r2.some(e => e[1].startsWith('Олекс')) && r2.some(e => e[1] === 'b2'), 'a rider leaving on a handover is not listed; a rename shows at the next report');
  S7.del(c); await w.step(); ok(!w.hub.world().riders.some(e => e[1] === 'c'), 'an emptied room takes its roster with it');
  S1.del(a); S1.del(b); S1.del(silent); await w.step(); ok(!w.hub.world().riders.length && !w.hub.world().n, 'nobody left: an empty world'); }

console.log(fails ? `${fails} of ${checks} failed` : `all ${checks} checks passed`); process.exit(fails ? 1 : 0);
