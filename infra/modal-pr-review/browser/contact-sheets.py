"""Sample the recording in order and tile up to 20 distinct frames per image."""

import json
import math
import subprocess
import sys
from pathlib import Path

COLUMNS = 4
ROWS = 5
FRAMES_PER_SHEET = COLUMNS * ROWS
MAX_SHEETS = 4
TILE_WIDTH = 384
TILE_HEIGHT = 216


def make_sheets(video: Path) -> list[str]:
    info = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video),
    ])
    duration = float(json.loads(info)["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Recording has no valid duration")

    # Playwright records at 25 fps. Cap sampling below that to avoid duplicate frames in short clips.
    sheet_count = min(MAX_SHEETS, math.ceil(duration / FRAMES_PER_SHEET))
    rate = min(25, sheet_count * FRAMES_PER_SHEET / duration)
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(video),
        "-vf", f"fps={rate:.9f},scale={TILE_WIDTH}:{TILE_HEIGHT},tile={COLUMNS}x{ROWS}:padding=2",
        "-frames:v", str(MAX_SHEETS), "-q:v", "3", str(video.parent / "sheet-%02d.jpg"),
    ], check=True, timeout=90)
    return [path.name for path in sorted(video.parent.glob("sheet-*.jpg"))]


if __name__ == "__main__":
    print(json.dumps(make_sheets(Path(sys.argv[1]))))
