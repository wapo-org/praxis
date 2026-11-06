#!/usr/bin/env python3
"""Slow motion from every distinct frame of several identical runs, in true time order (barcode).
usage: g2-slowmo.py frames_dir out.mp4 [viewport_width]"""
import glob, os, shutil, subprocess, sys, tempfile
from PIL import Image
frames_dir, out = sys.argv[1], sys.argv[2]
VW = int(sys.argv[3]) if len(sys.argv) > 3 else 402
def read_time(im):
    s = im.width / VW
    y = int(im.height - 4 * s)
    bit = lambda i: sum(im.getpixel((min(im.width - 1, int((i * 8 + 4) * s)), y))[:3]) > 380
    if not (bit(0) and bit(13)):
        return None
    t = 0
    for i in range(12):
        t = t * 2 + (1 if bit(i + 1) else 0)
    return t
frames = {}
for path in sorted(glob.glob(f'{frames_dir}/*.jpg')):
    with Image.open(path) as im:
        t = read_time(im.convert('RGB'))
    if t is not None and t not in frames:
        frames[t] = path
if not frames:
    raise SystemExit(f'no armed frames in {frames_dir}')
with tempfile.TemporaryDirectory() as tmp:
    ordered = sorted(frames)
    for i, t in enumerate(ordered):
        shutil.copy(frames[t], f'{tmp}/{i:05d}.jpg')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '30', '-i', f'{tmp}/%05d.jpg', '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], check=True)
print(os.path.basename(out), 'frames', len(frames), 'span ms', min(frames), max(frames))
