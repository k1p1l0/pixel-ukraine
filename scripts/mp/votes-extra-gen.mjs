#!/usr/bin/env node
// Writes votes-extra.mjs: the cities and towns a donor can add to the route (Ukraine branch), every place=city and place=town
// of Ukraine that is not one of the 20 route stops, with the names a donor may write after «Місто:». No dependencies (Node 20).
//   node votes-extra-gen.mjs --trip ~/Projects/pixel-path-ukraine/trips/ukraine-loop [--overpass http://127.0.0.1:12345/api/interpreter]
//   node votes-extra-gen.mjs --outline FILE [--overpass URL | --osm SAVED.json] [--verbose] [--allow-slug-change]
// Source: an Overpass server with the Ukraine extract (the local one by default; area queries do not work there, so the outline
// TRIP/data/outline.json keeps the nodes inside Ukraine, Crimea included). Then check: node votes-test.mjs
// Slugs are the stored keys of the donations ('x:<slug>' in the Votes object), so a rerun keeps each place's slug by its OSM
// node id, and refuses to write when a slug would disappear or move to another place. --allow-slug-change lets it, only
// while the jar has no donations for that slug. A place that became a route stop may leave the list: votes.mjs then counts
// its money for the route stop with the same slug (give the new stop in CITIES this slug).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const A = Object.fromEntries(process.argv.slice(2).map((a, i, v) => a.startsWith('--') ? [a.slice(2), v[i + 1] && !v[i + 1].startsWith('--') ? v[i + 1] : true] : []).filter(x => x.length));
const OUTLINE = A.outline || (A.trip && join(A.trip, 'data', 'outline.json')), HOST = A.overpass || 'http://127.0.0.1:12345/api/interpreter';
if (!OUTLINE || OUTLINE === true) { console.error('usage: node votes-extra-gen.mjs --trip TRIP | --outline FILE [--overpass URL]'); process.exit(1); }
const OUT = fileURLToPath(new URL('./votes-extra.mjs', import.meta.url));
if (!existsSync(OUT)) writeFileSync(OUT, 'export const EXTRA = [];\n');   // votes-core.mjs imports it: a stub on the very first run
const { CITIES, normalize, aliasKeys } = await import('./votes-core.mjs');
const { EXTRA: PREV } = await import('./votes-extra.mjs');   // the list before this run: its slugs must stay

// The names a donor may write: the Ukrainian name first. Tags can hold several values ("Кіровоград;Єлисаветград").
const TAGS = ['name:uk', 'name', 'renamed', 'hand', 'name:ru', 'name:en', 'old_name', 'old_name:uk', 'old_name:ru', 'alt_name', 'alt_name:uk', 'official_name:uk'];
const lev = (a, b) => { let d = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { const e = [i]; for (let j = 1; j <= b.length; j++) e[j] = Math.min(d[j] + 1, e[j - 1] + 1, d[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); d = e; } return d[b.length]; };
const near = (a, b) => lev(a.replace(/ /g, ''), b.replace(/ /g, '')) <= Math.max(2, Math.round(0.3 * b.length));   // Ивановка ~ Іванівка, Pulyny ~ Пулини
const OWNTAGS = ['name:ru', 'name:en', 'hand'];   // a place's own names in other spellings: they go before other places' old names
const LETTERS = 'abcdefghijklmnopqrstuvwxyzабвгґдеєжзиіїйклмнопрстуфхцчшщьъюяыэё';   // the letters normalize() reads: 'Stanisławów' would come out as 'stanis awow'
const readable = v => [...v.normalize('NFKC').toLowerCase()].every(ch => !/\p{L}/u.test(ch) || LETTERS.includes(ch));
const BIG = ['Запоріжжя', 'Кривий Ріг', 'Миколаїв', 'Полтава', 'Житомир', 'Черкаси', 'Хмельницький', 'Рівне', 'Тернопіль', 'Івано-Франківськ', 'Кропивницький', 'Біла Церква', 'Кременчук', 'Мелітополь', 'Бердянськ', 'Краматорськ', "Слов'янськ", 'Бахмут', 'Ніжин', 'Умань', 'Бровари', 'Ірпінь', 'Буча', 'Ковель', 'Мукачево', 'Сімферополь', 'Євпаторія', 'Феодосія'];
// Crimean towns that Ukraine renamed in 2016 and OSM still names in the Soviet form (name:uk too), by wikidata id -> the
// Ukrainian name. The OSM name becomes an old name like any other, so an old name that several places share is dropped.
const RENAME = { Q2626751: 'Іслям-Терек', Q2367699: 'Курман', Q1984515: 'Біюк-Онлар', Q2046367: 'Бакачик-Кият', Q2011781: 'Албат', Q3847642: 'Кизилташ', Q3063980: 'Долосси' };
// Hand-written forms for the biggest places: the case forms a donor types after «Місто:» (Полтави, Кривому Розі) and the
// usual English and Russian spellings OSM lacks. They rank as the place's own names; the clash checks below still apply.
const HAND = {
  'Запоріжжя': 'Запоріжжі;Запоріжжю;Запорожья;Zaporizhia;Zaporizhya;Zaporozhye;Zaporozhe', 'Кривий Ріг': 'Кривого Рогу;Кривому Розі;Кривий Рог;Кривого Рога;Krivoy Rog;Kryvyy Rih;Krivyi Rih',
  'Миколаїв': 'Миколаєва;Миколаєві;Миколаєву;Николаева;Mykolayiv;Mykolaev;Nikolaev;Nikolayev', 'Полтава': 'Полтави;Полтаву;Полтаві;Полтавы', 'Житомир': 'Житомира;Житомирі;Житомиру;Zhitomir',
  'Черкаси': 'Черкас;Черкасах;Cherkassy', 'Хмельницький': 'Хмельницького;Хмельницькому;Хмельницкого;Khmelnitsky;Khmelnitskiy;Khmelnytsky;Khmelnytskyy', 'Рівне': 'Рівного;Рівному;Ровно;Rovno',
  'Тернопіль': 'Тернополя;Тернополі;Тернополь;Ternopol', 'Івано-Франківськ': 'Івано-Франківська;Івано-Франківську;Франківськ;Франківська;Ivano-Frankovsk',
  'Кропивницький': 'Кропивницького;Кропивницькому;Кіровограда;Kirovograd;Kirovohrad;Kropivnitsky', 'Біла Церква': 'Білої Церкви;Білу Церкву;Білій Церкві;Belaya Tserkov',
  'Кременчук': 'Кременчука;Кременчуці;Кременчуку;Kremenchug', 'Мелітополь': 'Мелітополя;Мелітополі', 'Бердянськ': 'Бердянська;Бердянську;Berdyansk', 'Краматорськ': 'Краматорська;Краматорську',
  "Слов'янськ": "Слов'янська;Слов'янську;Slavyansk;Slovyansk", 'Бахмут': 'Бахмута;Бахмуті;Артемівськ;Артемовск;Artemivsk;Artemovsk', 'Ніжин': 'Ніжина;Ніжині;Nezhin', 'Умань': 'Умані',
  'Бровари': 'Броварів;Броварах', 'Ірпінь': 'Ірпеня;Ірпені;Irpen', 'Буча': 'Бучі;Бучу', 'Ковель': 'Ковеля;Ковелі', 'Мукачево': 'Мукачева;Мукачеві', 'Сімферополь': 'Сімферополя;Сімферополі',
  'Євпаторія': 'Євпаторії;Євпаторію;Yevpatoria;Evpatoria;Yevpatoriya', 'Феодосія': 'Феодосії;Феодосію;Feodosia;Feodosiya', "Кам'янське": "Кам'янського;Kamyanske;Kamenskoe",
  'Покровськ': 'Покровська;Покровську;Красноармійськ;Красноармейск;Krasnoarmeysk', 'Ізюм': 'Ізюма;Izyum', 'Чорноморськ': 'Іллічівськ;Ильичевск;Illichivsk', 'Нікополь': 'Нікополя;Нікополі',
  'Павлоград': 'Павлограда;Павлограді', 'Горлівка': 'Горлівки;Горлівку;Gorlovka', 'Макіївка': 'Макіївки;Макіївку;Makeevka;Makeyevka', 'Сіверськодонецьк': 'Сіверськодонецька;Сєвєродонецька;Severodonetsk',
  'Лисичанськ': 'Лисичанська;Lisichansk', 'Бориспіль': 'Борисполя;Борисполі;Borispol', 'Бердичів': 'Бердичева;Berdichev', 'Енергодар': 'Енергодара;Energodar',
};

const rings = JSON.parse(readFileSync(OUTLINE, 'utf8')).rings;
if (!Array.isArray(rings) || !rings.length) throw Error(`${OUTLINE} has no rings`);
const inside = (lon, lat) => rings.reduce((c, r) => { for (let i = 0, k = r.length - 1; i < r.length; k = i++) { const [xi, yi] = r[i], [xk, yk] = r[k]; if ((yi > lat) !== (yk > lat) && lon < (xk - xi) * (lat - yi) / (yk - yi) + xi) c = !c; } return c; }, false);   // even-odd over all rings

const q = '[out:json][timeout:180];(node[place=city];node[place=town];);out body;';
const res = A.osm ? null : await fetch(HOST, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(240e3) });
if (res && !res.ok) throw Error(`overpass ${HOST}: HTTP ${res.status}`);
const text = A.osm ? readFileSync(A.osm, 'utf8') : await res.text();   // --osm FILE: a saved answer of this query
if (!text.trimStart().startsWith('{')) throw Error(`overpass ${HOST}: no JSON (${(text.match(/Error<\/strong>:([^<]*)/) || [, text.slice(0, 120)])[1].trim()})`);   // Overpass sends its errors as HTML with status 200
const osm = JSON.parse(text); if (osm.remark && /error|timed out|runtime/i.test(osm.remark)) throw Error(`overpass: ${osm.remark}`);
const nodes = (osm.elements || []).filter(e => e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon) && e.tags);

const ROUTE = new Map(); for (const c of CITIES) for (const a of c.aliases) for (const k of aliasKeys(a)) ROUTE.set(k, c.slug);
const pop = t => +String(t.population || '').replace(/[\s,]/g, '').match(/^\d+/)?.[0] || 0;
const tidy = s => String(s || '').trim().replace(/\s+/g, ' ');
const n = { all: nodes.length, code: 0, outside: 0, noname: 0, route: 0, dup: 0, unreadable: 0, short: 0, long: 0, collide: 0, shadow: 0 }, routeHits = [], dups = [], routeIds = new Set(), routeNames = new Set(), renamed = new Set();
const byName = new Map();   // normalized name -> the node kept for it
for (const e of nodes) {
  const re = RENAME[e.tags.wikidata], t = re ? { ...e.tags, 'name:uk': re, renamed: [e.tags['name:uk'], e.tags.name].filter(Boolean).join(';') } : e.tags, name = tidy(t['name:uk'] || t.name);
  if (re) renamed.add(e.tags.wikidata);
  if (!inside(e.lon, e.lat)) { n.outside++; continue; }
  if (!normalize(name)) { n.noname++; continue; }
  const hit = [t['name:uk'], t.name].filter(Boolean).flatMap(aliasKeys).find(k => ROUTE.has(k));
  if (hit) { n.route++; routeHits.push(`${ROUTE.get(hit)} <- ${name} (${t.place}, ${pop(t)})`); routeIds.add(e.id); routeNames.add(normalize(name)); continue; }   // the stop itself, or a small namesake its name already belongs to
  const key = normalize(name), cur = byName.get(key), me = { e, t, name, id: e.id, renamed: !!re, pop: pop(t), city: t.place === 'city' };
  if (!cur) { byName.set(key, me); continue; }
  const better = me.city !== cur.city ? me.city : me.pop > cur.pop;   // place=city before town, then the larger population, else the first
  dups.push(`${name}: kept ${(better ? me : cur).t.place} ${(better ? me : cur).pop}, left out ${(better ? cur : me).t.place} ${(better ? cur : me).pop}`); n.dup++;
  if (better) byName.set(key, me);
}

for (const q in RENAME) if (!renamed.has(q)) console.error(`RENAME: no node with wikidata ${q} (${RENAME[q]})`);

// Aliases: each one's keys (the normalized form, and the form without spaces) must belong to this place alone. A route alias
// always wins, then every place's own name, then its own name in another spelling (name:ru, name:en, HAND: 'Ивановка' stays
// with Іванівка though smaller places have it as an old name; a renamed place's Soviet names never rank so); an alias two
// places share at the same rank is dropped from both.
const places = [...byName.values()].map(p => ({ ...p, slug: normalize(p.name).replace(/ /g, '-') }));
const HANDBY = new Map(Object.entries(HAND).map(([k, v]) => [normalize(k), v]));   // by the normalized name: OSM writes ’ where HAND has '
for (const p of places) if (HANDBY.has(normalize(p.name))) p.t = { ...p.t, hand: HANDBY.get(normalize(p.name)) };
for (const h in HAND) if (!places.some(p => normalize(p.name) === normalize(h))) console.error(`HAND: no place named ${h}`);
const NAMEKEY = new Map(); for (const p of places) for (const k of aliasKeys(p.name)) { if (NAMEKEY.has(k) && NAMEKEY.get(k) !== p) throw Error(`two names share the key '${k}': ${NAMEKEY.get(k).name}, ${p.name}`); NAMEKEY.set(k, p); }
const OWN = new Map(), SELF = new Map();   // key -> the places whose other aliases have it; -> the places whose own names have it
for (const p of places) {
  p.cand = new Map(); p.own = new Set();   // normalized form -> the first spelling of it; the forms that are its own names
  for (const tag of TAGS) for (const v of String(p.t[tag] || '').normalize('NFC').replace(/\p{M}/gu, '').split(/[;,]/).map(tidy).filter(Boolean)) {   // a stress mark ('Бе́регово') is dropped, 'Тіра, Аккерман' is two names
    if (/[\d№+]/.test(v)) { n.code++; continue; }   // code names ('Кіровоград-25', 'Саки-4') and malformed values: a number after a name is no other place
    const nv = normalize(v); if (nv && OWNTAGS.includes(tag) && (tag === 'hand' || (!p.renamed && near(nv, normalize(p.name))))) p.own.add(nv);   // name:ru/en rank as its own only as a spelling of its name: Кайгадор's name:en is Ordzhonikidze
    if (!nv || p.cand.has(nv)) continue;
    if (!readable(v)) { n.unreadable++; continue; }
    if (nv.replace(/ /g, '').length < 3) { n.short++; continue; }
    if (nv.split(' ').length > 3) { n.long++; continue; }   // the marker reads 3 words: 'селище шахти №9 імені Леніна' could never match
    p.cand.set(nv, v);
  }
  for (const nv of p.cand.keys()) if (nv !== normalize(p.name)) for (const k of aliasKeys(nv)) { if (!OWN.has(k)) OWN.set(k, new Set()); OWN.get(k).add(p); if (p.own.has(nv)) { if (!SELF.has(k)) SELF.set(k, new Set()); SELF.get(k).add(p); } }
}
const owner = (k, p) => ROUTE.has(k) ? 'route' : NAMEKEY.has(k) ? (NAMEKEY.get(k) === p ? '' : 'the name of ' + NAMEKEY.get(k).name)   // why key k is not p's: '' = it is
  : SELF.has(k) ? (!SELF.get(k).has(p) ? 'the own name of ' + [...SELF.get(k)][0].name : SELF.get(k).size > 1 ? 'shared' : '') : OWN.get(k).size > 1 ? 'shared' : '';
const dropped = [];
for (const p of places) {
  p.aliases = [p.name]; const mine = new Set(aliasKeys(p.name));
  for (const [nv, v] of p.cand) {
    if (nv === normalize(p.name)) continue;
    const ks = aliasKeys(nv); if (ks.every(k => mine.has(k))) continue;   // 'Білацерква' adds nothing to 'Біла Церква'
    const why = ks.map(k => owner(k, p)).find(Boolean) || '';
    if (!why) { p.aliases.push(v); for (const k of ks) mine.add(k); } else { why === 'route' ? n.shadow++ : n.collide++; dropped.push(`${v} (${p.name}: ${why === 'route' ? 'a route stop' : why})`); }
  }
}

// The same map votes-core.mjs builds: every key must lead to its own place, no key may be a route alias.
const MAP = new Map(); let bad = 0;
for (const p of places) for (const a of p.aliases) for (const k of aliasKeys(a)) { if (ROUTE.has(k) || (MAP.has(k) && MAP.get(k) !== p.slug)) { bad++; console.error(`key clash: ${k} (${p.name})`); } MAP.set(k, p.slug); }
for (const p of places) if (MAP.get(normalize(p.name)) !== p.slug) { bad++; console.error(`name lost: ${p.name}`); }
// Slugs stay: the same OSM node keeps its slug from the previous list; a slug of that list may not vanish or move to another node
// (it holds stored donations), unless --allow-slug-change. Rows of a list from before the ids were kept are checked by slug only.
const prevById = new Map(PREV.filter(r => r[3]).map(r => [r[3], r[0]]));
if (!A['allow-slug-change']) for (const p of places) if (prevById.has(p.id)) p.slug = prevById.get(p.id);
const bySlug = new Map(places.map(p => [p.slug, p])), slugMoves = [];
for (const [slug, name, , id] of PREV) { const p = bySlug.get(slug);
  if (!p) { if (!(id ? routeIds.has(id) : routeNames.has(normalize(name)))) slugMoves.push(`${slug} (${name}) is gone`); }   // a place that became a route stop may go
  else if (id && p.id !== id) slugMoves.push(`${slug} (${name}) would point to another place (${p.name}, node ${p.id})`); }
if (slugMoves.length) { console.error(`slugs of the previous list would change:\n  ${slugMoves.join('\n  ')}`); if (!A['allow-slug-change']) { bad++; console.error('only with no donations for them: rerun with --allow-slug-change'); } }
if (new Set(places.map(p => p.slug)).size !== places.length) { bad++; console.error('slugs are not unique'); }
if (bad) { console.error(`${bad} problems: votes-extra.mjs not written`); process.exit(1); }
if (places.length < 500) { console.error(`only ${places.length} places: the Overpass answer looks incomplete, votes-extra.mjs not written`); process.exit(1); }

const coll = new Intl.Collator('uk');
places.sort((a, b) => coll.compare(a.name, b.name) || (a.slug < b.slug ? -1 : 1));
const rows = places.map(p => JSON.stringify([p.slug, p.name, p.aliases.map(a => a.replace(/ /g, '-')).join(' '), p.id]) + ',');
const day = new Date().toISOString().slice(0, 10), base = osm.osm3s?.timestamp_osm_base || 'unknown';
writeFileSync(OUT, `// The cities and towns of Ukraine that are not route stops, for the "add a city" vote (votes-core.mjs): [slug, name, 'alias alias ...', OSM node id].
// An alias is a name a donor may write after «Місто:» (the spaces inside one are written as '-'); a name two places share is left out.
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright): place=city and place=town nodes inside the
// outline of Ukraine (OSM data of ${base}). Generated by votes-extra-gen.mjs on ${day}; do not edit by hand. To rerun:
//   node votes-extra-gen.mjs --trip ~/Projects/pixel-path-ukraine/trips/ukraine-loop [--overpass http://127.0.0.1:12345/api/interpreter]
export const EXTRA = [
${rows.join('\n')}
];
`);

const missing = BIG.filter(b => !places.some(p => normalize(p.name) === normalize(b)));
console.log(`${n.all} city/town nodes; ${n.outside} outside the outline, ${n.noname} without a name, ${n.route} route stops or their namesakes, ${n.dup} duplicate names -> ${places.length} places (${places.filter(p => p.city).length} city, ${places.filter(p => !p.city).length} town)`);
console.log(`aliases: ${places.reduce((s, p) => s + p.aliases.length, 0)} kept (names included); left out: ${n.shadow} would shadow a route stop, ${n.collide} shared or another place's name, ${n.unreadable} unreadable letters, ${n.code} with a number or malformed, ${n.short} under 3 letters, ${n.long} over 3 words`);
if (A.verbose) { console.log('route stops and namesakes:\n  ' + routeHits.join('\n  ')); console.log('duplicates:\n  ' + dups.join('\n  ')); console.log('aliases left out:\n  ' + dropped.join('\n  ')); }
console.log(missing.length ? `MISSING big cities: ${missing.join(', ')}` : `all ${BIG.length} big cities are in`);
console.log(`wrote ${OUT} (${(Buffer.byteLength(rows.join('\n')) / 1024).toFixed(0)} KB)`);
