#!/usr/bin/env python3
"""free-art.py: the art plan's pictures from Cloudflare Workers AI's free daily allowance (FLUX.2 klein or FLUX.1 schnell),
turned into pixel art at the plan's size and written where rd.mjs writes (TRIP/art/raw/NAME.png), so clean.mjs takes over
exactly as for RetroDiffusion pictures. No key: it goes through the local proxy, which uses your logged-in wrangler account:
    cd scripts/ai && npx wrangler@4 dev --port 8795 --ip 127.0.0.1
  python3 free-art.py --trip TRIP --placeholders            every picture that is still a placeholder in art/kit.json
  python3 free-art.py --trip TRIP --only a,b --regen         a new attempt (new seed) at these
  python3 free-art.py --trip TRIP --only a,b --variants klein,klein-ref --quants snap:28:10,palette --out DIR
                                                             a bake-off: every combination into DIR/NAME/, plus DIR/NAME.sheet.png
Prompts: TRIP/art/free-prompts.json (--prompts FILE) maps a picture name to {subject, tone, person, ref, skip}. The subject is
  one noun phrase for one object; the script wraps it in a template for the picture's role (the view, the backdrop and the
  negatives that a judged test showed this model needs). tone "pale" (white, cream or silver subjects) puts it on a mid-grey
  backdrop, anything else on white. ref names a finished picture of the SAME kind of object as a style reference (the model
  copies the reference's object, so never a different object); skip leaves the picture alone. A picture without an entry
  uses the plan's prompt as it is.
Options: --model klein|schnell (default klein)  --ref auto|none|nearest (auto: the prompts file's ref, klein only; nearest:
  any finished picture of the same role from the nearest region)  --quant snap:N:D|adaptive:N|palette (default snap:28:10:
  N colours (fast octree), each snapped to the game palette, templates/palette.png, when within D in Lab; palette: every pixel to the
  palette)  --extra "text" (appended to every prompt)  --budget N (neurons per UTC day, default 9000; the free allowance is
  10,000)  --parallel 3
Ledger: TRIP/art/free-ledger.json (neurons per UTC day and every attempt). Originals are kept in TRIP/art/raw-free/ under a
hash of the request, so a new --quant or crop never pays twice and a new prompt never reuses an old picture.
"""
import argparse, base64, datetime, hashlib, io, json, os, re, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY = os.environ.get('PIXEL_PATH_AI', 'http://127.0.0.1:8795/gen')
NEURONS = {'klein': 26.05, 'klein-ref': 26.05 + 5.37, 'schnell': 57.6}   # every size here is one 512x512 tile
STYLE = ' Crisp hard-edged pixel art with visible square pixels, a limited colour palette, flat shading, dark outlines.'
REF_PRE = ('Use the reference image only as a style guide: copy its pixel art style, colours, outlines, shading and level of '
           'detail. The subject: ')
REF_POST = " Draw only this subject. Do not copy the reference's object, its layout or its lettering."
LEGACY_REF = ('Use the reference image only as a style guide: copy its pixel art style, its colours, its outlines and shading and '
              'its level of detail, but draw a completely different subject, not the one in the reference. The subject: ')
BACK = {'white': ('alone on a plain flat pure white background', (255, 255, 255)),
        'grey': ('alone on a plain flat solid medium grey (#808080) background', (128, 128, 128))}
FACADE = {'house', 'farm', 'shop', 'apartment', 'tower', 'terrace', 'industrial', 'civic', 'church'}
POCKETS = {'tree', 'bush', 'landmark'}   # roles whose enclosed backdrop pockets are holes (gaps in a crown, under an arm)
GROUNDED = {'tree', 'bush', 'street', 'car', 'oncoming', 'board', 'landmark'}   # sprites: a painted ground strip is cut off

ap = argparse.ArgumentParser()
ap.add_argument('--trip', required=True); ap.add_argument('--only'); ap.add_argument('--placeholders', action='store_true')
ap.add_argument('--regen', action='store_true'); ap.add_argument('--model', default='klein'); ap.add_argument('--ref', default='auto')
ap.add_argument('--quant', default='snap:28:10'); ap.add_argument('--variants'); ap.add_argument('--quants'); ap.add_argument('--out')
ap.add_argument('--prompts'); ap.add_argument('--extra', default=''); ap.add_argument('--budget', type=float, default=9000)
ap.add_argument('--parallel', type=int, default=3); ap.add_argument('--dry', action='store_true', help='print the prompts, call nothing')
A = ap.parse_args()
ART = os.path.join(A.trip, 'art'); RAW = os.path.join(ART, 'raw'); ORIG = os.path.join(ART, 'raw-free'); LEDGER = os.path.join(ART, 'free-ledger.json')
plan = json.load(open(os.path.join(ART, 'plan.json'))); JOBS = {j['name']: j for j in plan['jobs']}; THEMES = [t['id'] for t in plan['themes']]
kit = json.load(open(os.path.join(ART, 'kit.json')))['pictures']
PF = A.prompts or os.path.join(ART, 'free-prompts.json'); SPECS = json.load(open(PF)) if os.path.exists(PF) else {}
lock = threading.Lock(); stop = threading.Event(); FAST = [0]   # fast failures in a row: the proxy or its session is broken
ledger = json.load(open(LEDGER)) if os.path.exists(LEDGER) else {'days': {}, 'attempts': {}, 'jobs': {}}

def today(): return datetime.datetime.utcnow().strftime('%Y-%m-%d')
def save():
    with open(LEDGER + '.tmp', 'w') as f: json.dump(ledger, f, indent=1, ensure_ascii=False)
    os.replace(LEDGER + '.tmp', LEDGER)

def gen_size(w, h):   # the plan's aspect, longest side 512 (one tile), sides multiples of 16, at least 256
    s = 512 / max(w, h); return max(256, int(round(w * s / 16)) * 16), max(256, int(round(h * s / 16)) * 16)

def backdrop(job): return 'grey' if SPECS.get(job['name'], {}).get('tone') == 'pale' else 'white'

def compose(job):
    """The prompt: the role's template around the prompts file's subject, or the plan's own prompt."""
    sp = SPECS.get(job['name'])
    if not sp or not sp.get('subject'): return job['prompt'] + STYLE + (' ' + A.extra if A.extra else '')
    s = sp['subject'].strip().rstrip('.'); role = job['role']; bg = BACK[backdrop(job)][0]
    bare = re.sub(r'^(a|an|one|the)\s+', '', s, flags=re.I)
    if role in FACADE: p = ('The full front elevation of %s, seen straight on, flat front view, the whole building from the roof to the base filling the picture, %s. '
                            'No ground, no pavement, no grass, no trees or plants, no people, no cars, no cast shadow, no scenery, no frame. Blank signboards: no lettering, no numbers, no logos.') % (s, bg)
    elif role == 'street' and sp.get('person'): p = '%s: one adult, the full body from the head to the shoes, standing and facing the viewer, %s. No ground, no shadow, no scenery, no frame, no lettering.' % (s, bg)
    elif role == 'street': p = '%s, the whole object, %s. No ground, no grass, no shadow, no scenery, no frame, no lettering.' % (s, bg)
    elif role in ('car', 'oncoming'): p = ('%s, seen exactly from %s at road level, the whole vehicle, %s. Blank number plate. No road, no ground, no shadow, no scenery, no frame, no lettering, no logos.'
                                          % (s, 'directly behind' if role == 'car' else 'the front', bg))
    elif role == 'tree': p = 'A single isolated %s, the whole tree from the top of the crown to the foot of the trunk, %s. No ground, no grass, no other plants, no shadow, no scenery, no frame.' % (bare, bg)
    elif role == 'bush': p = 'A single isolated %s, the whole shrub, %s. No ground, no grass, no other plants, no shadow, no scenery, no frame.' % (bare, bg)
    elif role == 'board': p = '%s, the whole board and its posts, %s. The poster is only a picture: no lettering, no numbers, no logos. No ground, no grass, no shadow, no scenery, no frame.' % (s, bg)
    elif role == 'landmark': p = '%s, %s. No ground except its own plinth or base, no shadow, no scenery, no frame, no lettering.' % (s, bg)
    else: p = '%s, %s. No ground, no shadow, no scenery, no frame, no lettering.' % (s, bg)
    return p[0].upper() + p[1:] + STYLE + (' ' + A.extra if A.extra else '')

def ref_pic(name, bg):
    v = kit.get(name); f = v and os.path.join(A.trip, v.get('file', 'art/%s.png' % name))
    if not v or v.get('placeholder') or v.get('drop') or not os.path.exists(f): return None
    im = Image.open(f).convert('RGBA'); k = max(1, 496 // max(im.size)); im = im.resize((im.size[0] * k, im.size[1] * k), Image.NEAREST)
    out = Image.new('RGBA', im.size, BACK[bg][1] + (255,)); out.alpha_composite(im); buf = io.BytesIO(); out.convert('RGB').save(buf, 'PNG')
    return name, base64.b64encode(buf.getvalue()).decode()

def ref_for(job, how):
    """The style reference: the prompts file's choice (auto), any finished picture of the role from the nearest region (nearest), or none."""
    if how == 'none': return None
    sp = SPECS.get(job['name'], {})
    if how == 'auto': return ref_pic(sp['ref'], backdrop(job)) if sp.get('ref') else None
    ti = THEMES.index(job['theme']) if job.get('theme') in THEMES else 0
    cands = [n for n, v in kit.items() if v.get('role') == job['role'] and not v.get('placeholder') and not v.get('drop')
             and os.path.exists(os.path.join(A.trip, v.get('file', 'art/%s.png' % n)))]
    if not cands: return None
    def score(n):
        t = kit[n].get('theme'); return (abs(THEMES.index(t) - ti) if t in THEMES else 99, int(hashlib.sha1((job['name'] + n).encode()).hexdigest()[:6], 16))
    return ref_pic(min(cands, key=score), backdrop(job))

def book(cost):   # reserve the neurons before the call, so a crash never hides usage
    with lock:
        day = ledger['days'].setdefault(today(), 0)
        if stop.is_set() or day + cost > A.budget: stop.set(); return False
        ledger['days'][today()] = round(day + cost, 2); save(); return True

def generate(job, variant, attempt):
    """The original picture for this job, variant and attempt: from the cache, or one call through the proxy."""
    model = 'schnell' if variant == 'schnell' else 'klein'; w, h = gen_size(job['width'], job['height']); prompt = compose(job)
    body = {'model': model, 'prompt': prompt, 'width': w, 'height': h}; r = None
    if model == 'klein': body['seed'] = (int(job.get('seed') or 1) + attempt * 7919) % 2147483647
    if variant == 'klein-ref':
        r = ref_for(job, 'nearest' if A.ref == 'nearest' else 'auto')
        if r: body['refs'] = [r[1]]; body['prompt'] = (REF_PRE + prompt + REF_POST) if SPECS.get(job['name'], {}).get('subject') else LEGACY_REF + prompt
        else: variant = 'klein'
    key = hashlib.sha1(json.dumps([body['prompt'], w, h, body.get('seed'), r and r[0]]).encode()).hexdigest()[:8]
    os.makedirs(ORIG, exist_ok=True); path = os.path.join(ORIG, '%s.%s.a%d.%s.jpg' % (job['name'], variant, attempt, key))
    if os.path.exists(path): return path, 0
    if A.dry: print('--', job['name'], variant, w, h, 'ref', r and r[0], '\n  ', body['prompt']); return None, 0
    cost = NEURONS[variant]
    for tries in range(3):   # every try is a paid call: book it; a flagged output gets a new seed (the filter has false positives)
        if not book(cost): return None, 0
        t0 = time.time()
        try:
            req = urllib.request.Request(PROXY, json.dumps(body).encode(), {'content-type': 'application/json'})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            if 'image' not in d: raise RuntimeError(d.get('error', 'no image'))
            open(path, 'wb').write(base64.b64decode(d['image'])); FAST[0] = 0
            with lock: ledger['jobs'].setdefault(job['name'], []).append({'variant': variant, 'attempt': attempt, 'file': os.path.relpath(path, ART), 'neurons': cost, 'at': datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z', 'ref': r and r[0], 'key': key}); save()
            return path, cost
        except Exception as e:
            msg = str(getattr(e, 'read', lambda: b'')() or e)
            if '4006' in msg or 'daily free allocation' in msg or 'neurons' in msg.lower():
                print('STOP: the free daily allowance is used up (%s)' % msg[:160]); stop.set(); return None, 0
            if time.time() - t0 < 3:   # back in under 3 s: the model never ran (it takes about 11 s), so nothing was used
                with lock:
                    ledger['days'][today()] = round(ledger['days'][today()] - cost, 2); save(); FAST[0] += 1
                    if FAST[0] >= 8 and not stop.is_set(): print('STOP: the proxy failed 8 calls in a row at once (%s); restart it (wrangler dev) and run again' % msg[:120]); stop.set()
                if stop.is_set(): return None, 0
            if tries == 2: print('FAILED %s %s: %s' % (job['name'], variant, msg[:200])); return None, 0
            if '3030' in msg and 'seed' in body: body['seed'] = (body['seed'] + 104729) % 2147483647
            time.sleep(4 * (tries + 1))

# ---- colours: the game palette and a small Lab conversion for snapping
PAL = None
def palette_cols():
    global PAL
    if PAL is None: PAL = [c for _, c in Image.open(os.path.join(SKILL, 'templates', 'palette.png')).convert('RGB').getcolors(4096)]
    return PAL
def palette_img():
    cols = palette_cols(); flat = [v for c in cols for v in c]; flat += flat[-3:] * (256 - len(cols)); p = Image.new('P', (1, 1)); p.putpalette(flat); return p
def lab(c):
    def lin(v): v /= 255; return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in c); x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047; y = 0.2126 * r + 0.7152 * g + 0.0722 * b; z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))
def de(a, b): return sum((p - q) ** 2 for p, q in zip(a, b)) ** 0.5

def quantize(rgb, quant, alpha=None):
    if quant == 'palette': return rgb.quantize(palette=palette_img(), dither=Image.NONE).convert('RGB')
    n = int(quant.split(':')[1]); src = rgb
    if alpha is not None:   # the colours come from the subject only: the see-through part (three quarters of a person's frame) is black here and took most of them
        px = [c for c, a in zip(rgb.getdata(), alpha.getdata()) if a]
        if px: src = Image.new('RGB', (len(px), 1)); src.putdata(px)
    pal = src.quantize(colors=n, method=2, dither=Image.NONE).getpalette()[:3 * n]; k = len(pal) // 3   # 2 = fast octree: on 43 test pictures its 99th-percentile error was 12 against median cut's 19 (median cut greyed faces)
    pimg = Image.new('P', (1, 1)); pimg.putpalette(pal + pal[-3:] * (256 - k)); q = rgb.quantize(palette=pimg, dither=Image.NONE)
    if not quant.startswith('snap'): return q.convert('RGB')
    lim = float(quant.split(':')[2]) if quant.count(':') >= 2 else 10; P = [(c, lab(c)) for c in palette_cols()]
    for i in range(k):   # every cluster colour near a palette colour becomes it; the rest (skin, silver, olive...) stay
        c = tuple(pal[3 * i:3 * i + 3]); lc = lab(c); best = min(P, key=lambda pc: de(pc[1], lc)); ch, cb = (lc[1] ** 2 + lc[2] ** 2) ** 0.5, (best[1][1] ** 2 + best[1][2] ** 2) ** 0.5
        if de(best[1], lc) <= lim and not (ch >= 8 and cb < ch / 2): pal[3 * i:3 * i + 3] = best[0]   # a muted warm colour (skin in shade) never snaps to a grey
    q.putpalette(pal + pal[-3:] * (256 - k)); return q.convert('RGB')

# ---- cut-out
RIM = 3   # the model's pictures have a slightly darker rim of 1 to 3 pixels at the edges: always backdrop
def border_colour(im):
    w, h = im.size; px = im.load(); e = RIM + 1; pts = [px[x, y] for x in range(e, w - e, 2) for y in (e, h - 1 - e)] + [px[x, y] for y in range(e, h - e, 2) for x in (e, w - 1 - e)]
    return tuple(sorted(p[i] for p in pts)[len(pts) // 2] for i in range(3))

def cut_backdrop(im, role):
    """The flat backdrop (its colour read from the border: white, grey or whatever came) flooded away from the edges; for
    trees, bushes and landmarks also the enclosed pockets of it (gaps in a crown). Returns RGBA."""
    im = im.convert('RGB'); w, h = im.size; px = im.load(); c0 = border_colour(im); white = min(c0) >= 225
    if white: near = lambda c: min(c) >= 222 and max(c) - min(c) <= 30; tight = lambda c: min(c) >= 238 and max(c) - min(c) <= 14
    else:
        near = lambda c: (c[0] - c0[0]) ** 2 + (c[1] - c0[1]) ** 2 + (c[2] - c0[2]) ** 2 <= 34 * 34
        tight = lambda c: (c[0] - c0[0]) ** 2 + (c[1] - c0[1]) ** 2 + (c[2] - c0[2]) ** 2 <= 16 * 16
    alpha = bytearray(b'\xff') * (w * h); seen = bytearray(w * h)
    def flood(seeds, ok, out):
        st = list(seeds); n = 0
        while st:
            x, y = st.pop(); i = y * w + x
            if seen[i]: continue
            seen[i] = 1
            if not ok(px[x, y]): continue
            out.append(i); n += 1
            if x > 0: st.append((x - 1, y))
            if x < w - 1: st.append((x + 1, y))
            if y > 0: st.append((x, y - 1))
            if y < h - 1: st.append((x, y + 1))
        return n
    r = RIM
    for y in range(h):
        for x in (range(w) if y < r or y >= h - r else list(range(r)) + list(range(w - r, w))): i = y * w + x; alpha[i] = 0; seen[i] = 1
    outer = []; flood([(x, r) for x in range(r, w - r)] + [(x, h - 1 - r) for x in range(r, w - r)] + [(r, y) for y in range(r, h - r)] + [(w - 1 - r, y) for y in range(r, h - r)], near, outer)
    for i in outer: alpha[i] = 0
    if role in POCKETS:
        seen = bytearray(w * h); minarea = max(12, int(w * h * 0.0004))
        for i in outer: seen[i] = 1
        for y in range(h):
            for x in range(w):
                if seen[y * w + x] or not tight(px[x, y]): continue
                comp = []; flood([(x, y)], tight, comp)
                if len(comp) >= minarea:
                    for i in comp: alpha[i] = 0
    # loose specks (JPEG noise, a stray dot) are not part of the subject: opaque pieces under 0.03% of the picture go
    seen = bytearray(w * h); minpiece = max(10, int(w * h * 0.0003))
    for i0 in range(w * h):
        if seen[i0] or not alpha[i0]: continue
        st = [i0]; comp = []; seen[i0] = 1
        while st:
            i = st.pop(); comp.append(i); x, y = i % w, i // w
            for j in ((i - 1) if x > 0 else -1, (i + 1) if x < w - 1 else -1, (i - w) if y > 0 else -1, (i + w) if y < h - 1 else -1):
                if j >= 0 and not seen[j] and alpha[j]: seen[j] = 1; st.append(j)
        if len(comp) < minpiece:
            for i in comp: alpha[i] = 0
    out = im.convert('RGBA'); out.putalpha(Image.frombytes('L', (w, h), bytes(alpha))); return out

def cut_ground(sub, frac=0.08, facade=False):
    """A thin strip at the base (a painted ground line or shadow, wider than the subject above it) is cut off. A sprite's
    strip spans the whole picture; a facade's may end under the eaves, so there it only has to stick out past the walls on
    both sides (by 3% of the width or more). A strip left on a facade closes the gaps under the eaves, and clean.mjs then
    fills them as dark holes."""
    a = sub.getchannel('A'); w, h = sub.size; d = a.load(); cover = [sum(1 for x in range(w) if d[x, y] > 0) / w for y in range(h)]
    lim = max(2, int(h * frac)); y0 = h - 1
    while y0 > h - 4 and cover[y0] < 0.05: y0 -= 1   # a stray JPEG crumb hanging under the strip belongs to it
    y = y0
    while y > 0 and cover[y] >= 0.92: y -= 1
    band = y0 - y
    if 0 < band <= lim and cover[y] < 0.8: return sub.crop((0, 0, w, y + 1))
    if facade:
        def ext(y):
            xs = [x for x in range(w) if d[x, y] > 0]; return (xs[0], xs[-1], len(xs)) if xs else None
        b = ext(y0); m = max(2, int(w * 0.03))
        if b and b[2] >= 0.9 * (b[1] - b[0] + 1):   # one unbroken line, not feet, posts or wheels
            for y in range(y0 - 1, max(0, y0 - 1 - lim), -1):
                e = ext(y)
                if not e: break
                if e[0] >= b[0] + m and e[1] <= b[1] - m: return sub.crop((0, 0, w, y + 1))   # the walls: narrower on both sides
    return sub

def process(path, job, quant):
    """Original -> the plan's size: cut out, cropped to the subject, fitted with a 2 px margin, hard alpha, colours reduced."""
    big = cut_backdrop(Image.open(path), job['role']); box = big.getchannel('A').getbbox()
    if not box: return None
    sub = big.crop(box)
    if job['role'] in GROUNDED or job['role'] in FACADE:
        sub = cut_ground(sub, 0.08 if job['role'] in GROUNDED else 0.04, job['role'] in FACADE); box = sub.getchannel('A').getbbox()
        if not box: return None
        sub = sub.crop(box)
    tw, th = job['width'], job['height']; s = min((tw - 4) / sub.size[0], (th - 4) / sub.size[1])
    nw, nh = max(1, int(round(sub.size[0] * s))), max(1, int(round(sub.size[1] * s)))
    small = sub.convert('RGBa').resize((nw, nh), Image.BOX).convert('RGBA')
    a = small.getchannel('A').point(lambda v: 255 if v >= 128 else 0); small = quantize(small.convert('RGB'), quant, a).convert('RGBA'); small.putalpha(a)
    canvas = Image.new('RGBA', (tw, th), (0, 0, 0, 0)); canvas.alpha_composite(small, ((tw - nw) // 2, th - 2 - nh)); return canvas

def sheet(name, cells, refs, out):   # one row per subject: every candidate x3 on grey, then the references, labelled
    tiles = [(lab_, im) for lab_, im in cells if im is not None] + [('REF ' + n, im) for n, im in refs]
    if not tiles: return
    k = 3; W = sum(im.size[0] * k + 12 for _, im in tiles) + 12; H = max(im.size[1] for _, im in tiles) * k + 40
    sh = Image.new('RGB', (W, H), (118, 124, 132)); d = ImageDraw.Draw(sh); x = 12
    for lab_, im in tiles:
        big = im.resize((im.size[0] * k, im.size[1] * k), Image.NEAREST); sh.paste(big, (x, 28), big); d.text((x, 8), lab_[:34], fill=(255, 255, 255)); x += big.size[0] + 12
    d.text((12, H - 12), name, fill=(255, 240, 160)); sh.save(out)

def names():
    if A.only: return [n.strip() for n in A.only.split(',') if n.strip()]
    if A.placeholders: return [n for n, v in kit.items() if v.get('placeholder') and n in JOBS]
    sys.exit('say --only a,b or --placeholders')

todo = [JOBS[n] for n in names() if n in JOBS and not SPECS.get(n, {}).get('skip')]; done = []
def run(job):
    if stop.is_set(): return
    n = job['name']
    if A.out:   # bake-off: every variant x quant into OUT/NAME/
        os.makedirs(os.path.join(A.out, n), exist_ok=True); cells = []
        for v in A.variants.split(','):
            p, _ = generate(job, v, 0)
            for qn in A.quants.split(','):
                im = process(p, job, qn) if p else None
                if im is not None: im.save(os.path.join(A.out, n, '%s__%s.png' % (v, qn.replace(':', ''))))
                cells.append(('%s %s' % (v, qn), im))
        rn = SPECS.get(n, {}).get('ref'); refs = [(rn, Image.open(os.path.join(A.trip, kit[rn].get('file', 'art/%s.png' % rn))).convert('RGBA'))] if rn in kit else []
        sheet(n, cells, refs, os.path.join(A.out, n + '.sheet.png')); print('bake-off', n); return
    with lock:
        att = ledger['attempts'].get(n, 0) + (1 if A.regen else 0); ledger['attempts'][n] = att; save()
    variant = A.model + ('-ref' if A.model == 'klein' and A.ref != 'none' else '')
    p, cost = generate(job, variant, att)
    if not p: return
    im = process(p, job, A.quant)
    if im is None: print('EMPTY', n); return
    os.makedirs(RAW, exist_ok=True); im.save(os.path.join(RAW, n + '.png')); done.append(n)
    with lock:   # clean.mjs reads this: a picture cut off a grey backdrop keeps its white parts (it checks the hash, so a later re-roll by rd.mjs is cleaned as usual)
        ledger.setdefault('cut', {})[n] = {'sha1': hashlib.sha1(open(os.path.join(RAW, n + '.png'), 'rb').read()).hexdigest(), 'backdrop': backdrop(job)}; save()
    print('done %s (attempt %d, %s neurons, today %s)' % (n, att, cost, ledger['days'].get(today())), flush=True)

with ThreadPoolExecutor(max_workers=A.parallel) as ex: list(ex.map(run, todo))
if not A.dry:
    print('%d pictures written; neurons today (UTC %s): %s of the %s budget%s' % (len(done), today(), ledger['days'].get(today(), 0), A.budget, ' (STOPPED at the budget or allowance)' if stop.is_set() else ''))
    if done and not A.out: print('Next: node clean.mjs --trip %s' % A.trip)
