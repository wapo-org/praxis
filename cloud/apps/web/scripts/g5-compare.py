"""WP-G5: compose g5-capture.mjs and g5-composer.mjs output into the gate images.
python3 -I apps/web/scripts/g5-compare.py RAW OUT"""
import sys
from PIL import Image, ImageDraw, ImageFont

RAW, OUT = sys.argv[1], sys.argv[2]
PALETTES = ['graphite', 'midnight', 'forest', 'plum', 'sand', 'paper']
BUTTONS = ['white', 'cyan', 'navy', 'gray', 'graphite', 'coral', 'lime']
try:
    FONT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 26)
except OSError:
    FONT = ImageFont.load_default()
BG = (128, 128, 128)


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


def stack(sheets, gap=0):
    w = max(s.width for s in sheets)
    sheet = Image.new('RGB', (w, sum(s.height for s in sheets) + gap * len(sheets)), BG)
    y = 0
    for s in sheets:
        sheet.paste(s, (0, y))
        y += s.height + gap
    return sheet


for p in PALETTES:
    o = lambda n: Image.open(f'{RAW}/{n}.png').convert('RGB')
    desk = row([o(f'desk-{p}-ref'), o(f'desk-{p}-light-ours'), o(f'desk-{p}-dark-ours')],
               [f'{p}: HTML 1440x900 @2x', 'ours, app light', 'ours, app dark'])
    phone = row([o(f'phone-{p}-ref'), o(f'phone-{p}-light-ours'), o(f'phone-{p}-dark-ours')],
                ['HTML 402x874 drawer', 'ours, light', 'ours, dark'])
    stack([desk, phone]).save(f'{OUT}/compare-{p}.png')

buttons = []
for theme in ['light', 'dark']:
    buttons.append(row([Image.open(f'{RAW}/button-{b}-{theme}.png').convert('RGB') for b in BUTTONS],
                       [f'{b} ({theme})' for b in BUTTONS]))
stack(buttons).save(f'{OUT}/button-colors.png')
stack([row([Image.open(f'{RAW}/settings-{t}.png').convert('RGB')], [f'Settings, app {t}']) for t in ['light', 'dark']]).save(
    f'{OUT}/settings-palette.png')

# Composer: before | after, each end, idle and with text behind, light/dark, DPR 1 and 2 (DPR 1 scaled 2x, nearest).
rows = []
for engine in ['chromium', 'webkit']:
    for theme in ['light', 'dark']:
        for dpr in [1, 2]:
            for state in ['idle', 'text']:
                ims, labels = [], []
                for tag in ['before', 'after']:
                    for end in ['left', 'right']:
                        im = Image.open(f'{RAW}/{engine}-{tag}-{theme}-dpr{dpr}-{state}-{end}.png').convert('RGB')
                        if dpr == 1:
                            im = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
                        ims.append(im.resize((im.width * 2, im.height * 2), Image.NEAREST))
                        labels.append(f'{engine} {tag} {end}' if end == 'left' else f'{theme} dpr{dpr} {state}')
                rows.append(row(ims, labels))
stack(rows).save(f'{OUT}/composer-before-after.png')
print('ok')
