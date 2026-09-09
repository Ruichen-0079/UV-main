# YUVI identity

The original “meeting voices” mark joins two rounded arms into a Y, with a quiet
presence above their meeting point. Muted jade and pale mint echo the Product
WebUI. The enclosing dark tile keeps contrast on light and dark desktops.
This is the application's identity, independent of any companion character.

`yuvi.svg` is the vector master. `yuvi-tray.svg` is the small-size optical master,
with stronger contrast and a more visible outline. The existing Tauri tray owner
uses its 32 px rendering; 16 and 22 px variants are provided for inspection.

Regenerate with `python scripts/generate-app-icons.py` (Python Pillow and
`rsvg-convert` required). Generated PNG, multi-resolution ICO and ICNS files live
in `apps/desktop/src-tauri/icons`; `apps/desktop/app-icon.svg` is a generated copy.
