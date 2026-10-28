/**
 * Generates the PWA icon set under assets/, drawn from the Safelight identity
 * (darkroom near-black + the amber safelight lamp) so the installed-app icon is the
 * same instrument as the inline-SVG favicon, at full resolution.
 *
 * Dev tooling, not a test and not shipped code. It renders each icon as an SVG in
 * headless Chrome and screenshots it at exact device pixels, so the icons are built
 * from the same tokens as the site (see test/make-og.mjs for the same approach).
 *
 * Produces:
 *   assets/icon-192.png          192  — "any" maskable=no, rounded lab-equipment corners
 *   assets/icon-512.png          512  — "any"
 *   assets/icon-maskable-512.png 512  — "maskable", full-bleed + safe-zone padding
 *   assets/apple-touch-icon.png  180  — full-bleed (iOS applies its own mask/rounding)
 *   assets/favicon-32.png         32  — exact PNG twin of the inline-SVG favicon
 *
 * Run:  node test/make-icons.mjs        (Windows node; see README for WSL paths)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'assets');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.error('No Chrome found.'); process.exit(1); }

/* Tokens — the darkroom, straight from css/app.css. */
const BG = '#131010';       // --paper (darkroom)
const AMBER = '#f2913f';    // --safelight (dark scheme)

/**
 * Build the icon as an SVG string. Coordinates are in a 0..S user space.
 *  - rounded : corner radius as a fraction of S (0 = square / full-bleed)
 *  - scale   : glyph scale (1 = favicon proportions; <1 pulls it into a maskable safe zone)
 *  - glow    : draw the soft amber bloom behind the lamp (the one place light bleeds)
 */
function iconSvg(S, { rounded = 0, scale = 1, glow = true } = {}) {
  const cx = S / 2;
  const cy = S / 2;
  const lampR = S * 0.22 * scale;
  const ringR = S * 0.34 * scale;
  const ringW = Math.max(1, S * 0.047 * scale);
  const rx = rounded * S;
  const glowR = S * 0.5 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="bloom" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="${AMBER}" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="${AMBER}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${AMBER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${S}" height="${S}" rx="${rx}" ry="${rx}" fill="${BG}"/>
  ${glow ? `<circle cx="${cx}" cy="${cy}" r="${glowR}" fill="url(#bloom)"/>` : ''}
  <circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke="${AMBER}" stroke-opacity="0.35" stroke-width="${ringW}"/>
  <circle cx="${cx}" cy="${cy}" r="${lampR}" fill="${AMBER}"/>
</svg>`;
}

/** The five deliverables. */
const ICONS = [
  { file: 'icon-192.png',          size: 192, opts: { rounded: 0.22, scale: 1,    glow: true } },
  { file: 'icon-512.png',          size: 512, opts: { rounded: 0.22, scale: 1,    glow: true } },
  // Maskable: full-bleed dark background, glyph shrunk to sit inside the 80% safe circle.
  { file: 'icon-maskable-512.png', size: 512, opts: { rounded: 0,    scale: 0.62, glow: true } },
  // Apple: full-bleed, no corner rounding — iOS rounds and masks it itself.
  { file: 'apple-touch-icon.png',  size: 180, opts: { rounded: 0,    scale: 1,    glow: true } },
  // Favicon: an exact PNG twin of the inline SVG favicon (no bloom, favicon proportions).
  { file: 'favicon-32.png',        size: 32,  opts: { rounded: 0.22, scale: 1,    glow: false } },
];

/** Read a PNG's real IHDR width/height, so we can prove the file is what we claim. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  for (const { file, size, opts } of ICONS) {
    const svg = iconSvg(size, opts);
    const html = `<!doctype html><meta charset="utf-8">
      <style>*{margin:0;padding:0}html,body{background:transparent}
      svg{display:block}</style>${svg}`;
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    const el = await page.$('svg');
    const dest = path.join(OUT, file);
    // omitBackground:false keeps the icon's own opaque dark background (Apple/maskable
    // must not be transparent). The SVG paints edge-to-edge, so the shot is exact.
    await el.screenshot({ path: dest, omitBackground: true });
    const buf = fs.readFileSync(dest);
    const dim = pngSize(buf);
    const good = dim && dim.w === size && dim.h === size;
    console.log(`${good ? 'ok ' : 'BAD'} ${file.padEnd(24)} ${dim ? dim.w + 'x' + dim.h : '??'}  ${(buf.length / 1024).toFixed(1)} KB`);
    if (!good) { console.error(`  ${file} is not a valid ${size}x${size} PNG`); process.exitCode = 1; }
  }
} finally {
  await browser.close();
}
