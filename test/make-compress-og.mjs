/**
 * Generates assets/compress-og.png (1200x630), the Open Graph / Twitter card for /compress/.
 *
 * Dev tooling, not a test and not shipped code — it renders a card in headless Chrome and
 * screenshots it, so the social image is built from the same tokens as the site instead of
 * being drawn by hand somewhere else and drifting. Mirrors test/make-og.mjs for the HEIC
 * tool; the only differences are the headline and the instrument (a reclaim readout in
 * place of the wire tap, because a compressor's promise is a saving).
 *
 * Run:  "/mnt/c/Program Files/nodejs/node.exe" test/make-compress-og.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'assets', 'compress-og.png');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
];
const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.error('No Chrome found.'); process.exit(1); }

// The darkroom, because a social card is seen in a feed and the amber has to carry it.
// Colours and type are copied from css/app.css's darkroom tokens verbatim.
const html = `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    justify-content: space-between; padding: 72px;
    background: #131010; color: #f2ebe5;
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 28px; font-weight: 650; letter-spacing: -.02em; }
  .lamp { width: 22px; height: 22px; border-radius: 50%; background: #f2913f;
          box-shadow: 0 0 0 1px rgba(242,145,63,.2), 0 0 60px 6px rgba(242,145,63,.45); }
  h1 { font-size: 92px; line-height: .96; letter-spacing: -.04em; font-weight: 680; }
  h1 em { font-style: normal; color: #f2913f; }
  .row { display: flex; align-items: flex-end; justify-content: space-between; gap: 48px; }
  p { color: #cabfb6; font-size: 27px; line-height: 1.4; max-width: 44ch; margin-top: 26px; }
  .reclaim { border: 1px solid #14241f; background: #14241f; border-radius: 10px; padding: 22px 26px;
             font-family: ui-monospace, Consolas, monospace; flex: none; }
  .reclaim b { display: block; font-size: 13px; letter-spacing: .16em; color: #9b8e85; font-weight: 400; }
  .reclaim .v { font-size: 44px; font-weight: 600; color: #58bfa3; margin-top: 10px; letter-spacing: -.02em; }
  .reclaim .u { font-size: 13px; color: #9b8e85; margin-top: 6px; }
</style>
<div class="brand"><span class="lamp"></span>Safelight</div>
<div>
  <h1>Compress JPG &amp; PNG,<br><em>without the upload</em>.</h1>
  <div class="row">
    <p>Compresses in your browser. Your images never leave the device — check the Network tab yourself.</p>
    <div class="reclaim">
      <b>RECLAIMED</b>
      <div class="v">80% smaller</div>
      <div class="u">free · unlimited · offline</div>
    </div>
  </div>
</div>`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
