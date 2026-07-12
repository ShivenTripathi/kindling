// Bundles the desktop webview entry point (src/main.js, which pulls in
// @kindling/core + the Tauri adapters) and copies static assets (public/) to
// dist/. The Rust side's `frontendDist` points at `../dist`. Run:
// `npm run build:ui --workspace @kindling/desktop` (or `-- --watch`).
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

async function buildOnce() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  // Static assets: index.html, css.
  await cp(path.join(root, "public"), dist, { recursive: true });

  const opts = {
    entryPoints: [path.join(root, "src/main.js")],
    outfile: path.join(dist, "main.js"),
    bundle: true,
    format: "esm",
    target: "chrome116",
    platform: "browser",
    logLevel: "info",
  };

  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log("watching…");
  } else {
    await esbuild.build(opts);
    console.log(`built → ${path.relative(process.cwd(), dist)}`);
  }
}

buildOnce().catch((err) => {
  console.error(err);
  process.exit(1);
});
