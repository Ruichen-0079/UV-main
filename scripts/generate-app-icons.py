#!/usr/bin/env python3
"""Regenerate every YUVI application icon from the unchanged raster master."""
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
source = root / 'assets/branding/yuvi.png'
output = root / 'apps/desktop/src-tauri/icons'
output.mkdir(parents=True, exist_ok=True)

with Image.open(source) as original:
    master = original.convert('RGBA')


def render(size):
    # Preserve the entire image, including its original corners. Existing
    # non-square platform slots are padded, never cropped or stretched.
    return ImageOps.pad(master, size, method=Image.Resampling.LANCZOS,
                        color=(0, 0, 0, 0))


slots = {}
for file in output.rglob('*.png'):
    with Image.open(file) as image:
        slots[file] = image.size
for name, size in [('16x16.png', 16), ('32x32.png', 32), ('48x48.png', 48),
                   ('64x64.png', 64), ('128x128.png', 128),
                   ('128x128@2x.png', 256), ('icon.png', 1024)]:
    slots[output / name] = (size, size)
for size in [16, 22, 32]:
    slots[output / f'tray-{size}.png'] = (size, size)
for file, size in sorted(slots.items()):
    render(size).save(file)

render((1024, 1024)).save(output / 'icon.ico',
    sizes=[(s, s) for s in [16, 24, 32, 48, 64, 128, 256]])
render((1024, 1024)).save(output / 'icon.icns')
render((32, 32)).save(root / 'apps/web/public/yuvi-icon.png')
print(f'Generated {len(slots)} PNG platform slots, ICO, ICNS and Web favicon from {source}')
