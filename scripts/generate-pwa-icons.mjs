// Generate PWA icons from the SVG sources using sharp.
// Run via `pnpm pwa:icons` (also wired as `prebuild`).
// Outputs (in /public):
//   pwa-icon.svg            (vector, for the manifest's SVG entry)
//   pwa-192x192.png         (manifest icon, any)
//   pwa-512x512.png         (manifest icon, any)
//   pwa-maskable-512x512.png(manifest icon, maskable — full-bleed background, inset mark)
//   apple-touch-icon.png    (iOS, 180x180)

import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const publicDir = resolve(root, "public");
await mkdir(publicDir, { recursive: true });

const fullSvg = await readFile(resolve(__dirname, "pwa-icon-source.svg"), "utf8");
const maskableSvg = await readFile(
  resolve(__dirname, "pwa-icon-maskable-source.svg"),
  "utf8",
);

// Keep the vector source alongside the PNGs so the manifest can reference it.
await writeFile(resolve(publicDir, "pwa-icon.svg"), fullSvg);

const render = async (svg, size, outFile) => {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(resolve(publicDir, outFile));
};

await Promise.all([
  render(fullSvg, 192, "pwa-192x192.png"),
  render(fullSvg, 512, "pwa-512x512.png"),
  render(fullSvg, 180, "apple-touch-icon.png"),
  render(maskableSvg, 512, "pwa-maskable-512x512.png"),
]);

console.log("PWA icons generated in public/.");
