# Safelight

A HEIC → JPG converter that runs entirely in the browser. Your photos are never uploaded,
which means the tool also works offline, has no daily cap, and needs no account.

Live at **<https://heic.kostelinha.com>**.

The product claim and the architecture are the same sentence: there is no server to send
photos to. The front page instruments itself and reports what actually crossed the network
while you work — and then tells you not to believe it and to open DevTools instead.

---

## Table of contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Running it locally](#running-it-locally)
- [Running the tests](#running-the-tests)
- [Deploying to Cloudflare Pages](#deploying-to-cloudflare-pages)
- [URL structure](#url-structure)
- [Moving domains](#moving-domains) — every place the origin appears
- [Where to paste the AdSense publisher ID](#where-to-paste-the-adsense-publisher-id)
- [Licensing](#licensing)

---

## Architecture

**No build step. No bundler. No runtime dependencies.** Everything the browser needs is a
plain file committed to this repo. `package.json` exists only for dev tooling (tests and
vendoring); nothing in `node_modules/` is ever served.

The pipeline:

1. **Decode** — `js/decode.js` + `js/decode.worker.js`. A WebAssembly build of
   [libheif](https://github.com/strukturag/libheif) (`vendor/libheif-bundle.mjs`, ~1.4 MB)
   runs in a worker. On Safari/iOS the native system decoder is used instead, because it is
   already there and it is faster.
2. **Encode** — `js/encode.js`. Canvas re-encodes to JPG / PNG / WebP.
3. **Queue** — `js/queue.js`. Batching, progress, cancellation, and zip assembly via
   `vendor/client-zip.js` streamed straight to disk (so a 600 MB zip costs no more memory
   than a 150 MB one).
4. **UI** — `js/ui.js` (all DOM access) + `js/main.js` (app logic, touches no element
   directly). `js/config.js` holds every knob and string worth changing.

The 1.4 MB decoder is **not** referenced from `<head>`. It is imported only once you show
intent to convert (hover / focus / drag the drop zone), so first paint never waits on it.

### The one rule this codebase actually enforces

**The page makes no third-party requests, ever.** Not a font CDN, not an analytics ping.
The favicon is an inline `data:` URI for the same reason. `test/verify.ui.mjs` and
`test/verify.seo.mjs` both watch every request Chrome makes *from outside the page* and
fail if anything crosses to another host. Adding AdSense will knowingly break this on the
pages that carry ads — see [LAUNCH.md](LAUNCH.md), which is blunt about the tradeoff, and
`privacy/index.html`, which must be updated the same day.

---

## Repository layout

```
index.html                  The converter. Owner-maintained.
css/app.css                 The "Safelight" design system + app styles. Tokens live here.
css/pages.css               Content-page primitives. Extends app.css; declares no colours.
js/                         config, decode, encode, queue, ui, main  (+ pages.js for guides)
vendor/                     libheif-bundle.mjs (LGPL-3.0), client-zip.js (MIT), licences
guides/                     5 how-to landing pages + hub
compare/                    4 comparison / trust pages + hub
privacy/                    Privacy policy
404.html                    Error page
sitemap.xml  robots.txt     Crawler surface. sitemap.xml is verified against the filesystem.
ads.txt                     Placeholder. Authorises nobody until you edit it.
test/                       Headless-Chrome harness + static server. Dev only, never deployed.
LAUNCH.md                   Monetisation + promotion playbook. Read this before launching.
```

---

## Running it locally

Node here is **Windows-only** under WSL:

```bash
"/mnt/c/Program Files/nodejs/node.exe" test/server.mjs
```

It prints a `http://127.0.0.1:PORT/` URL. The server sends no COOP/COEP headers on purpose —
that mirrors plain static hosting and proves the decoder needs no cross-origin isolation.

> **Note for content pages:** `test/server.mjs` does not resolve directory indexes, so
> `/guides/` will 404 against it. Browse to `/guides/index.html` instead, or run
> `test/verify.seo.mjs`, which starts its own server that does resolve them exactly the way
> Cloudflare Pages does.

---

## Running the tests

```bash
node test/verify.mjs          # decoder, against real HEIC bytes
node test/verify.encode.mjs   # encoder + measured size ratios + Chrome's blob ceiling
node test/verify.zip.mjs      # zips, read back with a *different* library (JSZip)
node test/verify.ui.mjs       # the real user flow in headless Chrome + the no-upload claim
node test/verify.seo.mjs      # content pages: errors, links, sitemap, JSON-LD, screenshots
npm test                      # the first three
```

All of them need real Chrome; paths are probed in each file's `CHROME_CANDIDATES`. See
`test/README.md` for the WSL specifics.

`test/verify.seo.mjs` is the one that guards this SEO surface. It asserts, on every page:

- zero pageerrors and zero console errors,
- **zero third-party requests** — the product claim, enforced,
- every internal link resolves (no 404s, including the sitemap's own URLs),
- `sitemap.xml` lists **exactly** the pages that exist — no phantom URLs, none missing,
- every JSON-LD block parses and has `@context` + `@type`,
- one `<h1>`, a canonical, a title and a meta description on every page,
- screenshots at desktop + mobile × lightbox + darkroom into `test/screenshots/`.

---

## Deploying to Cloudflare Pages

The site is static files. There is nothing to build.

**Settings → Builds & deployments:**

| Field | Value |
|---|---|
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `/` |
| Root directory | `/` |

Connect the repo and pushes to `main` deploy automatically.

Two things to exclude from the deployed output — neither is required, both are tidy:

- `test/` and `node_modules/` are dev-only. `robots.txt` disallows `/test/` regardless.
- Add a `.cfignore`-style exclusion or simply leave them; they are harmless but waste
  deploy size (`node_modules/` is not committed, per `.gitignore`).

**Custom domain:** Pages → your project → Custom domains → add `heic.kostelinha.com`.
Cloudflare creates the CNAME automatically when the zone is on the same account.

Clean URLs work out of the box: Cloudflare Pages serves `guides/foo/index.html` at
`/guides/foo/`, which is why every content page is a directory with an `index.html` rather
than a flat `.html` file. That layout also works on Netlify, GitHub Pages, S3 and nginx
unchanged — the URL structure is not tied to Cloudflare.

---

## URL structure

Fourteen indexable pages owned here. All canonicals use a **trailing slash**, which is
what Pages serves.

| URL | File |
|---|---|
| `/` | `index.html` |
| `/guides/` | `guides/index.html` |
| `/guides/heic-to-jpg-without-uploading/` | `guides/heic-to-jpg-without-uploading/index.html` |
| `/guides/batch-convert-heic-to-jpg/` | `guides/batch-convert-heic-to-jpg/index.html` |
| `/guides/open-heic-files-windows-11/` | `guides/open-heic-files-windows-11/index.html` |
| `/guides/heic-to-jpg-free-unlimited/` | `guides/heic-to-jpg-free-unlimited/index.html` |
| `/guides/heic-to-png/` | `guides/heic-to-png/index.html` |
| `/guides/heic-to-pdf/` | `guides/heic-to-pdf/index.html` |
| `/compare/` | `compare/index.html` |
| `/compare/is-heictojpg-com-safe/` | `compare/is-heictojpg-com-safe/index.html` |
| `/compare/is-freeconvert-safe/` | `compare/is-freeconvert-safe/index.html` |
| `/compare/is-cloudconvert-safe/` | `compare/is-cloudconvert-safe/index.html` |
| `/compare/heictojpg-alternative/` | `compare/heictojpg-alternative/index.html` |
| `/privacy/` | `privacy/index.html` |

`404.html` is served by Pages automatically for unmatched paths. It is `noindex` and is
deliberately **not** in the sitemap.

**`/compress/` is a separate tool, owned by a different agent.** It is listed in
`sitemap.xml` and linked from the guide and compare hubs so it is crawled and
interlinked from launch, but its `index.html` is not maintained here. The SEO test
(`test/verify.seo.mjs`) treats it as PENDING: exempt from sitemap↔filesystem parity and
from the internal-link 404 check until its file lands, at which point the exemption
becomes a no-op. See the `PENDING` set in that file.

**The converter now supports PDF** — one PDF per photo, or all photos combined into a
single PDF — so `/guides/heic-to-pdf/` is a real, honest page. (Earlier revisions of this
project did not do PDF and this section warned against building the page; that constraint
is lifted now that the feature exists. It still does **not** do video, exotic formats or
OCR, and every page says so and points those users to a cloud converter.)

---

## Moving domains

The origin `https://heic.kostelinha.com` is hardcoded in **18 files**. There is no build
step, so it cannot be generated from one constant — this list is the substitute, and
`test/verify.seo.mjs` fails if a canonical stops matching the sitemap, so a half-finished
move gets caught.

Find-and-replace `https://heic.kostelinha.com` across the repo, then check each of these:

| File | Occurrences | What carries it |
|---|---|---|
| `index.html` | 7 | the `<!-- SITE ORIGIN -->` block + JSON-LD `@id`/`url` |
| `js/config.js` | 1 | `SITE.origin` — the source of truth *for JavaScript* |
| `sitemap.xml` | 15 | every `<loc>` (sitemaps require absolute URLs) |
| `robots.txt` | 2 | the header comment + the `Sitemap:` line |
| `guides/index.html` | 14 | SITE ORIGIN block + JSON-LD ItemList |
| `guides/heic-to-jpg-without-uploading/index.html` | 12 | SITE ORIGIN block + JSON-LD |
| `guides/batch-convert-heic-to-jpg/index.html` | 11 | SITE ORIGIN block + JSON-LD |
| `guides/open-heic-files-windows-11/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `guides/heic-to-jpg-free-unlimited/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `guides/heic-to-png/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `guides/heic-to-pdf/index.html` | 13 | SITE ORIGIN block + JSON-LD (SoftwareApplication + HowTo) |
| `compare/index.html` | 12 | SITE ORIGIN block + JSON-LD ItemList |
| `compare/is-heictojpg-com-safe/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `compare/is-freeconvert-safe/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `compare/is-cloudconvert-safe/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `compare/heictojpg-alternative/index.html` | 7 | SITE ORIGIN block + JSON-LD |
| `privacy/index.html` | 5 | SITE ORIGIN block + JSON-LD |
| `compress/index.html` | 7 | **owned by another agent** — SITE ORIGIN block + JSON-LD |

`404.html` carries **no** origin, by design. `compress/index.html` is not maintained
here, but it does carry the origin, so a domain move must include it — coordinate with
whoever owns that tool.

Verify the move with:

```bash
grep -rl "heic.kostelinha.com" --include="*.html" --include="*.js" --include="*.xml" --include="*.txt" . | grep -v node_modules
```

That should print nothing when the move is complete. Then re-run `test/verify.seo.mjs`,
and in Google Search Console add the new property and submit the new sitemap.

---

## Where to paste the AdSense publisher ID

Nothing is served today: `AD_CLIENT` is `null`, so the slots are reserved but empty. Their
heights are already committed in CSS (`--ad-h-below`, `--ad-h-content` in `css/app.css`), so
filling them shifts no content and cannot hurt CLS.

**Your publisher ID goes in three places.** All three are required; one alone does nothing.

1. **`js/config.js`** — line ~113:
   ```js
   export const AD_CLIENT = 'ca-pub-XXXXXXXXXXXXXXXX';   // was null
   ```
   Fill in `AD_SLOTS.belowTool.slot` and `AD_SLOTS.inContent.slot` with the slot IDs AdSense
   generates per unit.

2. **`ads.txt`** — uncomment the `google.com` line and paste the `pub-…` form (note: **no**
   `ca-` prefix in this file). Instructions are in the file.

3. **The `<head>` of every page that shows an ad** — the AdSense script tag, plus an
   `<ins class="adsbygoogle">` inside each `.ad__box`. The pages with slots are:
   `index.html` (two: `#ad-below-tool`, `#ad-in-content`) and each of the five guides and
   four compare pages (one `#ad-in-content` each). The hubs, `privacy/` and `404.html`
   deliberately have none.

**Then update `privacy/index.html` the same day.** It currently states as fact that no ads
are served and no advertising cookies are set. That becomes false the moment you deploy the
script tag. The file has an `<!-- OWNER: -->` block listing exactly what to change.

The full checklist, the consent-management requirement for EU/UK traffic, and honest
earnings maths are in **[LAUNCH.md](LAUNCH.md)**.

---

## Licensing

**Read the licensing section of [LAUNCH.md](LAUNCH.md) before you put ads on this.** It is
not a formality: `vendor/libheif-bundle.mjs` is **LGPL-3.0**, the site ships it to every
visitor's browser, and shipping it is what triggers the licence's obligations. There is one
concrete gap open today (the GNU GPL text is not included alongside the LGPL text, which
LGPL-3.0 §4(b) requires) and it takes about five minutes to close.

Short version:

- **`vendor/libheif-bundle.mjs`** — LGPL-3.0. Used unmodified, as a separate dynamically
  imported module. **Your own code in `js/` does not have to be open-sourced** because of it.
- **`vendor/client-zip.js`** — MIT. Attribution only.
- **JSZip** — MIT. A devDependency used only as an independent zip *reader* in the tests.
  It is never vendored and never ships.

Nothing here is legal advice.
