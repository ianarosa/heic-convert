/*
 * sw.js — Safelight's offline app shell. Scope: "/".
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────
 * The product's pitch is "your photos never leave the device — it works with your Wi-Fi
 * off". Before this file that was only true AFTER the page had loaded. This worker makes
 * it literal: it precaches the whole app — both tool pages, the CSS, every JS module and
 * the 1.4 MB libheif WASM bundle — so a cold, fully-offline load can still decode a HEIC.
 *
 * ── THE ONE HARD RULE: SAME-ORIGIN ONLY ─────────────────────────────────────────────
 * The entire value of this app is zero third-party traffic. This worker must never fetch,
 * cache, proxy, or phone home to ANY other origin. It handles only same-origin GETs and
 * bypasses everything else untouched. Do not add a cross-origin fetch here, ever.
 *
 * ── FRESHNESS IS CRITICAL (we were bitten by stale caching before) ──────────────────
 *   • The cache name is keyed to APP_VERSION. On activate, EVERY cache that isn't the
 *     current one is deleted, so an old build cannot linger.
 *   • Navigations (HTML) are NETWORK-FIRST: a new deploy's HTML reaches users immediately;
 *     the cache is only a fallback for when the network is actually gone. Users can never
 *     get trapped on a stale page.
 *   • skipWaiting + clients.claim make a new worker take over promptly.
 *
 * APP_VERSION MUST be kept in sync with VERSION in js/config.js. Bumping either without
 * the other is a mistake — they are the same build marker, deliberately duplicated
 * because a service worker cannot import an ES module in every browser we support.
 */

const APP_VERSION = '2026-07-16.pwa';
const CACHE = `safelight-${APP_VERSION}`;

/**
 * The critical app shell. All same-origin. Precaching these makes a first, fully-offline
 * load work end to end — including the WASM decode path, which is what makes "works with
 * the Wi-Fi off" a real feature rather than a slogan.
 */
const PRECACHE = [
  '/',
  '/index.html',
  '/compress/',
  '/compress/index.html',
  '/manifest.webmanifest',

  '/css/app.css',
  '/css/pages.css',
  '/css/compress.css',

  '/js/config.js',
  '/js/ui.js',
  '/js/main.js',
  '/js/queue.js',
  '/js/decode.js',
  '/js/decode.worker.js',
  '/js/encode.js',
  '/js/compress.js',

  '/vendor/libheif-bundle.mjs',
  '/vendor/client-zip.js',
  '/vendor/pdf-lib.js',

  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
  '/assets/apple-touch-icon.png',
];

/* ── Install: precache the shell ─────────────────────────────────────────────────────
 * Resilient on purpose. One asset failing to fetch must not abort the whole install and
 * leave the user with no offline support at all — the missing asset just falls back to
 * runtime caching on first real use. We still cache everything we can, up front. */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const results = await Promise.allSettled(
        PRECACHE.map((url) =>
          // cache: 'reload' bypasses the browser HTTP cache so we precache the freshly
          // deployed bytes, not whatever a stale disk cache might hand back.
          cache.add(new Request(url, { cache: 'reload' }))
        )
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) {
        // Not fatal. Log for diagnostics; runtime caching will pick these up later.
        console.warn(`[sw] precache: ${failed}/${PRECACHE.length} asset(s) failed`);
      }
    })
  );
});

/* ── Activate: delete every cache that isn't this version, then claim clients ───────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* Let a page tell a waiting worker to activate immediately (belt-and-braces with
 * skipWaiting above; harmless if unused). */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* ── Fetch ───────────────────────────────────────────────────────────────────────────
 * Same-origin GET only. Everything else is bypassed — no respondWith, so the browser
 * does exactly what it would with no worker installed. This is the guard that keeps the
 * zero-third-party promise absolute. */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Non-GET: never touched (there are no non-GET requests in this app anyway).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // CROSS-ORIGIN: bypass entirely. The worker must never reach another origin.
  if (url.origin !== self.location.origin) return;

  // Range requests (partial content) — let the network/browser handle them natively
  // rather than caching partial bodies. None are expected here; this is just safe.
  if (req.headers.has('range')) return;

  // Navigations (HTML documents): NETWORK-FIRST so a fresh deploy is seen immediately.
  const isNavigation =
    req.mode === 'navigate' ||
    (req.destination === 'document') ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Everything else same-origin (CSS, JS modules, the WASM bundle, icons): CACHE-FIRST.
  // These live under the versioned cache, so a version bump re-fetches them.
  event.respondWith(cacheFirst(req));
});

/**
 * Network-first for documents. Fall back to the cache only when the network genuinely
 * fails (offline). A successful response is copied into the cache so the page is
 * available next time the connection is gone.
 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    // Only cache complete, same-origin 200s. (Opaque/partial responses are never stored.)
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Offline: serve this exact page, then the precached shell for either tool page.
    const exact = await cache.match(req, { ignoreSearch: true });
    if (exact) return exact;
    const shell =
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      (await cache.match('/compress/'));
    if (shell) return shell;
    throw err;
  }
}

/**
 * Cache-first for static shell assets. On a miss, fetch and store a copy so a later
 * offline visit has it. Same-origin, 200-only.
 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Last resort: a same-origin match ignoring the query string, if any.
    const loose = await cache.match(req, { ignoreSearch: true });
    if (loose) return loose;
    throw err;
  }
}
