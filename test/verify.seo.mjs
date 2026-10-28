/**
 * Browser verification for the SEO content surface (guides/, compare/, privacy/, 404).
 *
 * Loads every content page in real headless Chrome and asserts the things that would
 * silently rot: console errors, dead internal links, a sitemap that drifts from the
 * filesystem, JSON-LD that stopped parsing, and — the product's whole claim — any
 * request to a third-party host.
 *
 * WHY ITS OWN SERVER: test/server.mjs maps a URL straight onto a file, so `/guides/`
 * (a directory) 404s against it. Cloudflare Pages serves `guides/index.html` at
 * `/guides/`, and the canonicals commit to that trailing-slash form, so testing against
 * a server that can't resolve it would be testing a different site. The server below is
 * server.mjs plus directory-index resolution and a real 404 body, which is what Pages
 * actually does. Everything else — Chrome discovery, the request tap, the pass/fail
 * reporting — follows verify.ui.mjs.
 *
 * Run:  node test/verify.seo.mjs        (Windows node; see README for WSL paths)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'screenshots');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const ORIGIN_CANONICAL = 'https://heic.kostelinha.com';

/** Every indexable page: canonical path -> file on disk. Must match sitemap.xml exactly. */
const PAGES = [
  ['/', 'index.html'],
  ['/png-to-jpg/', 'png-to-jpg/index.html'],
  ['/webp-to-jpg/', 'webp-to-jpg/index.html'],
  ['/jpg-to-webp/', 'jpg-to-webp/index.html'],
  ['/webp-to-png/', 'webp-to-png/index.html'],
  ['/png-to-webp/', 'png-to-webp/index.html'],
  ['/jpg-to-png/', 'jpg-to-png/index.html'],
  ['/png-to-svg/', 'png-to-svg/index.html'],
  ['/jpg-to-svg/', 'jpg-to-svg/index.html'],
  ['/webp-to-svg/', 'webp-to-svg/index.html'],
  ['/guides/', 'guides/index.html'],
  ['/guides/heic-to-jpg-without-uploading/', 'guides/heic-to-jpg-without-uploading/index.html'],
  ['/guides/batch-convert-heic-to-jpg/', 'guides/batch-convert-heic-to-jpg/index.html'],
  ['/guides/open-heic-files-windows-11/', 'guides/open-heic-files-windows-11/index.html'],
  ['/guides/heic-to-jpg-free-unlimited/', 'guides/heic-to-jpg-free-unlimited/index.html'],
  ['/guides/heic-to-png/', 'guides/heic-to-png/index.html'],
  ['/guides/heic-to-pdf/', 'guides/heic-to-pdf/index.html'],
  ['/compare/', 'compare/index.html'],
  ['/compare/is-heictojpg-com-safe/', 'compare/is-heictojpg-com-safe/index.html'],
  ['/compare/is-freeconvert-safe/', 'compare/is-freeconvert-safe/index.html'],
  ['/compare/is-cloudconvert-safe/', 'compare/is-cloudconvert-safe/index.html'],
  ['/compare/heictojpg-alternative/', 'compare/heictojpg-alternative/index.html'],
  ['/privacy/', 'privacy/index.html'],
];

/**
 * URLs that are in the sitemap and linked from these pages, but whose files are owned
 * by a DIFFERENT agent and may not exist on disk when this suite runs. They are exempt
 * from sitemap↔filesystem parity and from the internal-link 404 check; a link to one is
 * reported as PENDING rather than failed. Re-run once that agent's files land and the
 * exemption becomes a no-op (the URL will resolve like any other).
 */
const PENDING = new Set(['/compress/']);

/** Pages this suite screenshots and eyeballs. The app itself is verify.ui.mjs's job. */
const SHOT_PAGES = [
  ['/png-to-jpg/', 'convert-png-to-jpg'],
  ['/jpg-to-png/', 'convert-jpg-to-png'],
  ['/guides/', 'guides-hub'],
  ['/guides/heic-to-jpg-without-uploading/', 'guide-no-upload'],
  ['/guides/open-heic-files-windows-11/', 'guide-windows11'],
  ['/guides/heic-to-png/', 'guide-png'],
  ['/guides/heic-to-pdf/', 'guide-pdf'],
  ['/compare/', 'compare-hub'],
  ['/compare/is-heictojpg-com-safe/', 'compare-heictojpg'],
  ['/compare/heictojpg-alternative/', 'compare-alternative'],
  ['/privacy/', 'privacy'],
  ['/404.html', '404'],
];

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** Static server with Cloudflare Pages' directory-index behaviour. */
function listen(root = ROOT) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/favicon.ico') return void res.writeHead(204).end();

    let file = path.join(root, rel);
    if (!file.startsWith(root)) return void res.writeHead(403).end('forbidden');

    // A trailing slash (or a bare directory) resolves to index.html, as Pages does.
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch (_) {
      /* fall through to the readFile 404 */
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        // Pages serves 404.html for unmatched paths. Mirror that, status and all.
        const custom = path.join(root, '404.html');
        if (fs.existsSync(custom) && path.extname(file) !== '.png') {
          res.writeHead(404, { 'Content-Type': TYPES['.html'] });
          return void res.end(fs.readFileSync(custom));
        }
        return void res.writeHead(404).end('not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const chrome = CHROME_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});
if (!chrome) {
  console.error('FAIL  could not find Chrome. Tried:\n' + CHROME_CANDIDATES.join('\n'));
  process.exit(1);
}

fs.mkdirSync(SHOTS, { recursive: true });

const { server, port } = await listen(ROOT);
const ORIGIN = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 120000,
});

try {
  /* ── 1. sitemap.xml describes reality ──────────────────────────────────────
     A sitemap listing a page that 404s wastes crawl budget and reads as neglect;
     a page missing from the sitemap may never be found. Both are silent failures,
     so they're asserted against the filesystem rather than trusted. */
  console.log('── sitemap ─────────────────────────────────────────────');
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // Pages we own plus the pending, cross-agent URLs the sitemap is allowed to list.
  const expected = [
    ...PAGES.map(([url]) => ORIGIN_CANONICAL + url),
    ...[...PENDING].map((url) => ORIGIN_CANONICAL + url),
  ];

  ok('sitemap is well-formed XML', sitemap.trimStart().startsWith('<?xml'));
  ok('sitemap uses the sitemaps.org namespace',
    sitemap.includes('http://www.sitemaps.org/schemas/sitemap/0.9'));

  const phantom = listed.filter((u) => !expected.includes(u));
  const missing = expected.filter((u) => !listed.includes(u));
  ok('sitemap lists no phantom URLs', phantom.length === 0, phantom.join(', ') || 'none');
  ok('sitemap is missing no real pages', missing.length === 0, missing.join(', ') || 'none');
  ok('sitemap has no duplicate entries', new Set(listed).size === listed.length,
    `${listed.length} entries`);
  // PENDING files are owned by another agent and may not exist yet — exempt from the
  // on-disk check, but reported so a lingering exemption can't hide silently.
  ok('every OWNED sitemap URL exists on disk',
    PAGES.every(([, f]) => fs.existsSync(path.join(ROOT, f))));
  for (const url of PENDING) {
    const onDisk = fs.existsSync(path.join(ROOT, url.replace(/^\//, ''), 'index.html'));
    console.log(`${onDisk ? 'PASS' : 'PENDING'}  ${url} — ${onDisk ? 'now on disk' : 'owned by another agent, not yet present'}`);
  }
  ok('404.html is NOT in the sitemap', !listed.some((u) => u.includes('404')));

  /* ── 2. every page: errors, meta, JSON-LD, third-party requests ─────────── */
  console.log('\n── pages ───────────────────────────────────────────────');
  /** Collected across every page load; asserted at the end. */
  const allThirdParty = [];
  const linkTargets = new Set();

  for (const [url, file] of [...PAGES, ['/404.html', '404.html']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const consoleErrors = [];
    const pageErrors = [];
    const thirdParty = [];

    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:')) {
        thirdParty.push(u);
        allThirdParty.push(`${url} -> ${u}`);
      }
    });

    await page.goto(ORIGIN + url, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    const meta = await page.evaluate(() => ({
      title: document.title,
      desc: document.querySelector('meta[name="description"]')?.content || '',
      canonical: document.querySelector('link[rel=canonical]')?.href || '',
      h1s: document.querySelectorAll('h1').length,
      robots: document.querySelector('meta[name="robots"]')?.content || '',
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
      links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      styled: getComputedStyle(document.body).backgroundColor,
    }));

    const tag = url.padEnd(46);
    ok(`${tag} no page errors`, pageErrors.length === 0, pageErrors[0] || '');
    ok(`${tag} no console errors`, consoleErrors.length === 0, consoleErrors[0] || '');
    ok(`${tag} zero third-party requests`, thirdParty.length === 0, thirdParty[0] || '');
    ok(`${tag} exactly one <h1>`, meta.h1s === 1, `found ${meta.h1s}`);
    ok(`${tag} has a title`, meta.title.length > 10 && meta.title.length < 75,
      `${meta.title.length} chars`);
    ok(`${tag} stylesheet applied`, meta.styled !== 'rgba(0, 0, 0, 0)' && meta.styled !== '');

    if (url === '/404.html') {
      ok(`${tag} is noindex`, meta.robots.includes('noindex'), meta.robots);
    } else {
      ok(`${tag} has a meta description`, meta.desc.length > 50 && meta.desc.length <= 165,
        `${meta.desc.length} chars`);
      ok(`${tag} canonical matches sitemap`, meta.canonical === ORIGIN_CANONICAL + url,
        meta.canonical);
      ok(`${tag} has JSON-LD`, meta.ld.length > 0);
    }

    // JSON-LD must parse AND be structurally sane — a block that parses but has no
    // @context is invisible to a crawler, which is the same as not shipping it.
    for (const block of meta.ld) {
      let parsed = null;
      try { parsed = JSON.parse(block); } catch (e) { parsed = null; }
      ok(`${tag} JSON-LD parses`, parsed !== null);
      if (parsed) {
        const nodes = parsed['@graph'] || [parsed];
        ok(`${tag} JSON-LD has @context + @type`,
          !!parsed['@context'] && nodes.every((n) => !!n['@type']));
      }
    }

    for (const href of meta.links) {
      if (href.startsWith('/')) linkTargets.add(href.split('#')[0] || '/');
    }
    await page.close();
  }

  ok('no page made a third-party request', allThirdParty.length === 0,
    allThirdParty[0] || 'none across all pages');

  /* ── 2b. nothing overflows a phone ─────────────────────────────────────────
     The `.facts` tables are wider than a phone by design and are supposed to scroll
     inside their own container. If that containment ever breaks, the whole body
     scrolls sideways — the classic "looks fine on my laptop" bug. Asserted rather
     than eyeballed, because it is invisible in a screenshot until it's egregious. */
  console.log('\n── no horizontal overflow at 390px ─────────────────────');
  for (const [url] of [...PAGES, ['/404.html']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(ORIGIN + url, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    const over = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      view: window.innerWidth,
      // Name the widest offender, so a failure points at the element to fix.
      worst: [...document.querySelectorAll('body *')]
        .map((e) => ({ w: e.getBoundingClientRect().right, t: e.tagName + '.' + e.className }))
        .sort((a, b) => b.w - a.w)[0],
    }));
    ok(`${url.padEnd(46)} no sideways scroll`, over.body <= over.view,
      over.body > over.view ? `${over.body}px > ${over.view}px, widest: ${over.worst?.t}` : '');
    await page.close();
  }

  /* ── 3. every internal link resolves ───────────────────────────────────────
     Checked over HTTP against the same server the browser used, so a link to a
     directory without an index.html fails here exactly as it would in production. */
  console.log('\n── internal links ──────────────────────────────────────');
  const dead = [];
  const pending = [];
  for (const href of [...linkTargets].sort()) {
    const status = await new Promise((resolve) => {
      http.get(`${ORIGIN}${href}`, (r) => { r.resume(); resolve(r.statusCode); })
        .on('error', () => resolve(0));
    });
    if (status === 200) continue;
    // A link to a cross-agent PENDING page is expected to 404 until that agent lands.
    if (PENDING.has(href)) pending.push(`${href} -> ${status}`);
    else dead.push(`${href} -> ${status}`);
  }
  ok(`all ${linkTargets.size - pending.length} owned internal link targets resolve`,
    dead.length === 0, dead.join(', ') || 'no 404s');
  for (const p of pending) {
    console.log(`PENDING  internal link ${p} — cross-agent page not yet on disk; re-run after it lands`);
  }

  // The crawler surface itself has to be reachable, not just present on disk.
  for (const f of ['/robots.txt', '/sitemap.xml', '/ads.txt']) {
    const status = await new Promise((resolve) => {
      http.get(`${ORIGIN}${f}`, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
    });
    ok(`${f} is served`, status === 200, `HTTP ${status}`);
  }

  // ads.txt must not authorise anyone until the owner pastes a real ID. A placeholder
  // publisher ID going live would authorise a stranger to sell ads on this domain.
  const adsTxt = fs.readFileSync(path.join(ROOT, 'ads.txt'), 'utf8');
  const liveRecords = adsTxt.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  ok('ads.txt contains no active records yet', liveRecords.length === 0,
    liveRecords[0] || 'all commented out');

  /* ── 4. screenshots: desktop + mobile, lightbox + darkroom ──────────────── */
  console.log('\n── screenshots ─────────────────────────────────────────');
  const VIEWS = [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  const ROOMS = ['lightbox', 'darkroom'];
  let shots = 0;

  for (const [url, slug] of SHOT_PAGES) {
    for (const view of VIEWS) {
      for (const room of ROOMS) {
        const page = await browser.newPage();
        await page.setViewport({ width: view.width, height: view.height });
        await page.emulateMediaFeatures([
          { name: 'prefers-color-scheme', value: room === 'darkroom' ? 'dark' : 'light' },
        ]);
        await page.goto(ORIGIN + url, { waitUntil: 'load' });
        await page.waitForFunction('window.__ready === true', { timeout: 20000 });
        // The room toggle persists via localStorage; force the scheme so the shot is
        // of the media query, not of a leftover choice.
        await page.evaluate((r) => { document.documentElement.dataset.room = r; }, room);
        await page.screenshot({
          path: path.join(SHOTS, `seo-${slug}-${view.name}-${room}.png`),
          fullPage: view.name === 'desktop',
        });
        shots++;
        await page.close();
      }
    }
  }
  ok(`wrote ${shots} screenshots to test/screenshots/`, shots === SHOT_PAGES.length * 4);

} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
