// Extra: the outline of the start's country for the overview map (free, seconds).
//   node outline.mjs --trip TRIP
// Reads TRIP/route.json, asks Nominatim for a simplified country polygon, writes TRIP/data/outline.json
// { name, cc, rings: [[[lon, lat], ...], ...] }. Data © OpenStreetMap contributors (ODbL).
import { join } from 'node:path';
import { args, readJSON, writeJSON, politeFetch } from './lib.mjs';
const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node outline.mjs --trip TRIP'); process.exit(1); }
const R = readJSON(join(TRIP, 'route.json')), cc = (A.country || R.country || '').toLowerCase(); if (!cc) throw Error('route.json has no country');
const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&country=${cc}&polygon_geojson=1&polygon_threshold=${A.threshold || 0.01}&limit=1`;
const hit = JSON.parse(await politeFetch(url, { cacheDir: join(TRIP, '.cache'), gapMs: 1100, accept: s => s.startsWith('[') }))[0];
if (!hit?.geojson) throw Error(`Nominatim returned no polygon for country ${cc}`);
const g = hit.geojson, polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
const rings = polys.map(p => p[0].map(([lo, la]) => [+lo.toFixed(4), +la.toFixed(4)])).filter(r => r.length > 20);
writeJSON(join(TRIP, 'data', 'outline.json'), { name: hit.display_name, cc, rings, source: 'Map data © OpenStreetMap contributors (ODbL)' });
console.log(`outline.json: ${hit.display_name}, ${rings.length} ring(s), ${rings.reduce((n, r) => n + r.length, 0)} points`);
