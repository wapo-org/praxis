#!/usr/bin/env python3
"""Stream one retained development artifact to an authorized SSH caller."""
from argparse import ArgumentParser
import re
from pathlib import Path
import shutil
import sys

ROOT = Path('/var/lib/praxis-review/review-artifacts')
ARTIFACTS = ('contact-sheet.png', 'development.webm')
RUN_ID = re.compile(r'[0-9a-f]{12}')

parser = ArgumentParser(description=__doc__)
parser.add_argument('run_id')
parser.add_argument('artifact', choices=ARTIFACTS)
args = parser.parse_args()
if not RUN_ID.fullmatch(args.run_id):
    parser.error('Invalid review run ID')
path = (ROOT / args.run_id / args.artifact).resolve()
if not path.is_relative_to(ROOT.resolve()):
    parser.error('Invalid review artifact path')
try:
    with path.open('rb') as source:
        shutil.copyfileobj(source, sys.stdout.buffer)
except FileNotFoundError:
    parser.exit(1, 'Artifact unavailable for that review run.\n')
