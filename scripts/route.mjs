// Step 1: geocode the places and fetch a road route between them (free).
//   node route.mjs --out TRIP --from "Bath, England" --to "Bristol, England" [--via "Keynsham"]... [--osrm URL] [--profile driving]
//   Places may also be "lat,lon" to skip geocoding.
// Writes TRIP/route.json: { from, to, via, stops, total, line: [[lon, lat], ...], country, drive, units, centre }.
// The country of the start decides the defaults the bake and viewer use (they can be overridden there):
//   drive  left/right   (left in the UK, Ireland, Japan, Australia, India, South Africa and others)
//   units  miles/km     (miles in the UK and the USA, for the code-drawn road signs)
//   centre yellow/white (a yellow centre line in North America)
//
// Services (please respect their policies):
//   Nominatim (OpenStreetMap's geocoder): an identifying User-Agent, at most 1 request a second, cached.
//     https://operations.osmfoundation.org/policies/nominatim/
//   OSRM: the public demo server router.project-osrm.org is for light personal use (about 1 request a
//     second, no guarantees); routing.openstreetmap.de (FOSSGIS) is tried if it fails. For heavy use run
//     your own (Docker image ghcr.io/project-osrm/osrm-backend) and pass --osrm http://127.0.0.1:5000.
import { join } from 'node:path';
import { args, multi, politeFetch, writeJSON, cumulative, simplify, haversine } from './lib.mjs';
import { suggestRegions, estimate, PRICE } from './kit.mjs';

const A = args();
const out = A.out, cache = join(out || '.', '.cache');
if (!out || !A.from || !A.to) { console.error('usage: node route.mjs --out TRIP --from PLACE --to PLACE [--via PLACE]... [--osrm URL]'); process.exit(1); }
const via = multi('--via'), PROFILE = A.profile || 'driving';
const OSRMS = A.osrm ? [A.osrm] : ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];

const LEFT = new Set('gb ie im je gg jp au nz in pk bd lk np bt za na bw zw zm mw ls sz mz ke ug tz th my sg bn id tl hk mo cy mt jm tt bb bs gy sr fj pg ws to vc lc gd dm ag kn mu sc vg ky tc ai ms bm fk sh mv'.split(' '));
const MILES = new Set(['gb', 'us', 'lr', 'mm', 'im', 'je', 'gg']);
const YELLOW = new Set(['us', 'ca', 'mx']);

async function geocode(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {   // coordinates: ask Nominatim (reverse) for the town and country, so signs and defaults are right
    const r = await politeFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${m[1]}&lon=${m[2]}`, { cacheDir: cache, gapMs: 1100, accept: s => s.startsWith('{') }).catch(() => '{}');
    const a = JSON.parse(r).address || {}, town = a.city || a.town || a.village || a.suburb || a.county;
    return { name: town ? `${town}${a.country ? ', ' + a.country : ''}` : `${(+m[1]).toFixed(4)} ${(+m[2]).toFixed(4)}`, lat: +m[1], lon: +m[2], cc: a.country_code || null };
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(q);
  const hit = JSON.parse(await politeFetch(url, { cacheDir: cache, gapMs: 1100, accept: s => s.startsWith('[') }))[0];
  if (!hit) throw Error(`Nominatim found nothing for "${q}". Try a more specific name ("Bath, England") or "lat,lon".`);
  return { name: q, label: hit.display_name, lat: +hit.lat, lon: +hit.lon, cc: hit.address?.country_code || null };
}

const stops = [];
for (const q of [A.from, ...via, A.to]) { const g = await geocode(q); stops.push(g); console.log(`${q} -> ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} [${g.cc || '?'}]${g.label ? '  (' + g.label.slice(0, 80) + ')' : ''}`); }

let j = null, used = null, lastErr = '';
for (const base of OSRMS) {
  const url = `${base.replace(/\/$/, '')}/route/v1/${PROFILE}/${stops.map(s => `${s.lon},${s.lat}`).join(';')}?overview=full&geometries=geojson&steps=false`;
  try { j = JSON.parse(await politeFetch(url, { cacheDir: cache, gapMs: 1100, timeoutMs: 180000, tries: 3, accept: s => s.startsWith('{') })); used = base; if (j.code === 'Ok') break; lastErr = `${j.code} ${j.message || ''}`; }
  catch (e) { lastErr = e.message; console.error(`  ${base}: ${e.message}`); }
}
if (!j || j.code !== 'Ok') throw Error(`OSRM: ${lastErr} (no road between these places? try a --via on the road network)`);
const raw = j.routes[0].geometry.coordinates, line = simplify(raw, 1.5), cum = cumulative(line);
let from = 0; const marks = stops.map(s => { let best = Infinity, bi = from; for (let i = from; i < line.length; i++) { const d = haversine(s.lon, s.lat, ...line[i]); if (d < best) { best = d; bi = i; } } from = bi; return { name: s.name, at: Math.round(cum[bi]) }; });
const cc = stops[0].cc || stops.at(-1).cc || null;
writeJSON(join(out, 'route.json'), { from: stops[0].name, to: stops.at(-1).name, via, stops: marks, total: Math.round(cum.at(-1)), line,
  country: cc, drive: LEFT.has(cc) ? 'left' : 'right', units: MILES.has(cc) ? 'miles' : 'km', centre: YELLOW.has(cc) ? 'yellow' : 'white',
  source: `Route: OSRM (${used}, ${PROFILE}); geocoding: Nominatim; data © OpenStreetMap contributors (ODbL)` });
console.log(`route.json: ${(cum.at(-1) / 1000).toFixed(1)} km on the road, ${line.length} points; country ${cc || '?'}: drive ${LEFT.has(cc) ? 'left' : 'right'}, ${MILES.has(cc) ? 'miles' : 'km'}, ${YELLOW.has(cc) ? 'yellow' : 'white'} centre line`);

// The upfront estimate: show it to the user and let them pick a level before the bake (which is slow) or any spending.
const km = cum.at(-1) / 1000, countries = new Set(stops.map(s => s.cc).filter(Boolean)).size || 1, R = suggestRegions(km, countries);
const row = (name, e, note) => `  ${name.padEnd(13)} ${String(e.pictures).padStart(4)} pictures   ${('$' + e.usd.toFixed(2)).padStart(7)}   ${note}`;
console.log(`
ESTIMATE for ${A.from} to ${A.to}: ${km.toFixed(1)} km (${(km / 1.609344).toFixed(1)} miles), about ${R} region${R > 1 ? 's' : ''} (looks) of scenery
${row('placeholders', { pictures: 0, usd: 0 }, 'free code-drawn stand-ins')}
${row('sparse', estimate('sparse', R), 'three kinds of building and a tree per region')}
${row('moderate', estimate('moderate', R), 'about ten buildings per region, trees, props, 4 landmarks')}
${row('detailed', estimate('detailed', R), 'about eighteen buildings per region, more props, 10 landmarks')}
  At $${PRICE} a picture (RetroDiffusion rd_pro__default). This is an estimate: the exact quote is free and comes after
  the bake, once the art is planned (rd.mjs quote). Cost depends on regions, not distance: each extra region adds
  ${estimate('sparse', R + 1).pictures - estimate('sparse', R).pictures} / ${estimate('moderate', R + 1).pictures - estimate('moderate', R).pictures} / ${estimate('detailed', R + 1).pictures - estimate('detailed', R).pictures} pictures (sparse / moderate / detailed).
  Bake time grows with distance: roughly ${Math.max(1, Math.round(km / 10 * 40 / 60))} minute${km > 15 ? 's' : ''} for this route${km > 500 ? '. For a route this long, consider a stretch of it (--via points closer together) or at most 3 to 4 regions' : ''}.
  Need a RetroDiffusion account? https://www.retrodiffusion.ai?ref=YBQJM823 (affiliate link)`);
