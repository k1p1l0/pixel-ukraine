---
name: pixel-path
description: Pixel Path turns any two places (optionally via waypoints) into a pixel-art fly-through of the real road. It routes the trip, bakes the real buildings, land cover, landmarks, hills and horizon from OpenStreetMap and elevation data, generates scenery art with RetroDiffusion at a chosen level of detail (sparse, moderate or detailed; estimated up front, quoted exactly for free, budget-capped; free placeholder art also works), builds a page where you zoom along the route and scroll to go faster or slower, and runs a self-check that screenshots the result. Use when someone asks for a "pixel path", a "pixel road trip", to "drive" or "fly" from X to Y in pixel art, or a retro first-person view along a real route.
---

# Pixel Path

Builds a folder you can open or host: `index.html` with `road.js` and `layout.js` (the fly-through), `data/` (the
baked route) and `art/` (the pictures). Plain Node 18+, no npm installs (the self-check uses Playwright if present).
Scripts are in `${CLAUDE_SKILL_DIR}/scripts/`; run them as `node ${CLAUDE_SKILL_DIR}/scripts/<name>.mjs ...`.
Call the trip folder TRIP (e.g. `trips/bath-bristol`). Every step can be rerun and resumes where it stopped.

The result is a first-person camera moving along the real road: the real buildings on their footprints, the real
landmarks at their places, real land cover, hills and horizon. No interface beyond a small credits line. Scroll (or
drag on a touch screen) to speed up, slow down or reverse.

## Before you start, tell the user
- **Only the art costs money**, paid to RetroDiffusion from the user's own account. Routing, map data and the viewer are
  free. Step 1 prints an estimate for their route at each level: **show it to them and let them pick a level (or free
  placeholders) before you bake or generate anything.**
- **No account?** Send them to https://www.retrodiffusion.ai?ref=YBQJM823 and say that **it is an affiliate link**
  (the author of this skill gets a referral). They create an API key and set it in their own terminal:
  `export RETRODIFFUSION_API_KEY=...` (on a Mac they can store it in the Keychain instead:
  `security add-generic-password -s pixel-path -a retrodiffusion -w`). **Never ask for the key in the chat, never
  print it, echo it or write it to a file.**
- **Attribution is required.** The credits line (OpenStreetMap, OSRM, Terrain Tiles, Wikidata, RetroDiffusion) must stay
  visible wherever the fly-through is shown.
- **Time.** Baking takes about 20 to 60 seconds per 10 km. Run long bakes in the background.

## The levels
Per region (a region is one look, e.g. "Georgian Bath"); $0.18 a picture at RetroDiffusion `rd_pro__default`
(October 2026). The levels are nested: moving up a level only pays for the new pictures.

| level | per region | 1 region / 2 regions | what you get |
| --- | --- | --- | --- |
| placeholders | 0 | $0 / $0 | code-drawn stand-ins for every picture |
| `sparse` | 4 | 4 / 8 pictures, $0.72 / $1.44 | 3 kinds of building and a tree; every lot still filled, mirrored and tinted copies stretch the few pictures |
| `moderate` | about 14 + 4 landmarks | 18 / 32 pictures, $3.24 / $5.76 | about 10 buildings over the main kinds, 2 trees, a shrub, a street prop, the 4 best-known landmarks |
| `detailed` | about 26 + 10 landmarks | 36 / 62 pictures, $6.48 / $11.16 | up to 6 variants of each kind of building (up to 9 kinds), 3 trees, 2 shrubs, 3 street props, 10 landmarks |

## Steps

### 1. Route and estimate (free, seconds)
```
node ${CLAUDE_SKILL_DIR}/scripts/route.mjs --out TRIP --from "Bath, England" --to "Bristol, England" [--via "Keynsham"]
```
Places can be names or `"lat,lon"`; add the region or country if a name is ambiguous. The start's country sets which
side you drive on, miles or km on signs, and a yellow centre line in North America. It prints the distance and the
**estimate table** (pictures and dollars for each level): show it and ask which level. `NoRoute` means no road connects
them: add a `--via` on the road network. Set `PIXEL_PATH_USER_AGENT="name/1.0 (email)"` so the services know who asks.

### 2. Bake (free, slow)
```
node ${CLAUDE_SKILL_DIR}/scripts/bake.mjs --trip TRIP [--default-land desert]
```
`--default-land desert` for arid routes. It prints, per 10 km, the buildings, land mix and place names, and at the end
the best-known landmarks near the road: use them to choose regions and subjects. On Overpass errors it waits and retries
across mirrors; if it still fails, rerun later (finished chunks are kept).

### 3. Plan the art (free)
One region (theme) per distinct look: usually 1 for a short or uniform route, 2 or 3 for city, countryside, another
city. A region is `id|starts at km|description`. **Write specific subjects**: generic prompts give generic buildings,
and the subject is what makes a place recognisable. Give up to 6 alternatives per role separated by `|` (each variant
takes the next one). For landmarks, describe what the building looks like from the street
(`--subject "lm-<wikidata id>=..."`): the model does not know the building by name.
```
node ${CLAUDE_SKILL_DIR}/scripts/plan-art.mjs --trip TRIP --detail moderate \
  --theme "bath|0|the Georgian city of Bath, England: honey-coloured Bath stone" \
  --theme "bristol|11|Bristol, England: red brick and pastel-painted Victorian terraces" \
  --subject "bath:terrace=a three-storey Georgian townhouse of Bath stone in a terrace, sash windows, a black door|..." \
  --subject "bath:shop=a Georgian Bath stone building with a painted wooden shopfront, invented name|..." \
  --subject "lm-Q2540426=the Roman Baths: a Bath stone colonnade and the Pump Room front with tall columns"
node ${CLAUDE_SKILL_DIR}/scripts/placeholder-art.mjs --trip TRIP
```
Kinds of building (house, terrace, shop, apartment, tower, civic, church, industrial, farm) get pictures in proportion
to how much of the frontage they cover; other roles are `tree`, `bush`, `street` and the landmarks. Read the printed
list and fix subjects that don't fit. The prompts already spell out the view and the isolation. Never ask for real
brand logos, real business names or recognisable people.

### 4. Quote, confirm, generate
```
node ${CLAUDE_SKILL_DIR}/scripts/rd.mjs quote --trip TRIP                 # free: the exact total and the account balance
node ${CLAUDE_SKILL_DIR}/scripts/rd.mjs run --trip TRIP --budget 6.50     # only after the user confirms the budget
```
`--budget` is the trip's total including what it already spent; suggest about 25% over the quote for re-rolls (in tests, 10 to 35% of pictures came back unusable and were re-rolled). Every job
is quoted and reserved in `art/ledger.json` before it is paid for; the run stops rather than go over the budget or the
balance, and reruns never pay twice. Exit 3 means no key.

### 5. Clean (free), then look at the contact sheet
```
node ${CLAUDE_SKILL_DIR}/scripts/clean.mjs --trip TRIP
```
Floods away white backdrops, fills see-through holes in facades, hardens edges, crops, and drops pictures that still
carry a background (over 55% of the outline opaque), painted sky, cut-off subjects or slivers. **Open
`TRIP/art/contact.png` with the Read tool and look at every picture.** Add any that look wrong (a building at an angle,
two buildings in one picture, a sign with a real brand, anything that would not stand on its own in a street) to
`TRIP/art/drop.txt`, one name per line, and re-clean.

### 6. Self-check (do not skip it, do not stop while it reports problems)
```
node ${CLAUDE_SKILL_DIR}/scripts/check.mjs --trip TRIP [--fix --budget 6.50]
```
It installs the page, lays out the whole route exactly as the page will, and then, in headless Chromium:
- **sweeps the whole route:** every 75 m of built-up road, with the camera moving, looking straight ahead and 30
  degrees to each side, the sky painted magenta and every building drawn into a mask. It counts sky seen through a
  building and slits of sky between two parts of the same street wall reaching down to the ground, and writes the 20
  worst frames to `TRIP/check/worst-frames.png` (each frame as it looks, beside the same frame with the problem marked);
- renders sample frames (`TRIP/check/montage.png`, `shot-*.png`) and checks they are readable and named;
- reports gaps in built-up street walls, a building with the same picture as its neighbour, and dropped art.
`--fix` re-rolls dropped pictures within the budget and checks again. The frame checks need Node 20+ and Playwright
(`npm i -D playwright && npx playwright install chromium`); without them, say plainly that the trip was not swept.

### 7. Look, then fix, until it is clean
Read `TRIP/check/worst-frames.png`, `TRIP/check/montage.png` and the `shot-*.png` frames. The trip is done only when
the sweep reports no frames with sky through or between buildings **and** every frame you look at passes these
questions: can you tell where you are (buildings, signs, landmarks)? Is there a gap in a street, sky through or behind
a building, a building that looks like a flat card, a floating fragment, the same building twice side by side?
Is anything broken, on a background, cut off, enormous or tiny? Fix what you find: a bad picture goes in
`drop.txt` and `rd.mjs run --regen NAME` (it costs a picture: say so first); generic pictures need better subjects and
`--regen`; a region that looks wrong needs another region. Run the check again after every fix. Tell the user honestly
what is still imperfect.

### 8. View and hand over
```
node ${CLAUDE_SKILL_DIR}/scripts/viewer.mjs --trip TRIP --serve 8080     # then open http://127.0.0.1:8080/
```
Any static server works (`file://` does not). To host, upload `index.html`, `road.js`, `layout.js`, `data/` and `art/`
(not `.cache/`, `art/raw/`, `art/ledger.json`). Controls: scroll or drag to go faster or slower (keep going to reverse),
arrow keys the same, Space pauses, I shows where you are, M a small map. URL options: `?km=3.2&speed=60&info=1&map=1`.

## Being polite to the services
One script at a time per service, with the built-in pauses. Everything is cached in `TRIP/.cache`, so reruns cost the
services nothing. Never run several bakes in parallel; for many or very long routes, self-host OSRM and Overpass.

## Credits and licences (attribution required)
- **Map data © OpenStreetMap contributors**, Open Database Licence (ODbL): https://www.openstreetmap.org/copyright.
  The baked `data/` is a derived database: if you share it publicly it stays under the ODbL, with attribution.
- **Routing:** OSRM, from OpenStreetMap data. **Geocoding:** Nominatim (OpenStreetMap Foundation), under its usage policy.
- **Elevation:** Terrain Tiles (Mapzen/Tilezen on AWS Open Data): https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- **Landmarks:** Wikidata (CC0).
- **Art:** generated with RetroDiffusion (https://www.retrodiffusion.ai?ref=YBQJM823, affiliate link) on the user's own
  account, under RetroDiffusion's terms.

## RetroDiffusion API assumptions (checked October 2026)
`POST https://api.retrodiffusion.ai/v2/inferences` with header `X-RD-Token`; body `prompt, prompt_style, width,
height, num_images, seed, remove_bg, input_palette`; `check_cost: true` returns `balance_cost` and `remaining_balance`
for free; results in `base64_images`, or a `task_id` polled at `GET /v2/inferences/tasks/<id>`. Trust `rd.mjs quote`
over the prices above. If the API changes, adjust `bodyOf()` and `api()` in `rd.mjs`.

## Files
- `scripts/route.mjs` (with the estimate), `bake.mjs`; `kit.mjs` (roles, prompt recipes, levels); `plan-art.mjs`,
  `rd.mjs`, `clean.mjs`, `placeholder-art.mjs`; `viewer.mjs`, `check.mjs`; `lib.mjs`.
- `templates/viewer.html`, `road.js`, `layout.js`: the fly-through (commented, to be read). `templates/palette.png`: the
  shared palette that keeps a kit coherent.
