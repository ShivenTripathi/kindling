// Packages the built extension into a Web-Store-uploadable zip.
// Run `npm run build` first, then `node pack.mjs` → kindling-extension-<ver>.zip.
import { zipSync } from "fflate";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
const outName = `kindling-extension-${manifest.version}.zip`;

/** Recursively collect dist/ files into a flat {relPath: Uint8Array} map. */
function collect(dir, base = dist, acc = {}) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (statSync(full).isDirectory()) collect(full, base, acc);
    else acc[rel] = new Uint8Array(readFileSync(full));
  }
  return acc;
}

const files = collect(dist);
const zip = zipSync(files, { level: 9 });
writeFileSync(path.join(root, outName), zip);
console.log(`packed ${Object.keys(files).length} files → ${outName} (${(zip.length / 1024).toFixed(0)} KB)`);
