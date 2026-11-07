from pathlib import Path
from PIL import Image,ImageOps,ImageDraw
p=Path.home()/'.praxis-agent-state/cloud/design/G4/B'
for theme in ['light','dark']:
 for size in ['desk','phone']:
  for crop in [False,True]:
   suffix='-crop' if crop else ''
   ref=Image.open(p/f'{size}-{theme}-reference{suffix}.png').convert('RGB');actual=Image.open(p/f'{size}-{theme}-sidebar{suffix}.png').convert('RGB')
   board=Image.new('RGB',(ref.width+actual.width, max(ref.height,actual.height)+32),'#e9e6df');d=ImageDraw.Draw(board);d.text((8,8),'Owner render — native CSS pixels',fill='#15140f');d.text((ref.width+8,8),f'Implementation — {size}, {theme}',fill='#15140f');board.paste(ref,(0,32));board.paste(actual,(ref.width,32));board.save(p/f'compare-{size}-{theme}{suffix}.png')
  files=[p/f'{size}-{theme}-accent-{name}.png' for name in ['neutral','blue','violet','rose','amber','green','send','approval']]
  width=1000;tileW=250;tileH=400;board=Image.new('RGB',(width,tileH*2),'#e9e6df');d=ImageDraw.Draw(board)
  for i,f in enumerate(files):
   im=ImageOps.contain(Image.open(f).convert('RGB'),(tileW,tileH-20));x=(i%4)*tileW;y=(i//4)*tileH;d.text((x+4,y+4),f.stem.split('-accent-')[1],fill='#15140f');board.paste(im,(x,y+20))
  board.save(p/f'accent-board-{size}-{theme}.png')
