#!/usr/bin/env python3
"""Board from a recording: our frames (true time read from each frame's barcode) above reference frames.
usage: g2-board.py frames_dir out.png '<json>'
json: {viewport:[w,h], crop:[l,t,r,b] in CSS px, ref:[[ms,num]...], refDir, refCrop, times?:[ms...], select?:prefix}"""
import glob, json, os, sys
from PIL import Image, ImageDraw
frames_dir, out, opts = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
vw, vh = opts['viewport']
def read_time(im):
    scale = im.width / vw
    y = im.height - 4 * scale
    px = lambda i: im.getpixel((min(im.width - 1, int((i * 8 + 4) * scale)), int(y)))
    bit = lambda i: sum(px(i)[:3]) > 380
    if not (bit(0) and bit(13)):
        return None
    t = 0
    for i in range(12):
        t = t * 2 + (1 if bit(i + 1) else 0)
    return t
frames = []
for path in sorted(glob.glob(f'{frames_dir}/*.jpg')):
    if opts.get('select') and not os.path.basename(path).startswith(opts['select']):
        continue
    with Image.open(path) as im:
        rgb = im.convert('RGB')
        t = read_time(rgb)
    if t is not None:
        frames.append((t, path))
print('frames', len(frames), 'distinct', len({t for t, _ in frames}))
W = 280
def fit(im, box):
    im = im.crop(box) if box else im
    return im.resize((W, round(im.height * W / im.width)), Image.LANCZOS).convert('RGB')
ref = opts.get('ref')
times = [ms for ms, _ in ref] if ref else opts['times']
refs = {ms: fit(Image.open(f"{opts['refDir']}/IMG_{num}.PNG"), opts['refCrop']) for ms, num in ref} if ref else {}
ours, chosen = [], []
for ms in times:
    at, path = min(frames, key=lambda f: abs(f[0] - ms))
    im = Image.open(path).convert('RGB')
    s = im.width / vw
    ours.append(fit(im, [round(v * s) for v in opts['crop']]))
    chosen.append((ms, at))
print(' '.join(f'{a}:{b}' for a, b in chosen))
cols = opts.get('cols', 7)
oh = ours[0].height
rh = next(iter(refs.values())).height if refs else 0
rows = (len(ours) + cols - 1) // cols
cell = oh + 18 + (rh + 16 if refs else 0)
board = Image.new('RGB', (cols * (W + 4), rows * cell), (24, 24, 24))
d = ImageDraw.Draw(board)
for i, (ms, at) in enumerate(chosen):
    x, y = (i % cols) * (W + 4), (i // cols) * cell
    d.text((x + 4, y + 2), f"ours {ms} ms (frame at {at})", fill=(255, 220, 90))
    board.paste(ours[i], (x, y + 16))
    if refs:
        d.text((x + 4, y + 18 + oh), f"reference {ms} ms", fill=(120, 220, 255))
        board.paste(refs[ms], (x, y + 32 + oh))
board.save(out)
