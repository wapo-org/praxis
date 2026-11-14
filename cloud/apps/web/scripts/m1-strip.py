#!/usr/bin/env python3
"""WP-M1 frame strip: every captured frame between from_ms and to_ms (true time read from the barcode m1-capture
draws in each frame), in time order, labelled. usage: m1-strip.py frames_dir out.png from_ms to_ms [cols] [width]
[crop l,t,r,b] [every_ms]"""
import glob, sys
from PIL import Image, ImageDraw

frames_dir, out, t0, t1 = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
cols = int(sys.argv[5]) if len(sys.argv) > 5 else 8
W = int(sys.argv[6]) if len(sys.argv) > 6 else 300
crop = tuple(int(v) for v in sys.argv[7].split(',')) if len(sys.argv) > 7 and sys.argv[7] else None
every = int(sys.argv[8]) if len(sys.argv) > 8 else 0
VW = 1440

def read_time(im):
    scale = im.width / VW
    y = im.height - 4 * scale
    px = lambda i: im.getpixel((min(im.width - 1, int((i * 8 + 4) * scale)), int(y)))
    bit = lambda i: sum(px(i)[:3]) > 380
    if not (bit(0) and bit(15)):
        return None
    t = 0
    for i in range(14):
        t = t * 2 + (1 if bit(i + 1) else 0)
    return t

frames = {}
for path in sorted(glob.glob(f'{frames_dir}/*.jpg')):
    with Image.open(path) as im:
        rgb = im.convert('RGB')
        t = read_time(rgb)
    if t is None or t < t0 or t > t1 or t in frames:
        continue
    frames[t] = path
times = sorted(frames)
if every:
    picked, last = [], None
    for t in times:
        if last is None or t - last >= every:
            picked.append(t); last = t
    times = picked
gaps = [b - a for a, b in zip(times, times[1:])]
print(f'{len(times)} frames {t0}-{t1} ms; median gap {sorted(gaps)[len(gaps)//2] if gaps else 0} ms; max gap {max(gaps) if gaps else 0} ms')
tiles = []
for t in times:
    with Image.open(frames[t]) as im:
        im = im.convert('RGB')
        if crop: im = im.crop(crop)
        im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, 74, 18), fill=(255, 220, 0))
        d.text((4, 3), f't={t}ms', fill=(0, 0, 0))
        tiles.append(im)
if not tiles:
    sys.exit('no frames')
h = tiles[0].height
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (W + 4), rows * (h + 4)), (255, 255, 255))
for i, im in enumerate(tiles):
    sheet.paste(im, ((i % cols) * (W + 4), (i // cols) * (h + 4)))
sheet.save(out)
