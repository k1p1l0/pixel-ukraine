# Roadmap

What is planned, roughly in order. Open an issue to take something on or to suggest something else.

## Art

- **Khaty in every village.** The `house` role in villages should be a whitewashed khata with a thatched or tin roof
  and blue window frames, in each region's own style. Today most regions have one or two.
- **Street life.** About three characters per region, for example grandmothers on a bench or a vendor under a blue
  umbrella next to a van.
- **Better city centres.** A 256 px pass on the main buildings of the big cities, starting with Kharkiv, which still has
  no buildings of its own.
- **Replace the dropped pictures.** Six pictures were dropped after review (see `"drop": true` in
  `trips/ukraine-loop/art/kit.json`), and one landmark, `lm-Q111017791`, is still a stand-in.
- **Fix the art that fails the art check.** `node scripts/art-check.mjs --trip trips/ukraine-loop --report` lists them.

## Map and road

- **Cities added by the vote.** When a city off the route reaches its goal in the city vote, the loop is rerouted
  through it and that leg is baked again.
- **Sun position per point.** The sun is placed from each 10 km chunk's origin. That is fine at this scale but not exact.
- **Oblast borders recipe in the repo.** `data/borders.json` was made with a one-off script; it should become a
  `scripts/` step like `outline.mjs`.
- **Live traffic, if a source ever covers Ukraine.** Rush-hour jams are made up from the clock today. No live traffic
  service covered Ukrainian roads in October 2026.

## Repo

- **Confirm the art licences.** Check RetroDiffusion's and ElevenLabs' terms for sharing their outputs under CC BY 4.0
  (see NOTICE.md).
- **CI for the room tests.** Run `scripts/mp/*-test.mjs` on every pull request, next to the art check.
