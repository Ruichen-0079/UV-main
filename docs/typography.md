# YUVI typography

Updated: 2026-09-10

YUVI Product surfaces use one offline typography contract. The intent is consistent Simplified Chinese, Latin, punctuation, controls, subtitles and technical text across browser development, Tauri desktop, Linux Installed and Linux Portable without depending on fonts installed by the operating system.

## Bundled families

| Role | Family | Upstream version | Pinned upstream revision | License |
| --- | --- | --- | --- | --- |
| Product UI / conversation / headings / labels / controls / subtitle | Noto Sans SC Variable | 2.004 | `523d033d6cb47f4a80c58a35753646f5c3608a78` | SIL Open Font License 1.1 |
| Code / diagnostics / route identifiers | Noto Sans Mono Variable | 2.014 | `9b7310b8f99fcd2583c49606e6aefca13a391350` | SIL Open Font License 1.1 |

The source URLs and license URLs are pinned in `scripts/prepare-product-fonts.mjs`. Generated font binaries are not committed to the source repository. A Web build prepares them under `apps/web/public/yuvi-fonts/`, validates their OpenType signature and expected minimum size, validates representative glyph coverage from the font `cmap`, and writes `fonts-manifest.json` with the source revision, exact byte count and SHA-256 of every bundled font.

The preparation step may fetch the pinned upstream resources while constructing an artifact. **The running YUVI product never fetches fonts from the network.** CSS references only local `/yuvi-fonts/...` assets. There is no Google Fonts stylesheet, CDN dependency, Microsoft font, Segoe-only requirement or other proprietary operating-system font dependency in the active typography contract.

## Typography tokens

`apps/web/src/typography.css` is loaded after the legacy Product style sheets and owns these tokens:

- `--yuvi-font-body`
- `--yuvi-font-conversation`
- `--yuvi-font-heading`
- `--yuvi-font-label`
- `--yuvi-font-control`
- `--yuvi-font-subtitle`
- `--yuvi-font-mono`

The body family is Noto Sans SC. The monospace stack is Noto Sans Mono followed by Noto Sans SC so Chinese embedded in code/diagnostic text retains glyph coverage rather than falling through to an arbitrary platform font.

The token layer covers Main, WebUI, Settings/Appearance, Memory, Models & Providers, Routing, Companion auxiliary text, Subtitle, dialogs/errors and Markdown rendering through their shared DOM/CSS seams. Existing page structure, spacing, colors and component ownership are unchanged.

## Glyph acceptance

`prepare-product-fonts.mjs` calls the bounded OpenType `cmap` validator in `scripts/font-coverage.mjs`. The body-font sample includes YUVI Product vocabulary in Simplified Chinese, mixed Latin/digits and Chinese/Western punctuation. The mono sample covers common ASCII identifiers and code punctuation. A font that downloads successfully but lacks any required glyph fails preparation.

Markdown prose inherits `--yuvi-font-conversation`; `code`, `pre`, diagnostics and routing identifiers use `--yuvi-font-mono`. Chinese characters inside technical text can fall back from the bundled Noto Sans Mono to the bundled Noto Sans SC while remaining fully offline.

## Release packaging and accounting

Linux release preparation invokes font preparation explicitly before its independent Vite build. The resulting `web/dist/yuvi-fonts/` tree contains both variable TTF files, both OFL 1.1 license texts and `fonts-manifest.json`.

The public-artifact audit verifies:

1. both font files and both license files are present;
2. the generated manifest declares `runtimeNetworkFetch=false`;
3. measured file sizes and SHA-256 hashes match the manifest;
4. total measured font bytes match `fontBytes`;
5. the package `install-manifest.json` declares `typographyBundled=true`, `typographyRuntimeNetworkFetch=false`, the expected families and the same exact `typographyFontBytes` total.

`typographyFontBytes` is the authoritative package-size impact of the two font binaries. It is generated from the actual pinned files rather than estimated in documentation, so release evidence remains valid if the upstream-pinned font payload is intentionally changed in a later atom.

## Acceptance matrix

A11 automated gates cover source pinning, OFL presence, local-only runtime URLs, token ownership, Product mono overrides, representative glyph coverage, Linux package inclusion, integrity accounting and TTF MIME serving. The normal repository Check/Build/Test/Smoke gates remain required.

Final visual acceptance on a built Product surface should sample Simplified Chinese, English, mixed Chinese/Latin punctuation, Markdown paragraphs, inline code, fenced code blocks, controls and subtitles in both light and dark themes and in a narrow window. The acceptance is visual only for layout/weight aesthetics; missing required glyphs and missing package resources are automated failures.
