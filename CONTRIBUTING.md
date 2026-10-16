# Contributing

Bug reports, fixes and new pictures are welcome. For anything bigger than a small fix, open an issue first so two people
don't build the same thing.

## Code

Plain JavaScript modules and Node scripts, no build step and no dependencies. Read the comments at the top of a file
before you change it; they say what the file does and why. Keep the style of the file you are in.

Before you open a pull request:

```sh
node scripts/mp/core-test.mjs        # the room logic
node scripts/mp/votes-test.mjs       # the city vote's parsing
node scripts/mp/rooms-test.mjs       # the open world's rooms, with fake riders and a fake clock
node scripts/viewer.mjs --trip trips/ukraine-loop --serve 8080   # then ride the part you changed
```

Never test multiplayer in the open world of the live game. Use a room of your own, for example `?room=test-yourname`,
and `?ph=0` so your test rides stay out of the analytics.

## Art

Every region needs its own pictures: facades, trees, bushes, street props, cars, billboards and landmarks. Many are still
code-drawn stand-ins or could look better. [ROADMAP.md](ROADMAP.md) lists what is wanted most.

### The flow

1. Claim an issue. Pick an open issue labelled `art`, or open one that names the pictures you want to make (for
   example `odesa-house-1..4`), and say you are taking it. Picture names come from `trips/ukraine-loop/art/plan.json`:
   each job there has the name, the role, the region and the size.
2. Make the pictures in one of these ways:
   - With your own free Workers AI account. Cloudflare's free plan gives 10,000 neurons a day, about 380 FLUX.2 klein
     pictures. Run the local proxy with your own login, then the free-art script:
     ```sh
     cd scripts/ai && npx --yes wrangler@4.77.0 dev --port 8795 --ip 127.0.0.1
     python3 scripts/free-art.py --trip trips/ukraine-loop --only odesa-house-1,odesa-house-2
     ```
     The proxy only runs on your machine. Never `wrangler deploy` it: it has no auth. `free-art.py` needs Python 3 and
     Pillow (`pip install pillow`). The subjects are in `trips/ukraine-loop/art/free-prompts.json`.
   - With FLUX.1-schnell on your own machine, in any local runner. Save the result as
     `trips/ukraine-loop/art/raw/<name>.png`.
   - By hand, in any pixel editor. Use the palette in `templates/palette.png` and the size from `plan.json`, and save
     it as `trips/ukraine-loop/art/raw/<name>.png` on a white background.
3. Clean them. `clean.mjs` removes the backdrop, fills holes in facades, hardens the edges and crops:
   ```sh
   node scripts/clean.mjs --trip trips/ukraine-loop --only odesa-house-1,odesa-house-2
   ```
   Open `trips/ukraine-loop/art/contact.png` and look at every picture you made.
4. Run the art check, which applies the same rules as CI:
   ```sh
   node scripts/art-check.mjs --trip trips/ukraine-loop --only odesa-house-1,odesa-house-2
   ```
   A picture passes when it is an 8-bit RGBA PNG with every pixel fully clear or fully opaque, no bigger than its plan
   size, at most 48 colours, at most 16 KB, with no single colour over 80% of it, and with none of `clean.mjs`'s drop
   flags (`boxed`, `sky`, `narrow`). City cards (`--cards`) are opaque squares, so they may be 8-bit RGB. A few
   pictures have `"keep": true` in `kit.json`: a maintainer looked at them and approved them, so they skip the drop
   flags. Leave that flag to the review, and don't add it yourself.
5. Open a pull request with the PNGs, the `kit.json` changes that `clean.mjs` made, and an entry for each picture in
   `trips/ukraine-loop/art/SOURCES.json`: the source, the model, the licence and your name. Don't commit `art/raw/` or
   the ledgers; git ignores them.

### Allowed sources

- FLUX.1-schnell (Apache 2.0)
- FLUX.2-klein (FLUX.2 [klein] 4B, Apache 2.0), with or without reference pictures
- hand-drawn pictures

FLUX.1-dev is under a non-commercial licence, so pictures from it are rejected. So are pictures made with a LoRA or
fine-tune under a non-commercial licence, and pictures traced from photos or art you don't own.

By opening a pull request you agree to release your pictures under CC BY 4.0, credited in `SOURCES.json`.

### What a good picture looks like

- One object, seen straight on, on a clear background: one building, one tree, one car.
- The real look of the region, such as Stalinist blocks on Khreshchatyk or whitewashed khaty in a village.
- No real brand names, logos or readable shop signs, and no recognisable people.
- Pixel art with hard edges and few colours, in the palette's tones.
