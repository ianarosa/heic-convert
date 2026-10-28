# test/

Verification for the decode foundation. Dev-only — none of this ships.

## Running

This repo is developed under WSL where **only Windows node exists**, and it cannot run
from a `/mnt/e` cwd (cmd.exe rejects UNC paths). Use `E:\`-style paths:

```bash
cmd.exe /c "E:\code\heic-convert\test\_run.bat verify.mjs"         # decode (browser)
cmd.exe /c "E:\code\heic-convert\test\_run.bat verify.encode.mjs"  # encode + queue (browser)
cmd.exe /c "E:\code\heic-convert\test\_run.bat verify.zip.mjs"     # download tiers (browser, slow)
cmd.exe /c "E:\code\heic-convert\test\_run.bat verify.node.mjs"    # node (secondary)
```

`_run.bat` just `cd /d E:\code\heic-convert\test` then runs `node.exe` on its argument.
On a normal machine, `npm test` / `npm run test:node` do the same thing.

First run needs the dev deps: `npm install` (installs `libheif-js` + `puppeteer-core`).

## Files

| File | What it is |
|---|---|
| `verify.mjs` | **The real test** for `js/decode.js`. Headless Chrome (puppeteer-core + system Chrome) against a static server, decoding `sample.heic` for real and asserting actual pixels, concurrency, error messages, and zero console errors/pageerrors. |
| `verify.encode.mjs` | **The real test** for `js/encode.js` + `js/queue.js`. Same approach: encodes real decoded pixels and asserts output magic bytes (JPEG/PNG/WebP/zip), re-decodes outputs to check dimensions, proves the JPEG white matte, runs a 20-file batch with progress/stats, proves per-item failure isolation and cancellation, and reads zip bytes back. Prints measured throughput. |
| `harness.encode.html` | Page that imports `js/encode.js` + `js/queue.js` and loads JSZip (as an independent zip *reader*), exposing them for `verify.encode.mjs`, `verify.zip.mjs`, `verify.pdf.mjs` and `verify.thumbnails.mjs`. |
| `verify.zip.mjs` | **The real test** for the tiered download strategy: streaming to disk, chunked zips, staggered downloads. Moves hundreds of MB, so it's split out from `verify.encode.mjs` to keep that one fast. See the ceiling notes below. |
| `verify.pdf.mjs` | **The real test** for PDF output: `encodeBitmap(format:'application/pdf')` and `combineFilesToPdf()`. Asserts `%PDF` magic, reads pages back with pdf-lib, checks page dims/order/quality, failure isolation (corrupt file skipped), and escalates the combine-PDF batch to measure the memory ceiling. |
| `verify.thumbnails.mjs` | **The real test** for `createQueue({ thumbnails:true })`: decodes each preview back to assert its size, proves the option is zero-cost when off, and spies on `URL.createObjectURL`/`revokeObjectURL` to prove no object-URL leaks across build/remove/clear cycles. |
| `vendor-client-zip.mjs` | Copies `vendor/client-zip.js` from `node_modules/client-zip`. Run via `npm run vendor:client-zip`. Not a test. |
| `vendor-pdf-lib.mjs` | Copies `vendor/pdf-lib.js` from `node_modules/pdf-lib`. Run via `npm run vendor:pdf-lib`. Not a test. |
| `verify.node.mjs` | Secondary. Exercises the vendored WASM in pure node and guards the bundle's no-SAB/no-pthread/inlined-wasm properties. |
| `server.mjs` | Static server that deliberately sends **no COOP/COEP**, mirroring Cloudflare Pages. |
| `harness.html` | Page that imports `js/decode.js` and exposes it as `window.__decode`. |
| `sample.heic` | Real 1440x960 HEIC (`ftypmif1`, compatible `heic`), 293,608 bytes. See provenance below. |
| `tiny.heic` | The 357-byte 64x64 HEIC embedded in `js/decode.js` as the native-support probe. |
| `tiny.hevc` | The raw HEVC bitstream `tiny.heic` was muxed from. |
| `mux.mjs` | Builds `tiny.heic` from `tiny.hevc`. |
| `_run.bat` | WSL convenience shim (see above). |

## Measured: the download ceiling, and how it was lifted

**The wall.** Chrome breaks Blobs past its in-memory blob quota (~500 MB) when blob
disk-spill is unavailable. Measured here: **~350 MB of live blob data reads back fine;
~500 MB gave `NotReadableError`** — repeatably, headless *and* headful, with **plain
`new Blob()` and no zip library anywhere**, so it is the browser's wall, not ours. A later
session read 750 MB back fine, so the wall MOVES; don't tune against any single number.

**The trap, and the lesson this suite is built around.** A broken Blob still looks healthy:
`blob.size` is correct and `URL.createObjectURL()` succeeds. It only fails when the bytes
are read — i.e. at the user's download. An earlier version of `verify.encode.mjs` asserted
on `.size` alone and **"passed" at 500 MB against data that was already unreadable.** So:

> **Every zip assertion must read the bytes back. Asserting on `.size` proves nothing.**

For the big cases, `verify.zip.mjs` parses the zip's central directory off disk **in
slices** and spot-checks entry payloads at their local-header offsets — reading the whole
file into memory would just re-create the problem streaming exists to avoid.

**The fix: `streamZipToDisk()`.** client-zip emits a `ReadableStream` piped straight into a
`FileSystemWritableFileStream`, so the zip never exists in memory. Measured, and this is
the point:

| files | zip written | peak JS heap |
|---|---|---|
| 50 | 150 MB | 154 MB |
| 100 | 300 MB | 152 MB |
| 200 | **600 MB** | **113 MB** |

The zip grew **4x while peak memory did not grow at all** — that's the proof it streams
rather than buffers. 600 MB is comfortably past the ~350 MB wall, and every one of those
archives was verified structurally (PK header, real EOCD, 200/200 central-directory
entries, correct payload bytes at spot-checked offsets).

**What streaming does NOT fix.** The queue still retains every converted JPEG as a Blob so
the UI can offer per-file downloads — ~600 MB for 200 full-size 12 MP photos, live
regardless of how they're zipped. Streaming roughly halves peak live bytes (sources + zip
-> sources only), which is what lifts 200 photos from "fails" to "works", but those source
blobs are the next ceiling. Beating it means not retaining output blobs at all (spooling to
OPFS) — not done.

**Fallback tiers** (Safari/Firefox have no File System Access API): `zipItemsChunked()`
builds several zips each capped at 100 MB — well under the wall, with room for it to move.
Pass `onChunk` for large batches so each part is downloaded and released before the next is
built; chunking while retaining every part is the same total memory, just in more pieces.

## Measured: the combine-into-one-PDF ceiling

`combineFilesToPdf()` (in `js/encode.js`) assembles the whole document in memory — pdf-lib
holds every page's embedded JPEG and then `doc.save()` serialises the lot into one byte
array before the Blob exists. There is **no streaming-PDF equivalent** of `streamZipToDisk`,
so this one has a real memory ceiling. Unlike the zip wall (a hard `NotReadableError`), this
is a soft, memory-bound limit: peak JS heap runs at roughly **3x the finished PDF size**.

Measured by escalating real conversions of `sample.heic` (~408 KB/page at q0.8) and reading
every page count **back out of the produced bytes** (never `.size`):

| photos | PDF size | peak JS heap | pages read back |
|---|---|---|---|
| 200 | 81 MB | 291 MB | 200 ✓ |
| 400 | 163 MB | 536 MB | 400 ✓ |
| 700 | 284 MB | 903 MB | 700 ✓ |
| 1100 | 447 MB | 1434 MB | 1100 ✓ |

It did **not** break in the tested range — the probe stopped at 1100 because a 1400-photo
run exceeded a 10-minute wall-clock budget (decode time, not memory). So the honest ceiling
is **> 1100 photos / > 447 MB**, bounded by the tab's available heap at ~3x the PDF size;
extrapolating, a ~2 GB tab heap lands near ~1500 photos / ~600 MB. Comfortably above the
200-photo target (which peaks at a harmless 291 MB). `verify.pdf.mjs` runs the 100/200/400
rungs each time to guard against regression.

## Sample provenance

- **`sample.heic`** — downloaded from `https://filesamples.com/samples/image/heic/sample1.heic`,
  a public sample-file host. Verified genuine by its `ftyp` box (major brand `mif1`,
  compatible brands `mif1`/`heic`) and by decoding to real pixels. **Licence is not
  stated by the source**; it is a test fixture only and is not served by the app. Swap it
  for an owned photo before publishing the repo if that matters.

- **`tiny.heic`** — **generated by us, so it carries no third-party licence.** This one
  matters because it is embedded (base64) in `js/decode.js` and therefore ships to users.
  Built as:

  ```bash
  ffmpeg -f lavfi -i "color=c=#3b82f6:s=64x64" -frames:v 1 -c:v libx265 \
         -pix_fmt yuv420p -f hevc -y tiny.hevc
  node mux.mjs tiny.hevc 64 64 tiny.heic
  ```

  `mux.mjs` parses the Annex-B NAL units, builds an `hvcC` config box from the SPS, and
  writes a minimal single-image HEIF container (`ftyp` + `meta`[`hdlr`/`pitm`/`iinf`/
  `iprp`/`iloc`] + `mdat`). Verified: libheif decodes it to 64x64 with the expected
  colour. Re-base64 it with `base64 -w0 tiny.heic` if you regenerate it.
