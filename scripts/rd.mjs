// Step 3b: quote and generate the art with RetroDiffusion (https://www.retrodiffusion.ai?ref=YBQJM823, affiliate link).
//   node rd.mjs quote --trip TRIP                       free: asks the API what each picture costs (check_cost)
//   node rd.mjs run   --trip TRIP --budget 9.50         generates, never spending past the budget
//   node rd.mjs run   --trip TRIP --budget 9.50 --regen NAME,NAME   a new attempt (new seed) at pictures that failed review
//   node rd.mjs spent --trip TRIP                       what this trip has spent so far
// Options: --only NAME,NAME   --parallel 3   --shared DIR (a folder of finished pictures shared by several trips:
//          an identical job already made for another trip is copied, not paid for again)
// The key: RETRODIFFUSION_API_KEY in the environment, or the macOS Keychain (see lib.mjs rdKey). It is read at request
// time and never printed, logged or written to disk.
//
// API (RetroDiffusion's public docs, checked October 2026):
//   POST https://api.retrodiffusion.ai/v2/inferences, header X-RD-Token: <key>
//   body { prompt, prompt_style, width, height, num_images, seed?, remove_bg?, input_palette? (base64 PNG), check_cost? }
//   check_cost: true returns { balance_cost, remaining_balance } and generates nothing (free).
//   A paid call returns { base64_images, balance_cost, remaining_balance }; some return { task_id }, polled at
//   GET /v2/inferences/tasks/<id>. An Idempotency-Key makes a retried call return the first result without a new charge.
// Ledger: TRIP/art/ledger.json records every paid job: reserved before the call, settled after. A crash or a rerun
// never pays twice for a finished picture, and --budget counts everything this trip has already spent.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { args, readJSON, writeJSON, sleep, rdKey } from './lib.mjs';

const A = args(), cmd = A._[0], TRIP = A.trip;
if (!['quote', 'run', 'spent'].includes(cmd) || !TRIP) { console.error('usage: node rd.mjs quote|run|spent --trip TRIP [--budget USD] [--only a,b] [--regen a,b]'); process.exit(1); }
const ART = join(TRIP, 'art'), RAW = join(ART, 'raw'), LEDGER = join(ART, 'ledger.json'), SHARED = A.shared || process.env.PIXEL_PATH_SHARED || null;
const plan = readJSON(join(ART, 'plan.json')); if (!plan && cmd !== 'spent') throw Error('no art/plan.json: run plan-art.mjs first');
const ledger = readJSON(LEDGER, { spent: 0, jobs: {}, attempts: {} }); ledger.attempts ||= {};
const save = () => { ledger.spent = +Object.values(ledger.jobs).reduce((s, j) => s + (j.failed || j.shared ? 0 : (j.cost ?? j.reserved ?? 0)), 0).toFixed(4); writeJSON(LEDGER, ledger, true); };
if (cmd === 'spent') { save(); console.log(`spent $${ledger.spent.toFixed(2)} on ${Object.values(ledger.jobs).filter(j => j.done && !j.shared).length} pictures`); process.exit(0); }

function key() {
  const k = rdKey(); if (k) return k;
  console.error(`No RetroDiffusion key found.
  1. Make a RetroDiffusion account and buy credit: https://www.retrodiffusion.ai?ref=YBQJM823 (affiliate link)
  2. Create an API key in your account settings.
  3. In your own terminal (never paste it into a chat): export RETRODIFFUSION_API_KEY=...
     or on a Mac keep it in the Keychain: security add-generic-password -s pixel-path -a retrodiffusion -w
Or skip paid art: node placeholder-art.mjs --trip ${TRIP}`);
  process.exit(3);
}
async function api(body, idem, path = 'inferences') {
  let last = '';
  for (let n = 0; n < 6; n++) {
    let r;
    try { r = await fetch('https://api.retrodiffusion.ai/v2/' + path, { method: body ? 'POST' : 'GET', headers: { 'X-RD-Token': key(), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) }); }
    catch (e) { last = e.message; await sleep(5000); continue; }
    if (r.status === 429 || r.status >= 500) { last = 'HTTP ' + r.status; await sleep(8000 * (n + 1)); continue; }
    if (r.status === 401 || r.status === 403) throw Error(`HTTP ${r.status}: the API key was refused (check the key)`);
    if (r.status === 402) throw Error('HTTP 402: not enough RetroDiffusion credit');
    if (!r.ok) throw Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw Error('RetroDiffusion did not answer: ' + last);
}
const b64 = p => readFileSync(p).toString('base64');
const attempt = j => ledger.attempts[j.name] || 0;
const bodyOf = j => ({ prompt: j.prompt, prompt_style: j.style, width: j.width, height: j.height, num_images: 1, seed: (j.seed + attempt(j) * 7919) % 2147483647, ...(j.remove_bg ? { remove_bg: true } : {}), ...(j.palette && existsSync(j.palette) ? { input_palette: b64(j.palette) } : {}) });
const idOf = body => createHash('sha256').update(JSON.stringify({ ...body, input_palette: body.input_palette ? createHash('sha1').update(body.input_palette).digest('hex') : null })).digest('hex').slice(0, 24);
const regen = new Set(A.regen ? A.regen.split(',') : []);
// in a shared folder, a picture is also filed by name and prompt (any seed), so a re-roll made for one trip serves the others
const nameKey = j => createHash('sha256').update(JSON.stringify([j.name, j.prompt, j.style, j.width, j.height])).digest('hex').slice(0, 24);
const sharedFile = (j, id) => !SHARED || regen.has(j.name) ? null : existsSync(join(SHARED, 'n-' + nameKey(j) + '.png')) ? join(SHARED, 'n-' + nameKey(j) + '.png') : existsSync(join(SHARED, id + '.png')) ? join(SHARED, id + '.png') : null;   // the latest picture made for this name and prompt first
if (cmd === 'run') for (const n of regen) ledger.attempts[n] = (ledger.attempts[n] || 0) + 1;   // a new seed: a different picture
const only = A.only || A.regen ? new Set((A.only || A.regen).split(',')) : null, jobs = plan.jobs.filter(j => !only || only.has(j.name));

if (cmd === 'quote') {
  let total = 0, todo = 0, cached = 0; const rows = []; let balance = null;
  for (const j of jobs) {
    const body = bodyOf(j), id = idOf(body), prior = ledger.jobs[id];
    if (prior?.done) { rows.push(`  ${j.name.padEnd(22)} done`); continue; }
    if (sharedFile(j, id)) { rows.push(`  ${j.name.padEnd(22)} in the shared folder ($0)`); cached++; continue; }
    const q = await api({ ...body, check_cost: true }), c = Number(q.balance_cost); if (!(c >= 0)) throw Error('bad quote for ' + j.name); if (q.remaining_balance != null) balance = Number(q.remaining_balance);
    total += c; todo++; rows.push(`  ${j.name.padEnd(22)} $${c.toFixed(3)}  ${j.style} ${j.width}x${j.height}`);
  }
  console.log(rows.join('\n'));
  console.log(`To generate: ${todo} pictures, $${total.toFixed(2)}${cached ? ` (${cached} more come free from the shared folder)` : ''}. Already spent on this trip: $${ledger.spent.toFixed(2)}.${balance != null ? ` Account balance: $${balance.toFixed(2)}.` : ''}`);
  if (balance != null && balance < total) console.log(`NOTE: the account balance ($${balance.toFixed(2)}) is less than the quote; add credit at https://www.retrodiffusion.ai?ref=YBQJM823 (affiliate link) or plan a smaller --detail.`);
  console.log(`Suggested budget with a 25% reserve for re-rolls (10 to 35% of pictures came back unusable in tests): $${(Math.ceil((total * 1.25 + ledger.spent) * 10) / 10).toFixed(2)}`);
  console.log(`Ask the user to confirm a budget, then: node rd.mjs run --trip ${TRIP} --budget <USD>`);
  writeJSON(join(ART, 'quote.json'), { at: new Date().toISOString(), total, todo, balance, detail: plan.detail }, true);
  process.exit(0);
}

// ---- run
const BUDGET = Number(A.budget);
if (!(BUDGET > 0)) { console.error('run needs --budget USD (the total this trip may spend, including what it already spent). Quote first.'); process.exit(1); }
ledger.budget = BUDGET; mkdirSync(RAW, { recursive: true }); let stopped = false;
async function runJob(j) {
  if (stopped) return; const body = bodyOf(j), id = idOf(body), prior = ledger.jobs[id], out = join(RAW, j.name + '.png');
  if (prior?.done && existsSync(out) && !regen.has(j.name)) return console.log(`skip ${j.name} (done)`);
  if (prior?.done && prior.file && existsSync(join(ART, prior.file))) { copyFileSync(join(ART, prior.file), out); return console.log(`reuse ${j.name} (paid earlier)`); }
  if (sharedFile(j, id)) { copyFileSync(sharedFile(j, id), out); ledger.jobs[id] = { name: j.name, done: true, shared: true, file: `raw/${j.name}.png` }; save(); return console.log(`shared ${j.name} ($0)`); }
  let task;
  if (prior?.task_id && !prior.failed) task = { task_id: prior.task_id };                     // paid earlier, still running: resume
  else if (prior?.reserved && !prior.failed && !prior.done) task = await api(body, prior.idem || id);   // same Idempotency-Key: the earlier result, no new charge
  else {
    const q = await api({ ...body, check_cost: true }), cost = Number(q.balance_cost);
    save(); const reserved = Object.values(ledger.jobs).filter(x => !x.done && !x.failed && x.reserved).reduce((s, x) => s + x.reserved, 0);
    if (ledger.spent + cost > BUDGET + 1e-9) { console.log(`STOP: ${j.name} costs $${cost.toFixed(3)}; spent $${ledger.spent.toFixed(2)} of the $${BUDGET.toFixed(2)} budget (${reserved ? `$${reserved.toFixed(2)} still in flight` : 'nothing in flight'})`); stopped = true; return; }
    if (q.remaining_balance != null && Number(q.remaining_balance) < cost) { console.log(`STOP: the RetroDiffusion balance ($${Number(q.remaining_balance).toFixed(2)}) is below the price of ${j.name} ($${cost.toFixed(2)}). Add credit, then rerun: finished pictures are kept.`); stopped = true; return; }
    const idem = prior?.failed ? `${id}-${Date.now()}` : id;
    ledger.jobs[id] = { name: j.name, reserved: cost, done: false, idem, at: new Date().toISOString() }; save();   // reserve before the paid call
    task = await api(body, idem);
  }
  if (task.task_id) { ledger.jobs[id].task_id = task.task_id; save(); }
  let res = task.base64_images?.length ? task : null;
  for (let n = 0; !res && task.task_id && n < 150; n++) {
    const t = await api(null, null, 'inferences/tasks/' + encodeURIComponent(task.task_id));
    if (t.status === 'failed') { ledger.jobs[id].failed = true; save(); return console.log(`FAILED ${j.name} (not charged); rerun to try again`); }
    if (t.status === 'succeeded') { res = t.result; break; }
    await sleep(4000);
  }
  if (!res) return console.log(`still running ${j.name}; rerun later to collect it (no new charge)`);
  writeFileSync(out, Buffer.from(res.base64_images[0], 'base64'));
  if (SHARED) { mkdirSync(SHARED, { recursive: true }); copyFileSync(out, join(SHARED, id + '.png')); copyFileSync(out, join(SHARED, 'n-' + nameKey(j) + '.png')); }
  ledger.jobs[id] = { ...ledger.jobs[id], cost: Number(res.balance_cost ?? ledger.jobs[id].reserved), done: true, file: `raw/${j.name}.png`, attempt: attempt(j) }; save();
  console.log(`done ${j.name}: $${ledger.jobs[id].cost.toFixed(3)} (trip total $${ledger.spent.toFixed(2)} of $${BUDGET.toFixed(2)}${res.remaining_balance != null ? `, balance $${Number(res.remaining_balance).toFixed(2)}` : ''})`);
}
// a few at a time: one process, one ledger, every job reserved before it is paid for
{ const queue = [...jobs], P = Math.max(1, Math.min(4, +(A.parallel || 3))); await Promise.all(Array.from({ length: P }, async () => { while (queue.length && !stopped) await runJob(queue.shift()); })); }
save(); console.log(`Spent $${ledger.spent.toFixed(2)} of $${BUDGET.toFixed(2)}.${stopped ? ' Stopped early (see above).' : ''} Next: node clean.mjs --trip ${TRIP}`);
process.exit(stopped ? 2 : 0);
