// Bundles the extension's entry points (each bundles @kindling/core as needed)
// and copies static assets to dist/. Run: `npm run build` (or `-- --watch`).
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

// Each entry is bundled to an IIFE/ESM file in dist/. The service worker is an
// ES module (manifest background.type = "module"); the content extractor is a
// classic IIFE injected via chrome.scripting.
const ENTRIES = [
  { in: "src/background.js", out: "background", format: "esm" },
  { in: "src/popup/popup.js", out: "popup/popup", format: "esm" },
  { in: "src/options/options.js", out: "options/options", format: "esm" },
  { in: "src/offscreen/offscreen.js", out: "offscreen/offscreen", format: "esm" },
  // Injected into pages to run extraction on the live DOM; must be a self-
  // contained classic script exposing window.__kindlingExtract.
  { in: "src/content-extract.js", out: "content-extract", format: "iife" },
];

async function buildOnce() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  // Static assets: manifest, html, css, icons.
  await cp(path.join(root, "public"), dist, { recursive: true });

  const ctxs = [];
  for (const e of ENTRIES) {
    const opts = {
      entryPoints: [path.join(root, e.in)],
      outfile: path.join(dist, `${e.out}.js`),
      bundle: true,
      format: e.format,
      target: "chrome116",
      platform: "browser",
      logLevel: "info",
      // MV3 forbids remote code; everything is bundled locally.
    };
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
      ctxs.push(ctx);
    } else {
      await esbuild.build(opts);
    }
  }
  console.log(watch ? "watching…" : `built → ${path.relative(process.cwd(), dist)}`);
}

buildOnce().catch((err) => {
  console.error(err);
  process.exit(1);
});
