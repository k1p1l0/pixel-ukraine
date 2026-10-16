// node votes-test.mjs: realistic comments -> the city they must count for (null = the general pot)
import { matchCity, matchMarked, normalize, donateLink, CITIES, EXTRA_CITIES, extraCity } from './votes-core.mjs';
import { parseAssign } from './votes.mjs';
import { EXTRA } from './votes-extra.mjs';
const T = [
  ['Місто: Львів', 'lviv'], ['місто: Київ', 'kyiv'], ["Місто: Кам'янець-Подільський", 'kamianets'], ['Місто: Ізмаїл', 'izmail'], ['Місто: Суми', 'sumy'],
  ['за Київ!', 'kyiv'], ['Kiev pls', 'kyiv'], ['Харьков', 'kharkiv'], ['lwow', 'lviv'], ['Lemberg <3', 'lviv'], ['Одесса-мама', 'odesa'], ['для Одеси 🌊', 'odesa'],
  ['Дніпро', 'dnipro'], ['Днепр!!!', 'dnipro'], ['Чернігів', 'chernihiv'], ['Херсон це Україна', 'kherson'], ['Маріуполь', 'mariupol'], ['Ялта', 'yalta'],
  ['Kharkov', 'kharkiv'], ['Kharkiw', 'kharkiv'], ['Zaporizhzhia', null], ['Луцк', 'lutsk'], ['Ужгород 🏔', 'uzhhorod'], ['Chernivtsi', 'chernivtsi'], ['Czernowitz', 'chernivtsi'],
  ['Кам\'янець', 'kamianets'], ['Камянець-Подільський', 'kamianets'], ['Вінниця', 'vinnytsia'], ['Vinnitsa', 'vinnytsia'], ['Севастополь', 'sevastopol'], ['Керчь', 'kerch'],
  ['Суми', 'sumy'], ['невеликі суми але від душі', null], ['Київ і Львів', null], ['', null], ['поповнення банки', null], ['🙂', null], ['Донецьк — це Україна', 'donetsk'],
  ['Луганськ', 'luhansk'], ['Kyiv, Lviv', null], ['Odesa 💙💛', 'odesa'], ['Kyyiv', 'kyiv'],
  // the review's false positives (everyday words near a city) and real typos that must still count
  ['Місто: без різниці', null], ['Місто без різниці', null], ['Кидаю монетку', null], ['Монетка', null], ['Маленький донатик', null], ['Донатик', null], ['Донечка', null],
  ['Хардкор!', null], ['З мого гаманця', null], ['Гаманець', null], ['Вова', null], ['Nice view', null], ['I knew it', null], ['For merch', null], ['Malta', null],
  ['Good luck!', null], ['Best of luck', null], ['Lucky', null], ['Гарні дні про Україну', null], ['суми для ЗСУ', null],
  ['м. Суми', 'sumy'], ['м.Суми', 'sumy'], ['г. Сумы', 'sumy'], ['За Суми!', 'sumy'], ['Для Сум', 'sumy'], ['Суми — моє місто', 'sumy'], ['м. Львів', 'lviv'],
  ['Чернигів', 'chernihiv'], ['Вінница', 'vinnytsia'], ['Харкив', 'kharkiv'], ['Herson', 'kherson'], ['Mariupil', 'mariupol'], ['Sevastopil', 'sevastopol'], ['Uzgorod', 'uzhhorod'], ['Dinpro', 'dnipro'],
  ['Кам янець', 'kamianets'], ['Камʻянець-Подільський', 'kamianets'],
];
// add a city: an off-route city counts only after the marker, by its exact name ('x:' + its slug in votes-extra.mjs)
const X = [
  ['Місто: Полтава', 'x:poltava'], ['місто: запоріжжя', 'x:zaporizhzhia'], ['Місто: Кіровоград', 'x:kropyvnytskyi'], ['Місто: Кропивницький', 'x:kropyvnytskyi'],
  ['Місто: Біла Церква', 'x:bila-tserkva'], ['Місто: Івано-Франківськ', 'x:ivano-frankivsk'], ['Місто: Кривий Ріг', 'x:kryvyi-rih'],
  ["Місто: Слов'янськ", 'x:sloviansk'], ['Місто: Слов’янськ', 'x:sloviansk'], ['Місто: Словʼянськ', 'x:sloviansk'], ['Місто: Мукачеве', 'x:mukachevo'], ['Місто: м. Полтава', 'x:poltava'],
  ['Полтава', null], ['Щастя вам!', null], ['Бар', null], ['Ізюм', null], ['Сміла', null], ['Місто: Неіснуюче', null], ['Місто: Полтаву', 'x:poltava'],
  ['Місто: Львів', 'lviv'], ["Місто: Кам'янець-Подільський", 'kamianets'],
  // a name of two words goes before a route stop inside it; a typo search of the route stops never takes a real town's name
  ['Місто: Нова Одеса', 'x:nova-odesa'], ['Місто: Станиця Луганська', 'x:stanytsia-luhanska'], ['Місто: Кременець', 'x:kremenets'], ['Місто: Донецьке', 'x:donetske'],
  // else a route stop in the same comment goes first, and several cities are no vote
  ['Місто: Київ Полтава', 'kyiv'], ['Місто: Київ, Львів, Бар', null],
  // the second review: case forms and typos of a two-word name go to it, never to the route stop inside it (P1)
  ['Місто: Нової Одеси', 'x:nova-odesa'], ['Місто: Новій Одесі', 'x:nova-odesa'], ['Місто: Станиці Луганської', 'x:stanytsia-luhanska'], ['Нової Одеси', null], ['Нова Одеса', null],
  ['Місто: Чернігівки', null], ['Місто: Черняхова', null], ['Чернігівка', null], ['Місто: Одеси', 'odesa'], ['Місто: Чернігова', 'chernihiv'], ['Місто: Кам’янця-Подільського', 'kamianets'],
  ['Місто: Чернігів, Бровари', 'chernihiv'], ['Місто: Чернігів Острів', 'chernihiv'],
  // a number after a name moves nothing (P2), filler words never join a name (P3)
  ['Місто: Костянтинівка 2 рази', 'x:kostiantynivka'], ['Місто: Саки 4', 'x:saky'], ['Місто: Кіровоград, 25 грн', 'x:kropyvnytskyi'], ['Місто: Бе́регове', 'x:berehove'],
  ['Місто: за Озерне', 'x:ozerne'], ['Місто: до Брянка', 'x:brianka'], ['Місто: с. Ад', null], ['Місто: м. Ена', null],
  // 'суми' after another city is a sum (P4); two cities of the same rank are no vote, in any order (P5)
  ['Місто: Полтава, суми невеликі', 'x:poltava'], ['Місто: Полтава. Суми скромні, але від душі', 'x:poltava'], ['Місто: Київ, суми невеликі', 'kyiv'], ['Місто: Суми, Полтава', 'sumy'], ['Місто: суми невеликі', 'sumy'],
  ['Місто: Полтава, Житомир', null], ['Місто: Житомир, Полтава', null], ['Місто: Полтава, Бар', 'x:poltava'], ['Місто: Бар, Полтава', 'x:poltava'],
  // the marker with a dash, a space, a Latin look-alike, filler words, or after a long thank-you (P6)
  ['Місто — Полтава', 'x:poltava'], ['Місто Полтава', 'x:poltava'], ['Mісто: Полтава', 'x:poltava'], ['Місто: Україна, м. Біла Церква', 'x:bila-tserkva'], ['Місто: моє рідне місто Полтава', 'x:poltava'],
  ['Дуже дякую за вашу роботу, ви робите круту справу, тримайтеся, слава Україні! Місто: Полтава', 'x:poltava'], ['Херсон - найкраще місто в Україні', 'kherson'], ['Містом Полтава', null], ['Місто — Львів', 'lviv'],
  // case forms and the usual spellings of the big places (P7)
  ['Місто: Полтави', 'x:poltava'], ['Місто: Кривому Розі', 'x:kryvyi-rih'], ['Місто: Білої Церкви', 'x:bila-tserkva'], ['City: Zaporozhye', 'x:zaporizhzhia'], ['City: Nikolaev', 'x:mykolaiv'], ['City: Krivoy Rog', 'x:kryvyi-rih'],
  // an everyday phrase is no town; the town alone still counts (P8)
  ['Місто: мирне небо', null], ['Місто: нове життя', null], ['Місто: щастя вам', null], ['Місто: Бар, дякую', null], ['Місто: Нове', 'x:nove'], ['Місто: Сад', 'x:sad'], ['Місто: Бар', 'x:bar'], ['Місто: Щастя', 'x:shchastia'],
  // the Ukrainian names of renamed Crimean towns, and an old name several places share is no vote (G1); own Russian names (G2)
  ['Місто: Іслям-Терек', 'x:isliam-terek'], ['Місто: Курман', 'x:kurman'], ['Місто: Красногвардійське', 'x:kurman'], ['Місто: Кіровське', null], ['Місто: Комсомольське', null],
  ['Місто: Ивановка', 'x:ivanivka'], ['Місто: Михайловка', 'x:mykhailivka'], ['Місто: Новоселица', 'x:novoselytsia'], ['Місто: Красноармейск', 'x:pokrovsk'],
];
let bad = 0; for (const [c, want] of T) { const got = matchCity(c); const ok = got.city === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(c), '->', got.city, got.how, ok ? '' : '(want ' + want + ')'); }
console.log(normalize("Кам'янець-Подільський"), '|', donateLink('3KnuZcZuKz', CITIES[18]));
let badX = 0; for (const [c, want] of X) { const got = matchCity(c); const ok = got.city === want; if (!ok) badX++; console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(c), '->', got.city, got.how, ok ? '' : '(want ' + want + ')'); }
// every place by its name and by each alias, as the page's link writes it; never without the marker
let lost = 0, aliases = 0; const fail = (what, ...a) => { if (++lost <= 20) console.log('FAIL', what, ...a); };
for (const c of EXTRA_CITIES) { const g = matchCity('Місто: ' + c.name).city; if (g !== 'x:' + c.slug) fail('extra', c.name, '->', g); if (matchCity(c.name).city?.startsWith('x:')) fail('no marker', c.name); }
for (const c of CITIES) { const g = matchCity('Місто: ' + c.name).city; if (g !== c.slug) fail('route', c.name, '->', g); }
for (const [slug, , al] of EXTRA) for (const a of al.split(' ')) { aliases++; const g = matchCity('Місто: ' + a.replace(/-/g, ' ')).city; if (g !== 'x:' + slug) fail('alias', a, '->', g, '(want x:' + slug + ')'); }
const coll = new Intl.Collator('uk'), slugs = new Set(EXTRA.map(r => r[0]));
if (EXTRA.some((r, i) => i && coll.compare(EXTRA[i - 1][1], r[1]) > 0)) fail('EXTRA is not sorted by name');
if (slugs.size !== EXTRA.length || CITIES.some(c => slugs.has(c.slug))) fail('slugs are not unique');
for (const r of EXTRA) if (!Number.isInteger(r[3]) || /[\d№+,]|\p{M}/u.test(r[2])) fail('a row without its OSM node id, or an alias with a number, a mark or a comma', r[1]);
const link = donateLink('3KnuZcZuKz', extraCity('x:sloviansk')), back = new URL(link).searchParams.get('t');   // the comment the jar page locks in
if (matchCity(back).city !== 'x:sloviansk' || extraCity('poltava')?.comment !== 'Місто: Полтава' || extraCity('x:nope') !== null) fail('link or lookup', link);
// the bank's own line (description) counts only after the marker: a sender's name is no city
for (const [d, want] of [['Місто: Луганськ', 'luhansk'], ['Переказ. Місто: Полтава', 'x:poltava'], ['Від: Луганський Іван', null], ['Луганськ', null], ['Від: Харків Петро', null], ['', null], [undefined, null]]) if (matchMarked(d).city !== want) fail('description', d, '->', matchMarked(d).city);
// VOTE_ASSIGN: minute(s) in UTC / kopecks / slug; a bad entry or an unknown slug is dropped
const A = parseAssign(' 2026-01-05T09:15|2026-01-05T11:15/12500/lviv; 2026-01-05T09:15/100/x:poltava;2026-01-05T09:15/100/poltava;2026-01-05 09:15/1/kyiv;2026-01-05T09:15/0/kyiv;2026-01-05T09:15/5/narnia;2026-01-05T09:15|x/5/kyiv;;');
if (JSON.stringify(A) !== JSON.stringify([{ times: [1767604500, 1767611700], amount: 12500, key: 'lviv' }, { times: [1767604500], amount: 100, key: 'x:poltava' }, { times: [1767604500], amount: 100, key: 'x:poltava' }]) || parseAssign('').length || parseAssign(undefined).length) fail('VOTE_ASSIGN', JSON.stringify(A));
const all = bad + badX + lost;
console.log(all ? `${all} FAILED` : `all ${T.length} old + ${X.length} new cases passed; 'Місто: <name>' matched all ${EXTRA_CITIES.length} off-route cities (${aliases} aliases) and ${CITIES.length} route stops; no off-route city without the marker`);
process.exit(all ? 1 : 0);
