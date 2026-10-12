// The art kit: which pictures a trip needs at each level of detail, their sizes, how tall each stands in the world,
// and the prompt recipe that keeps them in one style. Each part of the wording matters: say the view ("seen straight on, flat front elevation", "seen exactly
// from behind"), say the isolation ("isolated on a plain white background, no ground, no shadow"), and say that the
// whole subject is inside the picture ("nothing cut off"). Without each of those the model paints scenery, angles
// and cropped edges, and the picture can't stand in the world.

export const STYLE = 'rd_pro__default';      // the default style ($0.18 a picture, October 2026)
export const PRICE = 0.18;                   // for estimates only; rd.mjs quote asks the API for the real price

const ISO = 'pixel art game asset, isolated on a plain white background, no ground, no shadow, 16-bit style, afternoon light';
const WHOLE = 'the whole subject inside the picture with a margin on every side, nothing cut off';
export const RECIPE = {
  facade: s => `the full front elevation of ${s}, seen straight on, flat front elevation, all signs blank or with invented words only, no real brand logos, ${ISO}, ${WHOLE}`,
  sprite: s => `${s}, ${ISO}, ${WHOLE}`,
  landmark: s => `${s}, as seen from the street, its full recognisable shape, seen straight on, ${ISO}, ${WHOLE}`,
};

// Facade roles. w x h is the generated size (its shape sets how wide the building stands); hm its height in metres.
export const FACADES = {
  house:      { w: 160, h: 128, hm: 8,  subject: 'a typical detached or semi-detached house of {place}, two storeys, front door and windows' },
  terrace:    { w: 128, h: 160, hm: 10, subject: 'one house of a terraced row typical of {place}, two or three storeys, its front door and windows, flat sides where it joins its neighbours' },
  shop:       { w: 160, h: 160, hm: 10, subject: 'a typical high-street building of {place}: a shopfront with an invented name at street level and one or two storeys of windows above, flat sides where it joins its neighbours' },
  apartment:  { w: 128, h: 192, hm: 18, subject: 'a typical five or six storey apartment or office building of {place}, flat sides where it joins its neighbours' },
  tower:      { w: 128, h: 256, hm: 60, subject: 'a typical tall modern tower of {place}, many storeys' },
  civic:      { w: 192, h: 160, hm: 14, subject: 'a typical public building of {place}: a town hall, school or station' },
  church:     { w: 128, h: 192, hm: 20, subject: 'a typical church of {place} with its tower or steeple' },
  industrial: { w: 192, h: 128, hm: 9,  subject: 'a typical warehouse or workshop of {place}' },
  farm:       { w: 192, h: 128, hm: 8,  subject: 'a typical farm barn or farmhouse of {place}' },
};
export const SPRITES = {
  tree:   { w: 128, h: 160, hm: 9,   subject: 'a big typical roadside tree of {place}, full crown and trunk' },
  bush:   { w: 96,  h: 96,  hm: 1.6, subject: 'one small shrub typical of {place}, standing on its own with white space all around it' },
  street: { w: 96,  h: 96,  hm: 1.4, subject: 'a typical piece of street furniture of {place}: a bench, a post box, a bin or a bus stop' },
};
export const LANDMARK = { w: 192, h: 192, tall: { w: 128, h: 256 }, wide: { w: 256, h: 160 } };

// How much of each, per region (theme), by level. Facade roles are ranked by how much of the region's frontage
// they cover (from the bake), so a sparse kit spends its few pictures where they show most.
export const LEVELS = {
  sparse:   { facades: [1, 1, 1],                                           maxFacadeRoles: 3, sprites: { tree: 1 },                     landmarks: 0 },
  moderate: { facades: [2, 2, 2, 1, 1, 1, 1],                               maxFacadeRoles: 6, sprites: { tree: 2, bush: 1, street: 1 }, landmarks: 4 },
  detailed: { facades: [4, 4, 3, 3, 3, 2, 2, 2, 1],                         maxFacadeRoles: 9, sprites: { tree: 3, bush: 2, street: 3 }, landmarks: 10 },
};

// The upfront estimate, before anything slow happens (route.mjs prints it). Cost depends on the number of regions
// (looks), not on distance: a 20 km trip and a 2,000 km trip through one kind of place cost the same. A region
// usually gets three to five kinds of building, so this uses the typical facade count, not the maximum.
const TYPICAL_FACADES = { sparse: 3, moderate: 10, detailed: 18 };
export function suggestRegions(km, countries = 1) {
  return Math.min(5, Math.max(countries, km < 15 ? 1 : km < 300 ? 2 : km < 1500 ? 3 : 4));
}
export function estimate(level, regions) {
  const L = LEVELS[level], s = Object.values(L.sprites).reduce((a, b) => a + b, 0), n = regions * (TYPICAL_FACADES[level] + s) + L.landmarks;
  return { pictures: n, usd: +(n * PRICE).toFixed(2) };
}
