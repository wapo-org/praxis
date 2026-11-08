"""WP-H3: compose h3-capture.mjs output into the gate images.
python3 apps/web/scripts/h3-compare.py RAW OUT"""
import sys
from PIL import Image, ImageDraw, ImageFont

RAW, OUT = sys.argv[1], sys.argv[2]
UPLOADS = sys.argv[3] if len(sys.argv) > 3 else None
PALETTES = ['graphite', 'midnight', 'forest', 'plum', 'sand', 'paper']
try:
    FONT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 26)
except OSError:
    FONT = ImageFont.load_default()
BG = (128, 128, 128)
o = lambda n: Image.open(f'{RAW}/{n}.png').convert('RGB')


def row(images, labels, gap=24, head=44):
    w = sum(i.width for i in images) + gap * (len(images) + 1)
    h = max(i.height for i in images) + head + gap
    sheet = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(sheet)
    x = gap
    for im, label in zip(images, labels):
        d.text((x, 8), label, fill=(255, 255, 255), font=FONT)
        sheet.paste(im, (x, head))
        x += im.width + gap
    return sheet


def stack(sheets):
    w = max(s.width for s in sheets)
    sheet = Image.new('RGB', (w, sum(s.height for s in sheets)), BG)
    y = 0
    for s in sheets:
        sheet.paste(s, (0, y))
        y += s.height
    return sheet


half = lambda im: im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
for p in PALETTES:
    for t in ['light', 'dark']:
        side = row([o(f'{p}-{t}-ref-sidebar'), o(f'{p}-{t}-ours-sidebar'), o(f'{p}-{t}-long-ref-sidebar'), o(f'{p}-{t}-long-ours-sidebar')],
                   [f'{p}, app {t}: v2 HTML', 'ours (DPR 2)', 'HTML, 40 chats', 'ours, 40 chats'])
        full = row([half(o(f'{p}-{t}-ref-full')), half(o(f'{p}-{t}-ours-full'))], ['v2 HTML 1440x900 (shown at 1x)', 'ours 1440x900 (shown at 1x)'])
        stack([side, full]).save(f'{OUT}/compare-{p}-{t}.png')

# The rim: 4x crops of the top-right (lit) and top-left corners, HTML vs ours, dark app, with the owner's crops.
x4 = lambda im: im.resize((im.width * 4, im.height * 4), Image.NEAREST)
rows = []
for p in ['graphite', 'forest', 'midnight', 'sand']:
    ref, ours = o(f'{p}-dark-ref-sidebar'), o(f'{p}-dark-ours-sidebar')
    tr = lambda im: x4(im.crop((im.width - 90, 0, im.width, 90)))
    tl = lambda im: x4(im.crop((0, 0, 90, 90)))
    rows.append(row([tr(ref), tr(ours), tl(ref), tl(ours)], [f'{p} lit corner: HTML', 'ours', 'dark corner: HTML', 'ours']))
if UPLOADS:
    owner = [Image.open(f'{UPLOADS}/{n}').convert('RGB') for n in ['pasted-1794101162758-0.png', 'pasted-1794101222618-0.png']]
    owner = [im.resize((int(im.width * 360 / im.height), 360)) for im in owner]
    rows.insert(0, row(owner, ["owner's crop (Forest?)", "owner's crop (Graphite)"]))
stack(rows).save(f'{OUT}/rim-corner.png')
print('ok')
