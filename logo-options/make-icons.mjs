// hbook's icon set.
//
// The mark is `hbook-mark.svg` in this folder; this script cuts it into the icons the app ships:
// the web manifest's three sizes, the apple-touch icon, the favicon, and the maskable one (whose
// mark is inset, because a maskable icon's edges may be cropped by the phone).
//
//   node logo-options/make-icons.mjs
//
// It needs sharp, which the BFF already has: `cd bff && node ../logo-options/make-icons.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const icons = path.join(here, '..', 'web', 'public', 'icons');
const svg = fs.readFileSync(path.join(here, 'hbook-mark.svg'));

const sharp = (await import(path.join(here, '..', 'bff', 'node_modules', 'sharp', 'dist', 'index.cjs'))).default;

fs.mkdirSync(icons, { recursive: true });

/** The mark at one size. */
const mark = (size) => sharp(svg).resize(size, size).png();

await mark(32).toFile(path.join(icons, 'favicon.png'));
await mark(180).toFile(path.join(icons, 'apple-touch-icon.png'));
await mark(192).toFile(path.join(icons, 'icon-192.png'));
await mark(512).toFile(path.join(icons, 'icon-512.png'));
// The source of every shipped icon, at the size the logo options folder keeps.
await mark(1024).toFile(path.join(icons, 'hbook-mark.png'));

// The maskable one: the background fills the whole square (the phone may crop the edges) and the
// mark sits inside the safe zone, which is the middle eighty per cent.
const maskable = await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#0e1116' },
})
  .composite([{ input: await sharp(svg).resize(300, 300).png().toBuffer(), top: 106, left: 106 }])
  .png()
  .toBuffer();
await sharp(maskable).toFile(path.join(icons, 'maskable-512.png'));

console.log('icons written to', icons);
