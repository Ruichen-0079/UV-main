# YUVI identity

`yuvi.png` is the single canonical visual master, copied byte-for-byte from the
user-provided `/home/ruichen/桌面/icon.png`. Preserve its character silhouette,
pastel pink/lavender/cool-blue light, orbit motifs and original corners.

Regenerate with `python3 scripts/generate-app-icons.py` (Python 3 and Pillow
required). No image-generation service or SVG renderer is needed. The script
resizes the entire master without recoloring or cropping and refreshes all
existing PNG platform slots, including the tray, plus multi-resolution ICO,
ICNS and `apps/web/public/yuvi-icon.png` for the Web favicon.

Tauri bundle configuration consumes the generated files in
`apps/desktop/src-tauri/icons`. The existing tray owner uses `tray-32.png`.
Linux desktop-entry generation consumes `128x128@2x.png` through the existing
packaging script. Icon regeneration is source preparation; it does not build
or package a release.
