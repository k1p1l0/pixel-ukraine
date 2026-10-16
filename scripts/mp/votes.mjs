// Durable Object 'Votes' (Ukraine branch): the city vote by donation. It reads the Monobank jar statement with the jar
// owner's read-only personal token (Worker secret MONO_TOKEN; it can read accounts, never move money), counts every top-up
// once (by its transaction id) for the city its comment names, and serves the totals to the page: GET /api/votes.
// Config (wrangler.toml [vars]): MONO_JAR = the id in the jar link https://send.monobank.ua/jar/<MONO_JAR>; VOTE_START =
// unix seconds, top-ups before it do not count (default: when the vote first ran). A change of either takes effect on the
// next poll: a new jar counts from zero, a new start re-reads the statement from it.
// Privacy: it stores only id, time, amount, city and how the city was matched. Never the donor's name, the description,
// the comment text or any other account. Nothing it reads is logged. The page gets totals only.
// Add a city: a top-up for a city that is not a route stop («Місто: Полтава», votes-core.mjs) counts for that city in 'add'; when
// one reaches the goal (var ADD_CITY_UAH, default 5000 hryvnias, read per view) the road is rerouted through it later, by hand.
// GET /api/votes/cities lists the cities a donor can add (static, no object call).
// Limits: Monobank allows one call a minute per endpoint; it polls every 3 minutes while someone looked at the page in
// the last 2 hours, else every 30 minutes, and backs off on 429 (rate limit) and on an edge block (403 with an HTML body).
import { CITIES, EXTRA_CITIES, matchCity, matchMarked, commentFor, extraCity } from './votes-core.mjs';
const FAST = 180, SLOW = 1800, WINDOW = 2682000, HOLD_DAYS = 7;   // the statement window is at most 31 days + 1 hour
const LOOK = 2 * 86400, DEEP = 6 * 3600;   // every poll re-reads the last 2 days (a top-up can enter the statement hours after its own time: a card transfer from
// another bank, a pending one that settles under a new id), and every 6 hours the last HOLD_DAYS + 1 days; ids make a re-read count nothing twice
const api = env => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.MONO_API || '') ? env.MONO_API : 'https://api.monobank.ua';   // a local mock only, for tests
const clock = env => api(env) === 'https://api.monobank.ua' ? 1 : 0.03;   // a local mock runs the clock 30x faster
const BACKOFF = /rate limited|blocked|refused|bank error|^error/;   // states that set their own wait: a page view never cuts it short
export const jarKey = v => String(v || '').trim().replace(/^https?:\/\/send\.monobank\.ua\//, '').replace(/^jar\//, '').split(/[?#]/)[0];   // 'jar/X', the full link or X -> X
const zero = () => ({ general: { uah: 0, donations: 0 }, assigned: 0, cities: CITIES.map(c => ({ slug: c.slug, name: c.name, comment: commentFor(c), uah: 0, donations: 0 })), add: { cities: [] } });
const addGoal = env => { const n = Math.floor(+String(env.ADD_CITY_UAH ?? '').replace(/[\s,]/g, '')); return n > 0 ? n : 5000; };   // hryvnias for an off-route city to be added ('5 000', '2,500'; else 5000)
const ROUTE = new Set(CITIES.map(c => c.slug));
const LIST = CITIES.map(c => c.slug).join() + '|' + EXTRA_CITIES.length + ':' + EXTRA_CITIES.reduce((h, c) => (h * 31 + [...c.slug].reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 0)) | 0, 0);   // the city lists of this deploy: a new one re-sums the totals
// VOTE_ASSIGN (a Worker secret: npx wrangler secret put VOTE_ASSIGN; it names donors' amounts and times, so keep it out of wrangler.toml): a top-up whose comment got lost (a transfer by card number from another bank can arrive without it),
// assigned by hand from the donor's receipt: 'YYYY-MM-DDTHH:MM[|YYYY-MM-DDTHH:MM]/<kopecks>/<slug>;...',
// the minute in UTC; a receipt of unknown time zone lists each possible minute in one entry, so it counts once. Per entry, when the totals are summed:
// exactly one top-up with no city, of exactly that amount, within 3 minutes of one of its minutes -> it moves from the general pot to the city;
// none (not in the statement yet, still pending, or the entry is off) or several -> nothing: an entry only moves money the jar got, never adds any.
// Never stored: removing an entry undoes it. The page sees only how many entries matched ('assigned').
export const parseAssign = v => String(v || '').split(/[;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
  const [ts, kop, slug] = s.split('/'), times = String(ts || '').split(/[|,]/).map(x => /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(x.trim()) ? Date.parse(x.trim() + ':00Z') / 1000 : NaN);
  const amount = /^\d+$/.test(kop || '') ? +kop : 0, sl = String(slug || '').trim().replace(/^x:/, ''), key = ROUTE.has(sl) ? sl : extraCity(sl) ? 'x:' + sl : null;
  return times.length && times.every(t => t > 0) && amount > 0 && key ? { times, amount, key } : null; }).filter(Boolean);
const listKey = env => LIST + '|' + String(env.VOTE_ASSIGN || '').trim();   // a new VOTE_ASSIGN re-sums too
const addOut = (c, goal) => { const x = extraCity(c.slug), kop = c.kop ?? c.uah * 100; return x && { slug: x.slug, name: x.name, comment: x.comment, uah: c.uah, donations: c.donations, reached: kop >= goal * 100 }; };   // current name; reached on the exact kopecks

export class Votes {
  constructor(state, env) {
    this.state = state; this.env = env; this.S = state.storage; this.sql = state.storage.sql; this.viewed = 0;
    this.sql.exec('CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, time INTEGER NOT NULL, amount INTEGER NOT NULL, city TEXT, how TEXT)');
  }
  async fetch() {
    const now = Date.now(), st = (await this.S.get('status')) || {}, al = await this.S.getAlarm();
    if (now - this.viewed > 300e3) { this.viewed = now; await this.S.put('viewed', now); }   // at most one write in 5 minutes, however many people look
    if (!al || al < now - 60e3) await this.S.setAlarm(now + 1000);   // the first look starts the polling (also an alarm that never ran, as after a local reload)
    else if (al - now > FAST * 1000 * clock(this.env) && !BACKOFF.test(st.state || '') && now - (st.at || 0) > 65e3) await this.S.setAlarm(Math.max(now + 1000, (st.at || 0) + 65e3));   // after a quiet spell or a config change: poll soon, still one bank call a minute
    return Response.json(await this.totals(), { headers: { 'cache-control': 'public, max-age=60' } });
  }
  async totals() {   // two reads: the totals are summed once per poll that changed them (saveTotals), never per view
    const env = this.env, want = jarKey(env.MONO_JAR), st = (await this.S.get('status')) || { state: 'starting' }, jarFor = await this.S.get('jarFor');
    const open = !!(env.MONO_TOKEN && want && jarFor === want), counting = open && st.state === 'ok' && Date.now() - (st.ok || 0) < 15 * 60e3;   // open: the token found this jar among the owner's jars
    const t = (open && (await this.S.get('totals'))) || zero(), goal = addGoal(env), pending = (open && (await this.S.get('pending'))) || { uah: 0, donations: 0 };   // pending: top-ups the bank still holds (sum and count only)   // the goal is read per view, so a new ADD_CITY_UAH applies at once
    const add = { goal, cities: (t.add?.cities || []).map(c => addOut(c, goal)).filter(Boolean) };   // totals saved before 'add' existed have none; a city no longer in the list is left out (its money moves on the next poll)
    return { open, counting, jar: open ? want : null, state: st.state, updated: st.ok || null, ...t, assigned: t.assigned || 0, pending, add };
  }
  async saveTotals() {
    const by = {}, put = (k, r) => { const o = by[k] ||= { sum: 0, n: 0 }; o.sum += r.sum || 0; o.n += r.n || 0; };
    for (const r of this.sql.exec('SELECT city, SUM(amount) AS sum, COUNT(*) AS n FROM tx GROUP BY city')) { const k = r.city ?? '', x = k.startsWith('x:') ? k.slice(2) : null;
      put(x && ROUTE.has(x) ? x : x && !extraCity(x) ? '' : k, r); }   // an added city that became a route stop (same slug) counts for it; one gone from the list, for the general pot
    let assigned = 0; const claimed = new Set();
    for (const a of parseAssign(this.env.VOTE_ASSIGN)) {   // a receipt assigned by hand (see parseAssign): move the one match, else nothing
      const ids = new Set(); for (const t of a.times) for (const r of this.sql.exec('SELECT id FROM tx WHERE city IS NULL AND amount = ? AND time >= ? AND time < ?', a.amount, t - 180, t + 240)) if (!claimed.has(r.id)) ids.add(r.id);
      if (ids.size !== 1) continue; assigned++; claimed.add([...ids][0]);   // the minute ±3 min (the minute's own 60 s included)
      put(a.key, { sum: a.amount, n: 1 }); put('', { sum: -a.amount, n: -1 });
    }
    const uah = k => Math.round((by[k]?.sum || 0) / 100), t = zero(); t.assigned = assigned;
    t.general = { uah: uah(''), donations: by['']?.n || 0 }; for (const c of t.cities) { c.uah = uah(c.slug); c.donations = by[c.slug]?.n || 0; }
    for (const k in by) { const c = k.startsWith('x:') && extraCity(k); if (c) t.add.cities.push({ slug: c.slug, name: c.name, comment: c.comment, uah: uah(k), kop: by[k].sum, donations: by[k].n }); }
    t.add.cities = t.add.cities.sort((a, b) => b.kop - a.kop || b.donations - a.donations || a.name.localeCompare(b.name, 'uk')).slice(0, 30);
    await this.S.put({ totals: t, listFor: listKey(this.env) });
  }
  async alarm() {
    let next = FAST;
    try { next = await this.poll(); } catch (e) { await this.status({ state: 'error', err: String(e && e.message || e).slice(0, 100) }); next = 600; }
    const idle = Date.now() - ((await this.S.get('viewed')) || 0) > 2 * 3600e3;
    await this.S.setAlarm(Date.now() + Math.max(next, idle ? SLOW : 0) * 1000 * clock(this.env));
  }
  async status(s) { const old = (await this.S.get('status')) || {}; await this.S.put('status', { ...old, ...s, at: Date.now() }); }
  async refused(r, what) {   // never reads the body into a log or a status: it can hold account data
    const html = (r.headers.get('content-type') || '').includes('html');
    if (r.status === 429) { const s = +(r.headers.get('x-rate-limit-retry-after-seconds') || r.headers.get('retry-after') || 0); await this.status({ state: 'rate limited' }); return Math.max(65, s || 120); }
    if (r.status === 403 && html) { await this.status({ state: 'blocked by the bank edge, retry in 6 h' }); return 6 * 3600; }
    if (r.status === 401 || r.status === 403) { await this.status({ state: 'token refused' }); return 3600; }
    await this.status({ state: `bank error ${r.status} (${what})` }); return 600;   // a redirect (3xx) lands here too: the token never follows it
  }
  async poll() {
    const env = this.env, S = this.S, now = Math.floor(Date.now() / 1000), base = api(env), want = jarKey(env.MONO_JAR), get = { headers: { 'X-Token': env.MONO_TOKEN || '' }, redirect: 'manual' };
    if (!env.MONO_TOKEN || !want) { await this.status({ state: 'not configured' }); return 3600; }
    if ((await S.get('jarFor')) !== want || !(await S.get('jarId'))) {   // once per jar: its account id, from the link id
      const r = await fetch(base + '/personal/client-info', get); if (!r.ok) return this.refused(r, 'client-info');
      const jar = ((await r.json()).jars || []).find(j => jarKey(j.sendId) === want);
      if (!jar) { await this.status({ state: 'jar not found' }); return 3600; }
      if (jar.currencyCode !== 980) { await this.status({ state: 'the jar is not in hryvnias' }); return 3600; }
      if ((await S.get('jarFor')) !== want) { this.sql.exec('DELETE FROM tx'); await S.delete(['newest', 'page', 'start', 'startFor', 'holdFrom', 'seen', 'probe', 'probed', 'pending', 'deepAt']); }   // another jar: its own count from zero
      await S.put({ jarId: jar.id, jarFor: want }); await this.saveTotals(); await this.status({ state: 'jar found' }); return 65;   // the statement call goes in the next minute
    }
    const cfg = String(env.VOTE_START || ''); let start = await S.get('start');
    if (!start || (await S.get('startFor')) !== cfg) {   // VOTE_START rules when set (a change re-reads from it); else the first run's time
      start = +cfg || now; this.sql.exec('DELETE FROM tx WHERE time < ?', start); await S.delete(['newest', 'page', 'holdFrom', 'seen', 'probe', 'probed', 'pending', 'deepAt']);
      await S.put({ start, startFor: cfg }); await this.saveTotals();
    }
    if ((await S.get('listFor')) !== listKey(env)) await this.saveTotals();   // a deploy changed the city lists or VOTE_ASSIGN: re-sum without waiting for a top-up
    const jarId = await S.get('jarId'), page = await S.get('page'), holdFrom = await S.get('holdFrom'), floor = Math.max(now - WINDOW + 60, start), probe = await S.get('probe');
    if (probe) {   // the start was before the jar existed: a binary search for the earliest 'from' the bank accepts (no top-up is older), one call a minute
      const mid = Math.ceil((probe.lo + probe.hi) / 2), r = await fetch(`${base}/personal/statement/${encodeURIComponent(jarId)}/${mid}/${now}`, get);
      if (r.status === 400) probe.lo = mid; else if (r.ok) probe.hi = mid; else return this.refused(r, 'statement');
      if (probe.hi - probe.lo <= 60) { await S.put({ start: probe.hi, probed: true }); await S.delete('probe'); } else await S.put('probe', probe);
      await this.status({ state: 'finding when the jar was made' }); return 65;
    }
    const deep = page ? !!page.deep : now - ((await S.get('deepAt')) || 0) > DEEP;   // the 8-day re-read, one in 6 hours
    let from = page ? page.from : Math.max(Math.min(((await S.get('newest')) || start) - 3600, now - (deep ? (HOLD_DAYS + 1) * 86400 : LOOK)), floor); if (!page && holdFrom) from = Math.max(Math.min(from, holdFrom), floor);   // from the newest seen (after a long pause too) or the last 2 days, whichever is older; back to a pending top-up until it settles
    const to = page ? page.to : now, r = await fetch(`${base}/personal/statement/${encodeURIComponent(jarId)}/${from}/${to}`, get);
    if (r.status === 400 && !page && !(await S.get('seen')) && !(await S.get('probed'))) { await S.put('probe', { lo: from, hi: to }); await this.status({ state: 'finding when the jar was made' }); return 65; }   // 'from' out of bounds
    if (!r.ok) return this.refused(r, 'statement');
    const items = await r.json(); if (!Array.isArray(items)) { await this.status({ state: 'bank sent no list' }); return 600; }
    let added = 0, changed = 0, newest = (await S.get('newest')) || 0, oldest = Infinity, hold = page?.hold ?? Infinity; const pend = page?.pend || { sum: 0, n: 0 };
    for (const it of items) {
      if (typeof it.id !== 'string' || !(it.time >= start)) continue; oldest = Math.min(oldest, it.time); newest = Math.max(newest, it.time);
      if (!(it.amount > 0)) continue;   // money in; withdrawals never take votes away. 'amount' is in the jar's currency (hryvnias, checked at client-info):
      // a top-up from a card in euros or dollars (currencyCode = the payment's currency) counts at what the jar got
      const cur = [...this.sql.exec('SELECT amount FROM tx WHERE id = ?', it.id)];
      if (it.hold) { if (it.time > now - HOLD_DAYS * 86400) { hold = Math.min(hold, it.time); if (!cur.length) { pend.sum += it.amount; pend.n++; } } continue; }   // pending: it counts once it settles (a cancelled one never does); the page sees the sum and count
      if (!cur.length) { let m = matchCity(it.comment || ''); if (!m.city) { const d = matchMarked(it.description || ''); if (d.city) m = { city: d.city, how: 'desc' }; }   // only «Місто: …» from the bank's own line, never a bare word (it can hold a name); the text is never stored
        this.sql.exec('INSERT INTO tx (id, time, amount, city, how) VALUES (?, ?, ?, ?, ?)', it.id, it.time, it.amount, m.city, m.how); added++; }
      else if (cur[0].amount !== it.amount) { this.sql.exec('UPDATE tx SET amount = ? WHERE id = ?', it.amount, it.id); changed++; }
    }
    const full = items.length >= 500 && oldest > from && oldest < Infinity;   // a full page: the older part next
    if (full) await S.put('page', { from, to: oldest, hold, pend, deep }); else {
      await S.delete('page'); if (hold < Infinity) await S.put('holdFrom', hold); else await S.delete('holdFrom'); if (deep) await S.put('deepAt', now);
      const p = { uah: Math.round(pend.sum / 100), donations: pend.n }, old = (await S.get('pending')) || {}; if (old.uah !== p.uah || old.donations !== p.donations) await S.put('pending', p); }
    if (added || changed) await this.saveTotals();
    await S.put({ newest, seen: true }); await this.status({ state: 'ok', ok: Date.now(), added, err: null });
    return full ? 65 : FAST;
  }
}

// The Worker's route: GET /api/votes -> the totals, cached 60 s at the edge so a crowd never reaches the bank
export async function votesRoute(req, env) {
  if (!env.VOTES) return new Response('not found', { status: 404 });
  const hdr = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' };
  const key = new Request('https://votes.cache/v3'), cache = caches.default, hit = await cache.match(key); if (hit) return hit;   // v2: with 'add'; v3: with 'pending' and 'assigned'
  let out;
  try { const res = await env.VOTES.get(env.VOTES.idFromName('main')).fetch('https://votes/'); out = new Response(await res.text(), { status: res.status, headers: hdr }); }
  catch { out = new Response(JSON.stringify({ open: false, counting: false, state: 'unavailable', pending: { uah: 0, donations: 0 }, assigned: 0, add: { goal: addGoal(env), cities: [] } }), { status: 503, headers: { ...hdr, 'cache-control': 'public, max-age=30' } }); }   // a broken object: a short cached 503, not one call per visitor
  if (out.ok || out.status === 503) await cache.put(key, out.clone()).catch(() => {}); return out;
}

// GET /api/votes/cities -> { cities: [[slug, name], ...] }: every off-route city a donor can add, by name (the order of votes-extra.mjs).
// The page sends exactly 'Місто: ' + name. Static for a deploy: built once, no object call, cached a day.
let citiesBody = null;
export function votesCitiesRoute(req, env) {
  if (!env.VOTES) return new Response('not found', { status: 404 });
  citiesBody ??= JSON.stringify({ cities: EXTRA_CITIES.map(c => [c.slug, c.name]) });
  return new Response(citiesBody, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' } });
}
