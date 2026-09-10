import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

test("product typography uses pinned offline Noto assets and never a runtime font CDN", () => {
  const prepare = read("scripts/prepare-product-fonts.mjs");
  const coverage = read("scripts/font-coverage.mjs");
  const css = read("apps/web/src/typography.css");
  const webPackage = JSON.parse(read("apps/web/package.json"));

  assert.match(prepare, /523d033d6cb47f4a80c58a35753646f5c3608a78/);
  assert.match(prepare, /9b7310b8f99fcd2583c49606e6aefca13a391350/);
  assert.match(prepare, /NotoSansSC-VF\.ttf/);
  assert.match(prepare, /NotoSansMono-VF\.ttf/);
  assert.match(prepare, /runtimeNetworkFetch:\s*false/);
  assert.match(prepare, /assertFontCoverage\(destination, asset\.coverageSample/);
  assert.match(prepare, /设置 记忆 模型 提供商 路由 伴侣 字幕/);
  assert.match(coverage, /format12HasGlyph/);
  assert.match(coverage, /format4HasGlyph/);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic/i);
  assert.match(css, /url\("\/yuvi-fonts\/NotoSansSC-VF\.ttf"\)/);
  assert.match(css, /url\("\/yuvi-fonts\/NotoSansMono-VF\.ttf"\)/);
  assert.match(webPackage.scripts.build, /prepare:fonts/);
  assert.match(webPackage.scripts.dev, /prepare:fonts/);
});

test("one typography token set owns body, conversation, labels, controls, subtitle and mono", () => {
  const css = read("apps/web/src/typography.css");
  const main = read("apps/web/src/main.tsx");

  for (const token of [
    "--yuvi-font-body",
    "--yuvi-font-conversation",
    "--yuvi-font-heading",
    "--yuvi-font-label",
    "--yuvi-font-control",
    "--yuvi-font-subtitle",
    "--yuvi-font-mono"
  ]) {
    assert.ok(css.includes(token), `missing typography token ${token}`);
  }
  assert.match(css, /\.assistant-markdown[\s\S]*var\(--yuvi-font-conversation\)/);
  assert.match(css, /\.yuvi-subtitle-text[\s\S]*var\(--yuvi-font-subtitle\)/);
  for (const selector of [
    ".yuvi-diagnostics-log",
    ".yuvi-product-routing-truth strong",
    ".yuvi-product-route-priority",
    ".yuvi-product-route-title span"
  ]) {
    assert.ok(css.includes(selector), `missing mono authority selector ${selector}`);
  }
  assert.ok(
    main.indexOf('import "./typography.css";') > main.indexOf('import "./product-ui.css";'),
    "typography must load after legacy product styles"
  );
});

test("Linux Installed and Portable package report and serve bundled typography", () => {
  const buildLinuxWeb = read("scripts/desktop-package/build-linux-web.mjs");
  const prepare = read("scripts/desktop-package/prepare-linux-daily.mjs");
  const audit = read("scripts/desktop-package/audit-linux-public-artifact.mjs");
  const server = read("scripts/desktop-package/linux-static-web-server.mjs");

  assert.match(buildLinuxWeb, /prepareProductFonts/);
  assert.match(buildLinuxWeb, /await prepareProductFonts\(\)/);
  assert.match(prepare, /offline-typography-fonts/);
  assert.match(prepare, /typographyBundled:\s*true/);
  assert.match(prepare, /typographyRuntimeNetworkFetch:\s*false/);
  assert.match(prepare, /typographyFontBytes:\s*typographyManifest\.fontBytes/);
  assert.match(audit, /web\/dist\/yuvi-fonts\/NotoSansSC-VF\.ttf/);
  assert.match(audit, /web\/dist\/yuvi-fonts\/NotoSansMono-VF\.ttf/);
  assert.match(audit, /OFL-1\.1\.txt/);
  assert.match(audit, /Bundled typography integrity mismatch/);
  assert.match(server, /"\.ttf":"font\/ttf"/);
});
