import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./constants.mjs";
import { javascriptNotices } from "./javascript-notices.mjs";
import { prepareProductFonts } from "../prepare-product-fonts.mjs";
export async function buildLinuxWeb() {
  const webRoot = path.join(REPO_ROOT, "apps/web");
  await prepareProductFonts();
  const require = createRequire(path.join(webRoot, "package.json"));
  const viteRoot = path.dirname(require.resolve("vite/package.json"));
  const { build } = await import(pathToFileURL(path.join(viteRoot, "dist/node/index.js")).href);
  const previous = process.cwd();
  process.chdir(webRoot);
  try {
    await build({
      root: webRoot,
      plugins: [
        {
          name: "yuvi-release-notices",
          generateBundle(_options, bundle) {
            const modules = Object.values(bundle)
              .filter((item) => item.type === "chunk")
              .flatMap((item) =>
                Object.entries(item.modules)
                  .filter(([, info]) => info.renderedLength > 0)
                  .map(([id]) => id)
              );
            this.emitFile({
              type: "asset",
              fileName: "THIRD_PARTY_NOTICES.web.json",
              source: JSON.stringify(javascriptNotices(modules), null, 2)
            });
            for (const name of ["LICENSE.md", "SDK-LICENSE.md", "SDK-NOTICE.md"])
              this.emitFile({
                type: "asset",
                fileName: `licenses/cubism-framework/${name}`,
                source: fs.readFileSync(path.join(webRoot, "vendor/cubism-framework", name), "utf8")
              });
          }
        }
      ]
    });
  } finally {
    process.chdir(previous);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await buildLinuxWeb();
