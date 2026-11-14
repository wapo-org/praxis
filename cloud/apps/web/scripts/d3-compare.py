"""Pair D3 captures with the supplied iOS reference (nearest available for cards/Lab)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
out = Path.home() / '.praxis-agent-state/cloud/design/D3/d3b'
refs = Path(__file__).resolve().parents[3] / 'docs/web/reference/ios'
boards = out / 'compare'
boards.mkdir(exist_ok=True)
for file in sorted(out.glob('*.png')):
    if file.name.startswith(('compare', 'contact')): continue
    theme = 'dark' if '-dark-' in file.name else 'light'
    state = file.stem.split('-', 2)[2]
    name = ('dark-history-0-top.png' if theme == 'dark' else 'light-history-0-top.png') if state == 'history' else 'light-activity-tool-detail.png' if state == 'tool-detail' else 'light-markdown-table.png' if state == 'markdown' else 'light-activity-running-stream.png' if state == 'running' else 'light-activity-finished-folded.png' if state == 'tools-folded' else 'light-activity-finished-list.png' if state == 'tools' else 'light-chat-fine-0.png'
    web = Image.open(file).convert('RGB'); ios = Image.open(refs/name).convert('RGB')
    web = ImageOps.contain(web, (1000, 874)); ios = ImageOps.contain(ios, (440, 874))
    board = Image.new('RGB', (web.width + ios.width + 36, 920), '#e9e6df')
    draw = ImageDraw.Draw(board)
    draw.text((12,10), file.name, fill='#15140f')
    draw.text((web.width+24,10), 'iOS: '+name, fill='#15140f')
    if state in ['approval','nestedApproval','elicitation','cancel','error','sign-in','lab']:
        draw.text((12,28),'Nearest supplied iOS reference; no exact counterpart was supplied.', fill='#6e6b62')
    board.paste(web,(12,46));board.paste(ios,(web.width+24,46));board.save(boards/file.name)
# Review boards in compact groups, retaining each full-size pair above.
files=sorted(boards.glob('*.png'))
for offset in range(0,len(files),8):
    contact=Image.new('RGB',(1600,1000),'#e9e6df')
    for i,f in enumerate(files[offset:offset+8]):
        thumb=ImageOps.contain(Image.open(f),(390,480));contact.paste(thumb,((i%4)*400,(i//4)*500))
    contact.save(out/f'contact-{offset//8+1}.png')
