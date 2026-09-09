#!/usr/bin/env python3
"""Regenerate YUVI icons with librsvg (rsvg-convert) and Pillow."""
from pathlib import Path
import subprocess
from PIL import Image

root = Path(__file__).resolve().parents[1]
source = root / 'assets/branding'
output = root / 'apps/desktop/src-tauri/icons'
output.mkdir(parents=True, exist_ok=True)
for name, size in [('16x16.png', 16), ('32x32.png', 32), ('128x128.png', 128),
                   ('128x128@2x.png', 256), ('icon.png', 1024)]:
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                    '-o', str(output / name), str(source / 'yuvi.svg')], check=True)
for size in [16, 22, 32]:
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                    '-o', str(output / f'tray-{size}.png'), str(source / 'yuvi-tray.svg')], check=True)
with Image.open(output / 'icon.png') as image:
    image.save(output / 'icon.ico', sizes=[(s, s) for s in [16, 24, 32, 48, 64, 128, 256]])
    image.save(output / 'icon.icns', sizes=[(s, s) for s in [16, 32, 64, 128, 256, 512, 1024]])
(root / 'apps/desktop/app-icon.svg').write_bytes((source / 'yuvi.svg').read_bytes())

# Refresh the existing platform slots too; no stale identity in future bundles.
for file in sorted(output.rglob('*.png')):
    if file.name.startswith('tray-'):
        continue
    with Image.open(file) as image:
        width, height = image.size
    subprocess.run(['rsvg-convert', '-w', str(width), '-h', str(height),
                    '-o', str(file), str(source / 'yuvi.svg')], check=True)
