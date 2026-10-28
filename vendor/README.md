# vendor/

Third-party code, vendored as plain files the browser loads directly. **No build step, no
bundler, no npm install needed at runtime.**

## libheif-bundle.mjs

| | |
|---|---|
| Package | [`libheif-js`](https://www.npmjs.com/package/libheif-js) v1.19.8 (Emscripten build of [libheif](https://github.com/strukturag/libheif)) |
| Source path | `node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs` |
| Size | 1,461,926 bytes (~1.4 MB) |
| Licence | LGPL-3.0 — see `LICENSE.libheif-js.txt` |

### Why this build (of the four on offer)

`libheif-js` ships several variants:

| Variant | Verdict |
|---|---|
| `libheif/libheif.js` | Pure-JS asm.js build, 2.1 MB. Much slower than wasm. Rejected. |
| `libheif-wasm/libheif.js` + `.wasm` | Loads the `.wasm` as a **separate fetch**. Needs path wiring and an extra request. Rejected. |
| `libheif-wasm/libheif-bundle.js` | Wasm inlined, but a classic/UMD script — awkward inside a module worker. Rejected. |
| **`libheif-wasm/libheif-bundle.mjs`** | **Wasm inlined as a base64 data URI, ES module with a default-export factory. Chosen.** |

The `.mjs` bundle was chosen because:

- **No extra fetch / no CSP or MIME wiring.** The `.wasm` is inlined as a
  `data:application/octet-stream;base64` URI, so there is exactly one file to serve.
- **No SharedArrayBuffer, no pthreads, no COOP/COEP.** Verified by inspection — the
  bundle contains zero occurrences of `SharedArrayBuffer`, `pthread`, and
  `crossOriginIsolated`. It therefore runs on plain static hosting (Cloudflare Pages)
  with no special response headers.
- **ES module**, which is what `js/decode.worker.js` wants (`new Worker(url, { type: 'module' })`).

### Usage

```js
import libheifFactory from '../vendor/libheif-bundle.mjs';
const libheif = await libheifFactory();   // compiles the inlined wasm
```

### Updating

```bash
npm install libheif-js            # see package.json (dev-only)
cp node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs vendor/
cp node_modules/libheif-js/LICENSE vendor/LICENSE.libheif-js.txt
```

Then re-run `test/verify.mjs` and re-check that the new bundle still has no
`SharedArrayBuffer` / `pthread` references.

### Known bugs in libheif-js 1.19.8 that `decode.worker.js` works around

- `HeifImage.prototype.is_primary()` **always throws** — it calls a bare global
  `heif_image_handle_is_primary_image` instead of `Module.heif_image_handle_is_primary_image`.
- `HeifDecoder.prototype.decode()` swallows parse errors, `console.log`s them, and
  returns `[]`, discarding the real error text.

Both are avoided by driving the low-level `heif_*` C API directly.

## client-zip.js

| | |
|---|---|
| Package | [`client-zip`](https://www.npmjs.com/package/client-zip) v2.5.0 |
| Source path | `node_modules/client-zip/index.js` |
| Size | 6,463 bytes (~6 KB) |
| Licence | **MIT** — see `LICENSE.client-zip.txt` |
| Used by | `js/queue.js` → `streamZipToDisk()`, `zipItemsChunked()`, `zipItems()` |

**Verbatim byte-for-byte copy — no wrapper, no transform.** client-zip already publishes a
browser-targeted ES module (`"type": "module"`), so unlike most npm packages it just works
with `import`. `npm run vendor:client-zip` copies it and asserts the properties we depend on
(exports `makeZip`/`predictLength`, no `require()`, no node builtins).

### Why client-zip and not JSZip

This started on JSZip and moved. JSZip builds archives **in memory**, which collides with
Chrome's ~500 MB blob quota — past it, Chrome hands back a Blob that reports the right
`.size` and yields a working object URL but **fails when the bytes are read**, i.e. at the
user's download. Bulk conversion is this product's whole differentiator, so "200 photos
silently produces a corrupt zip" was not survivable.

client-zip emits a **`ReadableStream`**, which pipes straight into a
`FileSystemWritableFileStream` — the zip never exists in memory and its size stops
mattering. Measured: a 600 MB zip written with peak memory *flat* (a 4x larger zip cost no
more memory than a 150 MB one). It is also ~6 KB against JSZip's ~97 KB, and needs no UMD
wrapper.

JSZip remains a **devDependency**, used only by the tests as an *independent zip reader* —
deliberately a different library from the one that wrote the archive, so a malformed zip
can't be masked by a same-library round trip. It is not vendored and never ships.

### Usage

```js
// Loaded on demand, so users who never download a zip never pay the ~6 KB.
const { makeZip, predictLength } = await import('../vendor/client-zip.js');
await makeZip(entries).pipeTo(writable);   // entries: { name, input: Blob, lastModified }
```

`predictLength(entries)` returns the exact final byte length from metadata alone (no bytes
read), which is what gives the download a real percentage instead of a guess. Zip64 is
handled automatically when a batch needs it.

### Updating

```bash
npm install client-zip     # dev-only; see package.json
npm run vendor:client-zip  # re-copies index.js + LICENSE.txt and re-checks invariants
npm run test:zip           # re-verify
```

## pdf-lib.js

| | |
|---|---|
| Package | [`pdf-lib`](https://www.npmjs.com/package/pdf-lib) v1.17.1 |
| Source path | `node_modules/pdf-lib/dist/pdf-lib.esm.min.js` |
| Size | 523,417 bytes (~511 KB) |
| Licence | **MIT** — see `LICENSE.pdf-lib.txt` |
| Used by | `js/encode.js` → `encodeBitmap(format:'application/pdf')` and `combineFilesToPdf()` |

**Verbatim byte-for-byte copy of pdf-lib's prebuilt minified ESM.** pdf-lib ships a
`dist/pdf-lib.esm.min.js` with all four of its npm deps (`@pdf-lib/standard-fonts`,
`@pdf-lib/upng`, `pako`, `tslib`) bundled inline — zero bare import specifiers, no `node:`
imports, no `require()` of node builtins — so, like client-zip, it loads with a plain
`import` and no bundler. We take the minified build (511 KB) over the unminified one
(1.5 MB): same API, and it's loaded on demand so only users who export a PDF pay for it.

Confirmed self-contained: no external fetch, no `.wasm`, no COOP/COEP — consistent with the
rest of the app (it's pure JS + pako for stream compression). `vendor:pdf-lib` asserts the
exports we rely on (`PDFDocument`, `embedJpg`) and the no-bare-imports invariant.

### Why pdf-lib and not jsPDF

Both are MIT. pdf-lib wins on *vendoring cleanliness*, which is the whole constraint here:
it publishes a ready-made self-contained browser ESM, so vendoring is a copy with nothing to
wrap. Its API is also the right shape for our job — `embedJpg()` takes the JPEG bytes we
already produce and `addPage([w,h]).drawImage()` places them at exact point dimensions.
(jsPDF's ESM build pulls in optional worker/canvas paths and is fiddlier to load as a single
plain module; no advantage for embed-one-JPEG-per-page.)

### Usage

```js
// Loaded on demand — users who never export a PDF never fetch the ~511 KB.
const { PDFDocument } = await import('../vendor/pdf-lib.js');
const doc = await PDFDocument.create();
const img = await doc.embedJpg(jpegBytes);
doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width, height });
const bytes = await doc.save();          // Uint8Array
```

PDF pages are sized 1px -> 1pt (72 dpi), so a photo's pixel dimensions map straight to the
page's point dimensions.

### Updating

```bash
npm install pdf-lib     # dev-only; see package.json
npm run vendor:pdf-lib  # re-copies the minified ESM + LICENSE and re-checks invariants
npm run test:pdf        # re-verify
```

## imagetracer.js

| | |
|---|---|
| Package | [`imagetracerjs`](https://www.npmjs.com/package/imagetracerjs) v1.2.6 ([source](https://github.com/jankovicsandras/imagetracerjs)) |
| Source path | `imagetracer_v1.2.6.js` (fetched from `unpkg.com/imagetracerjs@1.2.6/`) |
| Size | ~47 KB |
| Licence | **The Unlicense / public domain** — see `LICENSE.imagetracer.txt` |
| Used by | `js/encode.js` → the SVG trace path (`encodeBitmap(format:'image/svg+xml')`) |

Pure JavaScript raster→vector tracer (bitmap → SVG). **No WebAssembly, no network, no build
step** — the trace runs entirely on the user's machine, so the zero-upload guarantee holds
for SVG output exactly as it does for every other format.

**Near-verbatim copy — only the module-export tail is adapted.** Upstream ends with a UMD
block that assigns a browser/worker GLOBAL (`self.ImageTracer`). We replaced *only* that
block with a module-scoped binding and a `default` export, so the file is a clean ES module
that loads with a plain `import()` and pollutes no globals (see the banner at the top of
`imagetracer.js`). None of the tracer's logic is touched. Full detail in
`README.imagetracer.txt`.

### Why tracing, honestly

Vectorizing a raster is **lossy and approximate**. It is genuinely good for logos, icons,
flat graphics and UI screenshots — and genuinely bad for photographs, which come out large
and blurry/posterised. The converter says so up front (the SVG format hint) and raises a
per-batch photo-guard when the input looks like a photo. We never pretend a traced photo is
a good result.

### Usage

```js
// Loaded on demand — ONLY when SVG output is produced. Never in the page's load-time module
// graph, and never fetched by a non-SVG conversion.
const ImageTracer = (await import('../vendor/imagetracer.js')).default;
const svg = ImageTracer.imagedataToSVG(imagedata, options); // returns an SVG string
```

### Updating

```bash
# dev-only; the app needs no npm install at runtime.
curl -sSL -o imagetracer_v1.2.6.js https://unpkg.com/imagetracerjs@1.2.6/imagetracer_v1.2.6.js
# then re-apply the ESM-export tail adaptation (see the banner in vendor/imagetracer.js)
curl -sSL -o vendor/LICENSE.imagetracer.txt https://unpkg.com/imagetracerjs@1.2.6/LICENSE
npm run test:svg   # test/verify.svg.mjs
```

## LICENSE.imagetracer.txt

The Unlicense (public domain), copied verbatim from the `imagetracerjs` package's own
`LICENSE` file — identical to the licence header inside `imagetracer_v1.2.6.js`. No
attribution is legally required; we keep it and credit the library anyway. Keep it next to
`imagetracer.js` when redistributing.

## LICENSE.libheif-js.txt

LGPL-3.0, copied verbatim from the `libheif-js` package. libheif is used unmodified as a
dynamically-loaded library, which is what LGPL-3.0 §4 contemplates. Keep this file next to
the bundle when redistributing.

## LICENSE.gpl-3.0.txt

GPL-3.0, copied verbatim. Required because LGPL-3.0 §4(b) says a copy of *both* the LGPL
and the GNU GPL must accompany the conveyed library (the LGPL is written as a set of
additional permissions on top of the GPL). Extracted verbatim from the combined LICENSE
that ships inside `libheif-js` (`node_modules/libheif-js/libheif-wasm/LICENSE`, GPL-3.0
section) — identical to the canonical FSF text. Keep next to the bundle when redistributing.

## README.libheif.txt

Plain-text NOTICE satisfying LGPL-3.0 §4(a) (attribution) and §4(e) (source availability):
library name, exact pinned version, an "unmodified" statement, source links at that version,
and pointers to the two license texts above. Ships alongside the bundle.

## LICENSE.client-zip.txt

MIT, copied verbatim from the `client-zip` package. Keep it next to `client-zip.js` when
redistributing.

## LICENSE.pdf-lib.txt

MIT, copied verbatim from the `pdf-lib` package (`LICENSE.md`). Keep it next to `pdf-lib.js`
when redistributing.
