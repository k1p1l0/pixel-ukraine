// node core-test.mjs: who gets a chat line (local within CHAT_NEAR by route distance with the loop wrap, global between riders who both have it on)
import { makeRoom, routeDist, CHAT_NEAR } from './core.mjs';
const L = 5846000, km = 1000;
let fails = 0; const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };
const room = makeRoom('test'), R = {};
const rider = (name, s, o = {}) => { const c = { name, got: [], send: t => c.got.push(JSON.parse(t)), close() {} }; room.add(c);
  room.msg(c, JSON.stringify({ t: 'hi', name, veh: 'car', s, ...(o.old ? {} : { len: L }) })); if (o.all != null) room.msg(c, JSON.stringify({ t: 'chatmode', all: o.all })); R[name] = c; return c; };
rider('a0', 0); rider('b50', 50 * km); rider('c300', 300 * km); rider('dwrap', L - 30 * km); rider('old', 120 * km, { old: true });
const chats = () => Object.fromEntries(Object.entries(R).map(([n, c]) => [n, c.got.filter(m => m.t === 'chat').map(m => m.text)]));
const clear = () => { for (const c of Object.values(R)) c.got.length = 0; };
let n = 0; const lastT = {}; const say = async (who, text, o = {}) => { const w = 620 - (Date.now() - (lastT[who] || 0)); if (w > 0 && !o.now) await new Promise(r => setTimeout(r, w)); lastT[who] = Date.now(); room.msg(R[who], JSON.stringify({ t: 'chat', text })); n++; };   // waits out the room's 600 ms rate limit per rider unless now
const expect = (text, want) => { const got = chats(); for (const name of Object.keys(R)) ok(got[name].includes(text) === want.includes(name), `${text}: ${name} ${want.includes(name) ? 'should' : 'should not'} get it`); clear(); };

ok(routeDist(0, L - 30 * km, L) === 30 * km, 'wrap distance'); ok(routeDist(0, L - 30 * km, 0) === L - 30 * km, 'no wrap without len'); ok(CHAT_NEAR === 100 * km, 'CHAT_NEAR is 100 km');
clear();
await say('a0', 'from a0'); expect('from a0', ['b50', 'dwrap']);                       // 50 km and 30 km over the wrap; 300 km and 120 km are far; no echo to a0
await say('b50', 'from b50'); expect('from b50', ['a0', 'old', 'dwrap']);              // old at 70 km; dwrap at 80 km over the wrap
await say('c300', 'from c300'); expect('from c300', []);                               // nobody within 100 km
await say('dwrap', 'from dwrap'); expect('from dwrap', ['a0', 'b50']);                 // 30 km and 80 km across Kyiv
await say('old', 'from old'); expect('from old', ['b50']);                            // an old client without len (and without chatmode): 70 km to b50, 120 km to a0, 150 km to dwrap with dwrap's len
room.msg(R.c300, JSON.stringify({ t: 'chatmode', all: true })); room.msg(R.old, JSON.stringify({ t: 'chatmode', all: 'yes' }));   // only a real true turns it on
await say('c300', 'c300 global'); expect('c300 global', []);                           // global, but nobody else has it on
room.msg(R.a0, JSON.stringify({ t: 'chatmode', all: true }));
await say('c300', 'c300 global 2'); expect('c300 global 2', ['a0']);                   // both global
await say('a0', 'a0 global'); expect('a0 global', ['b50', 'dwrap', 'c300']);           // near ones plus the far global one; old (120 km, local) not
await say('b50', 'b50 local'); expect('b50 local', ['a0', 'old', 'dwrap']);            // b50 is local: c300 (global, 250 km) does not hear it
room.msg(R.a0, JSON.stringify({ t: 'chatmode', all: false }));
await say('c300', 'c300 after a0 off'); expect('c300 after a0 off', []);
room.msg(R.c300, JSON.stringify({ t: 'pos', s: 60 * km, v: 0 }));               // the server uses the positions it holds at send time
await say('c300', 'c300 moved'); expect('c300 moved', ['a0', 'b50', 'old', 'dwrap']);   // 60 km: a0 60, b50 10, old 60, dwrap 90 over the wrap
await say('c300', 'too soon', { now: true }); expect('too soon', []);                                  // rate limit stays
await say('a0', '\u0007   '); lastT.a0 = 0; expect('\u0007   ', []);                                    // clean() leaves nothing: not sent
ok(routeDist(10 * km, 200 * km, 150 * km) === 190 * km, 'a len shorter than a position is ignored');
const bad = makeRoom('bad'), u = { got: [], send: t => u.got.push(JSON.parse(t)), close() {} }, w = { got: [], send: t => w.got.push(JSON.parse(t)), close() {} };
bad.add(u); bad.add(w); bad.msg(u, JSON.stringify({ t: 'hi', name: 'u', s: 0, len: 500 })); bad.msg(w, JSON.stringify({ t: 'hi', name: 'w', s: 300, len: 'x' }));
bad.msg(u, JSON.stringify({ t: 'chat', text: 'near' })); ok(w.got.some(m => m.t === 'chat' && m.text === 'near'), 'a bogus len does not break local chat');
bad.msg(w, JSON.stringify({ t: 'pos', s: 400 * km, v: 0 })); await new Promise(r => setTimeout(r, 620)); bad.msg(u, JSON.stringify({ t: 'chat', text: 'far' })); ok(!w.got.some(m => m.text === 'far'), 'a 500 m len is dropped: 400 km stays far');
const pr = makeRoom('friends'), x = { got: [], send: t => x.got.push(JSON.parse(t)), close() {} }, y = { got: [], send: t => y.got.push(JSON.parse(t)), close() {} };
pr.add(x); pr.add(y); pr.msg(x, JSON.stringify({ t: 'hi', name: 'x', s: 0, len: L })); pr.msg(y, JSON.stringify({ t: 'hi', name: 'y', s: 400 * km, len: L }));
pr.msg(x, JSON.stringify({ t: 'chat', text: 'far friend' })); ok(!y.got.some(m => m.t === 'chat'), 'private room: far friend does not get a local line');
console.log(fails ? `${fails} failed` : `all passed (${n} chat lines checked)`); process.exit(fails ? 1 : 0);
