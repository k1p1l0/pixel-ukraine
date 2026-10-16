#!/usr/bin/env python3
"""qa-sheet.py: a review sheet for a set of finished pictures (TRIP/art/NAME.png after clean.mjs), each shown x3 on grey
with its name, role and flags, plus up to two finished pictures of the same role as references (REF), for an eye or an
agent to check before a release. A dropped picture gets a red label.
  python3 qa-sheet.py --trip TRIP --names a,b,c --out sheet.png [--cols 6] [--refs 2]
"""
import argparse, json, os
from PIL import Image, ImageDraw
ap = argparse.ArgumentParser(); ap.add_argument('--trip', required=True); ap.add_argument('--names', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--cols', type=int, default=6); ap.add_argument('--refs', type=int, default=2); A = ap.parse_args()
kit = json.load(open(os.path.join(A.trip, 'art', 'kit.json')))['pictures']; names = [n for n in A.names.split(',') if n]
def load(n):
    v = kit.get(n, {}); f = os.path.join(A.trip, v.get('file', 'art/%s.png' % n))
    return Image.open(f).convert('RGBA') if os.path.exists(f) else None
cells = [(n, load(n), kit.get(n, {})) for n in names]
roles = []
for n, _, v in cells:
    if v.get('role') not in roles: roles.append(v.get('role'))
for r in roles:   # references: finished pictures of each role that are not in this set
    refs = [m for m, v in kit.items() if v.get('role') == r and not v.get('placeholder') and not v.get('drop') and m not in names][:A.refs]
    cells += [('REF ' + m, load(m), kit[m]) for m in refs]
K = 3; cw = max(im.size[0] for _, im, _ in cells if im) * K + 16; ch = max(im.size[1] for _, im, _ in cells if im) * K + 44
rows = (len(cells) + A.cols - 1) // A.cols; sh = Image.new('RGB', (cw * min(A.cols, len(cells)), ch * rows), (118, 124, 132)); d = ImageDraw.Draw(sh)
for i, (n, im, v) in enumerate(cells):
    x, y = (i % A.cols) * cw + 8, (i // A.cols) * ch + 6
    lab = '%s %s%s' % (n, v.get('role', ''), ' DROP' if v.get('drop') else '') ; d.text((x, y), lab[:44], fill=(255, 120, 110) if v.get('drop') else (255, 255, 255))
    if v.get('flags'): d.text((x, y + 12), ','.join(v['flags'])[:44], fill=(255, 210, 120))
    if im: big = im.resize((im.size[0] * K, im.size[1] * K), Image.NEAREST); sh.paste(big, (x, y + 28), big)
sh.save(A.out); print(A.out, sh.size, len(cells), 'cells')
