"""WP-I1: pixel-compare the main area before (2f19672) and after, outside the sidebar.
python3 apps/web/scripts/i1-compare.py BEFORE_DIR AFTER_DIR OUT_DIR
Writes a side-by-side with a diff panel per capture and prints the share of differing pixels."""
import json
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

BEFORE, AFTER, OUT = sys.argv[1:4]
try:
    FONT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 28)
except OSError:
    FONT = ImageFont.load_default()
meta = json.load(open(f'{AFTER}/main-meta.json'))
before_meta = json.load(open(f'{BEFORE}/main-meta.json'))
worst = 0.0
for tag in ['1440-light', '1440-dark', '402-light', '402-dark']:
    a = Image.open(f'{BEFORE}/main-{tag}.png').convert('RGB')
    b = Image.open(f'{AFTER}/main-{tag}.png').convert('RGB')
    diff = ImageChops.difference(a, b).convert('L').point(lambda v: 255 if v > 8 else 0)
    # Mask the sidebar (the union of both builds' boxes, DPR 2, with its shadow and ring margin).
    mask = Image.new('L', diff.size, 255)
    d = ImageDraw.Draw(mask)
    for m in (meta, before_meta):
        box = m[tag]['sidebar']
        if box:
            pad = 24
            d.rectangle([(box['x'] - pad) * 2, (box['y'] - pad) * 2, (box['x'] + box['width'] + pad) * 2, (box['y'] + box['height'] + pad) * 2], fill=0)
    outside = ImageChops.multiply(diff, mask)
    total = sum(1 for v in mask.getdata() if v)
    changed = sum(1 for v in outside.getdata() if v)
    share = changed / total * 100
    worst = max(worst, share)
    print(f'{tag}: {changed} of {total} pixels differ outside the sidebar ({share:.3f} %)')
    red = Image.new('RGB', a.size, (255, 0, 64))
    overlay = Image.composite(red, b.point(lambda v: v // 3), outside)
    w, h = a.size
    sheet = Image.new('RGB', (w * 3 + 80, h + 60), (128, 128, 128))
    dd = ImageDraw.Draw(sheet)
    for i, (im, label) in enumerate([(a, 'before 2f19672'), (b, 'after (I1)'), (overlay, f'diff outside sidebar {share:.3f} %')]):
        sheet.paste(im, (20 + i * (w + 20), 50))
        dd.text((20 + i * (w + 20), 10), label, fill=(255, 255, 255), font=FONT)
    sheet = sheet.resize((sheet.width // 2, sheet.height // 2), Image.LANCZOS)
    sheet.save(f'{OUT}/main-{tag}-compare.png')
print(f'worst {worst:.3f} %')
