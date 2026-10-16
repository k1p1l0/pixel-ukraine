// City vote by donation (Ukraine branch): which city a Monobank jar top-up is for, from the comment the donor's link
// locked in ("Місто: Львів") or from free text typed in the app ("за Київ!", "Kiev pls", "Харьков"). Pure functions,
// shared by the Worker (votes.mjs) and the tests (votes-test.mjs). Never sees names: only the comment text.
// After the marker it also knows every other city and town of Ukraine (votes-extra.mjs), for the donors who add a city to the route.
import { EXTRA } from './votes-extra.mjs';
export const CITIES = [   // the route stops, in route order; name = how the page and the locked comment write it
  // a city added through the vote joins with its slug from votes-extra.mjs: its donations ('x:<slug>') then count for it (votes.mjs)
  ['kyiv', 'Київ', 'Київ Києва Києві Києву Киев Киева Kyiv Kiev Kijow Kiew Kyjiv'],
  ['chernihiv', 'Чернігів', 'Чернігів Чернігова Чернігові Чернигов Чернигова Chernihiv Chernigov Czernihow'],
  ['sumy', 'Суми', 'Суми Сум Сумах Сумы Sumy'],
  ['kharkiv', 'Харків', 'Харків Харкова Харкові Харьков Харькова Kharkiv Kharkov Charkiw Charkow'],
  ['dnipro', 'Дніпро', 'Дніпро Дніпра Дніпрі Днепр Днепра Дніпропетровськ Днепропетровск Dnipro Dnepr Dnipropetrovsk'],
  ['luhansk', 'Луганськ', 'Луганськ Луганська Луганську Луганск Луганска Luhansk Lugansk'],
  ['donetsk', 'Донецьк', 'Донецьк Донецька Донецьку Донецк Донецка Donetsk'],
  ['mariupol', 'Маріуполь', 'Маріуполь Маріуполя Маріуполі Мариуполь Мариуполя Mariupol'],
  ['kerch', 'Керч', 'Керч Керчі Керчь Керчи Kerch'],
  ['yalta', 'Ялта', 'Ялта Ялти Ялті Ялты Yalta'],
  ['sevastopol', 'Севастополь', 'Севастополь Севастополя Севастополі Sevastopol'],
  ['kherson', 'Херсон', 'Херсон Херсона Херсоні Kherson'],
  ['odesa', 'Одеса', 'Одеса Одеси Одесі Одессa Одесса Одессы Odesa Odessa'],
  ['izmail', 'Ізмаїл', 'Ізмаїл Ізмаїла Ізмаїлі Измаил Измаила Izmail Izmayil'],
  ['vinnytsia', 'Вінниця', 'Вінниця Вінниці Винница Винницы Vinnytsia Vinnitsa Vinnytsya'],
  ['kamianets', "Кам'янець-Подільський", "Кам'янець-Подільський Кам'янець Кам'янця Кам'янці Каменец-Подольский Каменец Kamianets-Podilskyi Kamianets Kamenets Kamyanets"],
  ['chernivtsi', 'Чернівці', 'Чернівці Чернівців Чернівцях Черновцы Черновцов Chernivtsi Chernovtsy Czernowitz Cernauti'],
  ['uzhhorod', 'Ужгород', 'Ужгород Ужгорода Ужгороді Uzhhorod Uzhgorod Ungvar'],
  ['lviv', 'Львів', 'Львів Львова Львові Львов Lviv Lvov Lwow Lemberg Lwiw'],
  ['lutsk', 'Луцьк', 'Луцьк Луцька Луцьку Луцк Луцка Lutsk'],   // not 'Luck': "good luck" is no vote
].map(([slug, name, aliases]) => ({ slug, name, aliases: aliases.split(' ') }));
export const WEAK = new Set(['sumy']);   // 'суми' also means 'sums': only with the marker, or with nothing but filler words around it ('м. Суми', 'за Суми!')
const FILL = new Set(['m', 'h', 'g', 's', 'smt', 'selo', 'misto', 'horod', 'gorod', 'city', 'za', 'dlia', 'vid', 'z', 'iz', 'u', 'v', 'do', 'na', 'moie', 'ridne', 'for']);
// Off-route names that are everyday words ('Місто: мирне небо', 'нове життя', 'щастя вам'), and every name of 4 letters or fewer
// (Бар, Сад, Чоп, Мена): they count only when nothing but filler words follows the marker, as the locked comment writes them.
const XWEAK = new Set(['shchastia', 'nove', 'myrne', 'myrnyi', 'bile', 'vesele', 'druzhba', 'vilne', 'iasne', 'vyshneve', 'kalynove', 'hirske', 'lisove', 'molodizhne', 'prymorskyi', 'krasne', 'chervone', 'zolote', 'sribne', 'dubove']);

// One fixed Cyrillic -> Latin table, so 'Київ', 'Kyiv' and 'Kiev' meet; 'х' kh, 'г' h and 'и' y as in Ukrainian romanisation.
const TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ъ: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e' };
export function normalize(s) {
  s = String(s || '').normalize('NFKC').replace(/\p{M}/gu, '').toLowerCase().replace(/['’ʼ`´‘]/g, '');
  let out = ''; for (const ch of s) out += TR[ch] ?? (/[a-z0-9]/.test(ch) ? ch : ' ');
  return out.replace(/\s+/g, ' ').trim();
}
export const aliasKeys = a => { const n = normalize(a), solid = n.replace(/ /g, ''); return !n ? [] : solid !== n ? [n, solid] : [n]; };   // the normalized alias, and the form without spaces
const ALIAS = new Map(); for (const c of CITIES) for (const a of c.aliases) for (const k of aliasKeys(a)) ALIAS.set(k, c.slug);
const XALIAS = new Map(); for (const [slug, , aliases] of EXTRA) for (const a of aliases.split(' ')) for (const k of aliasKeys(a)) if (!ALIAS.has(k) && !XALIAS.has(k)) XALIAS.set(k, slug);   // a route alias always wins
const PAIRS = [];   // the names of two words, [first, second, slug | route slug], for their case forms
for (const [m, isX] of [[ALIAS, false], [XALIAS, true]]) for (const [k, slug] of m) { const w = k.split(' '); if (w.length === 2) PAIRS.push([w[0], w[1], isX ? 'x:' + slug : slug]); }

function dl(a, b) {   // Damerau-Levenshtein (optimal string alignment)
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); }
  return d[m][n];
}
function exact(tokens) {   // every city named by a token or by two neighbouring tokens
  const found = new Set();
  for (let i = 0; i < tokens.length; i++) { const one = ALIAS.get(tokens[i]), two = i + 1 < tokens.length ? ALIAS.get(tokens[i] + ' ' + tokens[i + 1]) || ((tokens[i] + tokens[i + 1]).length >= 8 ? ALIAS.get(tokens[i] + tokens[i + 1]) : null) : null; if (two) { found.add(two); i++; } else if (one) found.add(one); }   // joined only when long: 'дні про' is no Dnipro
  return found;
}
function closeX(t, d) {   // an off-route name within distance d of a token: then a typo search of the route stops leaves it ('Чернігівка' is no Chernihiv)
  for (const k of XALIAS.keys()) if (Math.abs(k.length - t.length) <= d && dl(t, k) <= d) return true;
  return false;
}
function fuzzy(tokens) {   // one city clearly nearest to a long token (typos): 5+ letters, the same first letter (kh = h), distance 1, or 2 from 9 letters
  let best = null, bestD = 99, tie = false;   // looser rules matched everyday words: 'різниці' Vinnytsia, 'донатик' Donetsk, 'гаманець' Kamianets
  for (const t of tokens.slice(0, 8)) { if (t.length < 5) continue; const lim = t.length >= 9 ? 2 : 1, t0 = t.replace(/^kh/, 'h')[0]; let tb = null, tD = 99, tt = false;
    for (const [a, slug] of ALIAS) { if (a.replace(/^kh/, 'h')[0] !== t0 || Math.abs(a.length - t.length) > lim) continue; const dd = dl(t, a); if (dd > lim) continue;
      if (dd < tD) { tD = dd; tb = slug; tt = false; } else if (dd === tD && slug !== tb) tt = true; }
    if (!tb || closeX(t, tD)) continue;
    if (tD < bestD) { bestD = tD; best = tb; tie = tt; } else if (tD === bestD && (tb !== best || tt)) tie = true; }
  return best && !tie ? best : null;
}
function extra(t) {   // the off-route cities named in the marker tokens by an exact name, at the longest form found: 3 words, 2 (also
  const forms = [], j = (...w) => w.join(''), long = s => s.length >= 8;   // written together, when long: 'дні про'), 1 -> { found: [[slug, key]], words }
  if (t.length === 3) { forms.push([t.join(' '), 3]); if (long(j(...t))) forms.push([j(...t), 3]); }
  for (let i = 0; i + 1 < t.length; i++) { forms.push([t[i] + ' ' + t[i + 1], 2]); if (long(t[i] + t[i + 1])) forms.push([t[i] + t[i + 1], 2]); }
  for (const w of t) forms.push([w, 1]);
  const found = []; let words = 0;
  for (const [f, n] of forms) { if (words > n) break; const slug = XALIAS.get(f); if (slug) { words = n; found.push([slug, f]); } }
  return words ? { found, words } : null;
}
function pairs(t) {   // the names of two words that two neighbouring tokens spell in another case form: 'Нової Одеси', 'Станиці Луганської'
  const pre = (w, k) => { let i = 0; while (i < w.length && w[i] === k[i]) i++; return i; };   // a word near a name's word: the same stem (all but the last 2
  const near = (w, k) => w === k || (Math.abs(w.length - k.length) <= 3 && (ALIAS.has(w) || XALIAS.has(w) ? dl(w, k) <= 1   // letters, 3 at least) or one typo; a word that
    : pre(w, k) >= Math.max(3, k.length - 2) || (k.length >= 4 && dl(w, k) <= 1)));   // is a name itself only by one letter: 'Одеси' ~ Одеса, 'Чернігів' is no 'Черный'
  const out = new Map();   // first token index -> the cities
  for (let i = 0; i + 1 < t.length; i++) for (const [a, b, c] of PAIRS) if (near(t[i], a) && near(t[i + 1], b)) { if (!out.has(i)) out.set(i, new Set()); out.get(i).add(c); }
  return out;
}
const one = set => set.size === 1 ? [...set][0] : null;
// -> { city: slug | 'x:' + extra slug | null, how: 'marker' | 'marker-extra' | 'exact' | 'fuzzy' | 'none' | 'several' }
// An off-route city (EXTRA) counts only after the marker and only by a name it lists (a typo never), so 'Щастя вам', 'Бар' or
// 'Сміла' in a free comment is no vote. After the marker: its name of two words or more goes first, also in another case form
// ('Місто: Нова Одеса', 'Нової Одеси' are no Odesa); then a route stop; then an off-route name of one word. Two cities of the same
// rank are no vote. The marker is «Місто», «Город» or «City» with ':', '-', '–', '—', '=' or only a space, anywhere in the first 300 characters.
const MARK = /(?<!\p{L})(?:[мm][іiї][сcs][тt][оo]|[гg][оo][рr][оo][дd]|horod|city)(?:\s*[:\-–—=]\s*|\s+)(\S.*)/su;   // Latin look-alikes too: 'Mісто'
export function matchCity(comment) {
  const full = String(comment || '').slice(0, 300).normalize('NFKC').toLowerCase(), raw = full.slice(0, 80), m = full.match(MARK);
  if (m) { const all = normalize(m[1]).split(' ').filter(w => w && !FILL.has(w) && !/^(\d+|hrn|grn|uah)$/.test(w)), t = all.slice(0, 3), x = extra(t);   // 'Місто: моє рідне місто Полтава', 'за Озерне'
    const several = { city: null, how: 'several' }, xs = list => one(new Set(list)) ? { city: 'x:' + one(new Set(list)), how: 'marker-extra' } : several;
    if (x && x.words > 1) return xs(x.found.map(([s]) => s));
    const p = new Set([...pairs(t).values()].flatMap(v => [...v])); if (p.size) return [...p].every(c => c.startsWith('x:')) ? (one(p) ? { city: one(p), how: 'marker-extra' } : several) : p.size === 1 ? { city: one(p), how: 'marker' } : several;
    const f = exact(t), x1 = new Set((x?.found || []).filter(([, k]) => all.length === 1 || !(XWEAK.has(k) || k.length <= 4)).map(([s]) => s));   // 'Місто: мирне небо' is no Мирне
    for (const w of WEAK) if (f.has(w) && ALIAS.get(t[0]) !== w && (x1.size || f.size > 1)) f.delete(w);   // 'Місто: Полтава, суми невеликі'; right after the marker it is the city
    if (f.size === 1) return { city: one(f), how: 'marker' };
    if (!f.size && x1.size) return xs([...x1]);
    const z = !f.size && fuzzy(t.slice(0, 2)); if (z) return { city: z, how: 'marker' }; }
  let tokens = normalize(raw).split(' ').filter(Boolean); if (!tokens.length) return { city: null, how: 'none' };
  const used = new Set(); for (const [i, c] of pairs(tokens)) if ([...c].some(v => v.startsWith('x:'))) used.add(i).add(i + 1);   // 'Нова Одеса' or 'Нової Одеси' in free text is no Odesa
  for (let i = 0; i + 1 < tokens.length; i++) for (const n of [3, 2]) if (XALIAS.has(tokens.slice(i, i + n).join(' ')) && i + n <= tokens.length) for (let k = 0; k < n; k++) used.add(i + k);
  tokens = tokens.filter((_, i) => !used.has(i));
  const f = exact(tokens);
  for (const w of WEAK) if (f.has(w) && !tokens.every(t => ALIAS.get(t) === w || FILL.has(t))) f.delete(w);
  if (f.size === 1) return { city: [...f][0], how: 'exact' };
  if (f.size > 1) return { city: null, how: 'several' };
  const z = fuzzy(tokens); if (z && !WEAK.has(z)) return { city: z, how: 'fuzzy' };
  return { city: null, how: 'none' };
}
// The bank's own line for a top-up (its 'description'), when the comment named no city: only a city after the marker counts ('Місто: Луганськ'),
// never a bare word, since the line can hold the sender's name ('Від: Луганський Іван' is no Luhansk). The text is never stored.
export function matchMarked(text) {
  const s = String(text || '').slice(0, 300).normalize('NFKC').toLowerCase(); if (!MARK.test(s)) return { city: null, how: 'none' };
  const m = matchCity(text); return m.how === 'marker' || m.how === 'marker-extra' ? m : { city: null, how: 'none' };
}
// The donor's link: the jar page with the comment locked to the city (?t= fills it and makes it read-only; the amount stays free)
export const donateLink = (sendId, city) => `https://send.monobank.ua/jar/${encodeURIComponent(sendId)}?t=${encodeURIComponent('Місто: ' + city.name).replace(/'/g, '%27')}`;
export const commentFor = city => 'Місто: ' + city.name;
// The off-route cities as the page and the Worker use them; the lookup takes 'poltava' or 'x:poltava'. donateLink works for them too.
export const EXTRA_CITIES = EXTRA.map(([slug, name]) => ({ slug, name, comment: commentFor({ name }) }));
const XBY = new Map(EXTRA_CITIES.map(c => [c.slug, c]));
export const extraCity = slug => XBY.get(String(slug || '').replace(/^x:/, '')) || null;
