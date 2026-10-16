# Notices and attributions

Pixel Ukraine (Піксельна Україна) is a fork of [Pixel Path](https://github.com/jonwheatley/pixel-path) by Jon Wheatley.
Different parts of this repo are under different terms. Any copy of the game you host must keep the map attributions
below visible to players; the game's landing page and credits line already show them.

| what | where | licence |
| --- | --- | --- |
| code | `scripts/`, `templates/*.js`, `templates/viewer.html`, `deploy/`, `.github/` | MIT, see [LICENSE](LICENSE) |
| baked map data | `trips/*/data/` (except `radio.json`), `scripts/mp/votes-extra.mjs` (city list) | ODbL 1.0, see [trips/ukraine-loop/data/LICENSE](trips/ukraine-loop/data/LICENSE) |
| pictures | `trips/*/art/*.png`, `trips/*/art/cards/*.png` | CC BY 4.0 |
| sounds | `templates/sfx/*.mp3` | CC BY 4.0 |
| radio list | `trips/*/data/radio.json` | CC0 1.0 |
| fonts | `templates/fonts/` | SIL Open Font License 1.1, see [templates/fonts/OFL.txt](templates/fonts/OFL.txt) |
| upstream screenshots and palette | `docs/demo.webp`, `docs/bath-moderate.webp`, `docs/kyoto-sparse.webp`, `templates/palette.png` | from Pixel Path, MIT |
| game video and frames | `docs/pixel-ukraine.mp4`, `docs/pixel-ukraine-*.webp` | CC BY 4.0 for the pictures and the game sounds; they show map data, so keep the map attribution. The music in the video is not covered: see below |

## Code

MIT. Copyright (c) 2026 Jon Wheatley, Copyright (c) 2026 Kyrylo Kozak.

## Map data

**Map data © OpenStreetMap contributors**, available under the Open Database License (ODbL) 1.0:
https://www.openstreetmap.org/copyright

The baked chunks in `trips/ukraine-loop/data/` and the place list in `scripts/mp/votes-extra.mjs` are a Derivative
Database of OpenStreetMap. If you share them, or a database made from them, it stays under the ODbL with this
attribution. Rendered frames of the game are a Produced Work and need the attribution line above.

The bake also uses:

- **Land cover (roadside tree belts):** ESA WorldCover 10 m 2021 v200, licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel
  data (2021) processed by ESA WorldCover consortium. Citation: Zanaga, D., Van De Kerchove, R., Daems, D., De
  Keersmaecker, W., Brockmann, C., Kirches, G., Wevers, J., Cartus, O., Santoro, M., Fritz, S., Lesiv, M., Herold, M.,
  Tsendbazar, N.E., Xu, P., Ramoino, F., Arino, O. (2022). ESA WorldCover 10 m 2021 v200.
  https://doi.org/10.5281/zenodo.7254221
- **Coastline (`land.json`):** Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com. Natural
  Earth is in the public domain.
- **Elevation:** Terrain Tiles on AWS Open Data (Mapzen/Tilezen). Sources include SRTM and GMTED2010 courtesy of the
  U.S. Geological Survey, ETOPO1 from the U.S. National Oceanic and Atmospheric Administration, and EU-DEM, produced using
  Copernicus data and information funded by the European Union. Full list:
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- **Route:** OSRM (https://project-osrm.org) on OpenStreetMap data. **Geocoding, the country outline and the
  neighbouring countries (`outline.json`, `neighbours.json`):** Nominatim, © OpenStreetMap contributors. **Oblast
  borders (`borders.json`):** OpenStreetMap boundary ways (admin_level 4) from an Overpass server, © OpenStreetMap
  contributors.
- **Landmarks:** Wikidata, CC0 1.0.

## Pictures

The pictures in `trips/ukraine-loop/art/` are released under CC BY 4.0 by Kyrylo Kozak, who wrote the prompts and chose
the pictures. Credit them as "Pixel Ukraine art by Kyrylo Kozak, CC BY 4.0". `trips/ukraine-loop/art/SOURCES.json`
lists the source, model, licence and author of every picture. There are three sources:

- **RetroDiffusion** (https://www.retrodiffusion.ai), `rd_pro__default` and `rd_plus` styles, made through
  `scripts/rd.mjs` on a paid account: 247 pictures. The RetroDiffusion FAQ says the images you generate are yours,
  for personal and commercial projects.
- **FLUX.2 [klein] 4B** (Black Forest Labs, Apache 2.0) on Cloudflare Workers AI, through `scripts/free-art.py` and the
  city card script: 193 pictures, including the 20 city cards.
- **Drawn by code** (`scripts/placeholder-art.mjs`): 1 stand-in.

## Sounds

The engine, footsteps, wind, city, country and ship loops in `templates/sfx/` were made with ElevenLabs sound effects
on a paid plan, which allows commercial use, and are released under CC BY 4.0 by Kyrylo Kozak.

## Radio list

`trips/ukraine-loop/data/radio.json` is a list of station names and their public stream addresses, dedicated to the
public domain under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). The broadcasts belong to the stations;
the game only links to their streams.

## Fonts

Oswald (Copyright 2016 The Oswald Project Authors), Roboto Condensed (Copyright 2011 The Roboto Project Authors) and
Tiny5 (Copyright 2022-2024 The Tiny5 Project Authors), from Google Fonts, self-hosted under the SIL Open Font License
1.1. The full licence is in `templates/fonts/OFL.txt`, and viewer.mjs copies it next to the fonts in every build.

## Music in the video

The music in `docs/pixel-ukraine.mp4` is an 18-second excerpt of a song from a Radio ROKS broadcast. It belongs to its
rights holders and is not released under any licence of this repo. Do not reuse it; the game itself does not ship it.
