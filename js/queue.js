/**
 * queue.js — bulk conversion orchestration. Decode -> encode -> release, N at a time.
 *
 * PUBLIC API
 *   createQueue(opts) -> queue
 *     Optional `thumbnails: true` makes each item carry a small preview at `item.thumbnail`
 *     (an object URL string). The queue owns/revokes those URLs — see createQueue's docs.
 *     queue.dispose() revokes them all; call it (or clear()) before discarding the queue.
 *
 *   Downloading a batch — three tiers, best first. See the big comment further down.
 *   canStreamZip() -> boolean                        is tier 1 available?
 *   pickZipDestination(suggestedName) -> handle|null ask where to save (needs a gesture)
 *   streamZipToDisk(items, opts) -> Promise<result>  TIER 1: stream to disk, unlimited size
 *   planChunkedZips(items, maxBytes) -> preview      "this will be 3 zips", builds nothing
 *   zipItemsChunked(items, opts) -> Promise<chunks>  TIER 2: several capped zips
 *   downloadBlobs(files, opts) -> Promise<number>    staggered downloads (browsers throttle)
 *   zipItems(items, onProgress) -> Promise<Blob>     one in-memory zip; small batches only
 *
 * ── DESIGN NOTES ────────────────────────────────────────────────────────────────────
 *
 * MEMORY is the whole ballgame here. A 200-photo batch of 12 MP iPhone HEICs is ~9.6 GB
 * of decoded RGBA if you hold every ImageBitmap at once, so we never do: each item is
 * decoded, encoded, and released before the next one starts on that lane. At any moment
 * at most `concurrency` bitmaps exist. The output Blobs we DO retain — a Blob is a handle
 * the browser can (and does) back with disk, so 200 JPEGs of ~2 MB is cheap to hold.
 * `encodeBitmap()` consumes the bitmap it's given (see encode.js), so the release is
 * structural rather than something each path here has to remember.
 *
 * FAILURE ISOLATION: every item runs inside its own try/catch. One corrupt HEIC in a
 * 200-file batch marks exactly one item `error` and the batch carries on. There is no
 * shared mutable decode state that a failure could poison — decode.js's worker pool
 * already survives a bad file.
 *
 * CONCURRENCY: we do NOT implement our own worker pool. decode.js already has one and is
 * self-limiting, so this is a scheduler over promises, not over threads. The default
 * matches decode.js's pool size so we keep its workers fed without queueing work behind
 * them that we could still cancel.
 *
 * CANCELLATION is cooperative: there is no way to abort a decode already inside a WASM
 * worker. What we guarantee is that cancelling stops *scheduling* immediately, and that
 * every in-flight item checks for cancellation after each await — so at most
 * `concurrency` items finish their current step, and their bitmaps are still released.
 */

import { encodeBitmap, outputFilename } from './encode.js';

// NOTE: js/decode.js (the HEIC path, and behind it the 1.4 MB libheif WASM) is NOT imported
// at the top on purpose. This queue now converts ANY image — HEIC/HEIF via libheif, and
// JPG/PNG/WebP natively via createImageBitmap. Pulling decode.js in statically would drag the
// decoder's module into every batch, and (once a worker spawns) the WASM with it, even for a
// JPG-only run that never needs it. So decode.js is dynamically imported in decodeItem() only
// when a HEIC/HEIF file is actually present — the same lazy pattern encode.js uses for PDF.

const DEFAULT_CONCURRENCY = Math.min(
  (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4,
  4
);

/**
 * ISO base-media-file-format brands we accept, from the `ftyp` box.
 *
 * Sources: ISO/IEC 23008-12 (HEIF) Annex B, ISO/IEC 23000-22 (MIAF), and the brands Apple
 * actually writes. Brands are 4 chars and CASE-SENSITIVE (Apple's are mixed case).
 *
 *   heic/heix        HEVC still, 8-bit / 10-bit+extended        <- the common iPhone case
 *   heim/heis        HEVC multiview / scalable still
 *   hevc/hevx        HEVC image SEQUENCE (bursts, Live Photos)
 *   hevm/hevs        HEVC multiview / scalable sequence
 *   mif1/mif2        generic HEIF image  <- iPhone files often use this as the MAJOR brand
 *   msf1             generic HEIF image sequence
 *   miaf/mia1        MIAF profile markers, present on modern iPhone output
 *   MiHE/MiHB/MiPr   Apple: HEIF-extended / burst / progressive
 *   avif/avis        AVIF still / sequence — libheif decodes these too, so accepting them
 *                    costs nothing and beats a confusing rejection. (They'd usually pass
 *                    on their `mif1` compatible brand anyway.)
 *
 * WHY WE PARSE THE FULL BRAND LIST rather than just checking bytes 4..11 for 'ftypheic':
 * our own test/sample.heic is `ftypmif1` with `heic` appearing only in the COMPATIBLE
 * brands, and plenty of real iPhone files are the same. A major-brand-only check rejects
 * valid photos. So: major brand OR any compatible brand matching is enough.
 */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis',
  'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'mif2', 'msf1',
  'miaf', 'mia1',
  'MiHE', 'MiHB', 'MiPr',
  'avif', 'avis',
]);

/** How much of the head we read to sniff. The ftyp box is the first box and is tiny. */
const SNIFF_BYTES = 256;

const asciiAt = (bytes, offset) =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

const uint32At = (bytes, offset) =>
  ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];

const WEB_IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const WEB_IMAGE_TYPE_RE = /^image\/(jpeg|png|webp)$/i;

/** Does the ftyp box's brand list mark this as HEIF/HEIC (so it needs the libheif path)? */
function isHeifHead(head) {
  // Need at least: box size (4) + 'ftyp' (4) + major brand (4).
  if (head.length < 12 || asciiAt(head, 4) !== 'ftyp') return false;
  const major = asciiAt(head, 8);
  const brands = [major];
  // ftyp layout: [size:4]['ftyp':4][major:4][minor_version:4][compatible brands: 4 each]
  const boxSize = uint32At(head, 0);
  const end = Math.min(boxSize > 0 ? boxSize : head.length, head.length);
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(asciiAt(head, offset));
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

/** Web image magic: JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A), WebP (RIFF….WEBP). */
function isWebImageMagic(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return true;
  if (head.length >= 12 && asciiAt(head, 0) === 'RIFF' && asciiAt(head, 8) === 'WEBP') return true;
  return false;
}

/**
 * Classify input BEFORE it reaches a decoder, so an unreadable file gets a clear human
 * message instead of whatever the decoder says about a malformed bitstream — and so we know
 * which decode path to take. Returns the KIND so the caller doesn't have to sniff twice.
 *
 * Reads only the first 256 bytes — `file.slice()` doesn't pull the whole file off disk, so
 * this stays cheap even for a 200-file batch.
 *
 * @param {File|Blob} file
 * @returns {Promise<'heif'|'web'>} the decode path, or throws a human error if unsupported.
 */
async function assertSupportedImage(file) {
  if (!file || typeof file.slice !== 'function' || typeof file.arrayBuffer !== 'function') {
    throw new Error('This item is not a readable file.');
  }
  if (file.size === 0) throw new Error('This file is empty.');

  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());

  if (isHeifHead(head)) return 'heif';
  if (isWebImageMagic(head)) return 'web';

  // A valid JPG/PNG/WebP whose magic we somehow didn't catch still decodes natively — let
  // createImageBitmap try rather than reject on a header edge case. Only if neither the
  // bytes nor the name/type look like anything we support do we refuse.
  if (WEB_IMAGE_EXT_RE.test(file.name || '') || WEB_IMAGE_TYPE_RE.test(file.type || '')) return 'web';

  throw new Error('This isn’t an image this converter can read — use HEIC, HEIF, JPG, PNG or WebP.');
}

/**
 * Decode one input file to an ImageBitmap, routing by kind:
 *   • 'heif' → libheif, pulled in with a DYNAMIC import so the 1.4 MB WASM only ever loads
 *              when a HEIC/HEIF is actually processed (never on a JPG/PNG/WebP-only run).
 *   • 'web'  → the browser's native decoder via createImageBitmap — no WASM, off the main
 *              thread. `imageOrientation:'from-image'` applies any EXIF orientation.
 *
 * @param {File|Blob} file
 * @param {'heif'|'web'} kind
 * @returns {Promise<{ bitmap: ImageBitmap, width: number, height: number }>}
 */
async function decodeItem(file, kind) {
  if (kind === 'heif') {
    const { decodeHeic } = await import('./decode.js');
    return decodeHeic(file);
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** Cancellation is signalled by throwing this, so it can't be confused with a real error. */
class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

/** A callback blowing up is the app's bug, not a reason to kill the batch. */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.warn('queue: a callback threw', err);
  }
}

/**
 * Make a small JPEG preview from a decoded bitmap and return it as an object URL.
 *
 * Uses createImageBitmap()'s built-in high-quality resampler to shrink to ~`size`px on the
 * longest side, encodes that small bitmap to a low-quality JPEG (previews don't need q0.85),
 * and hands back a "blob:" URL. Never retains the full bitmap and never closes it — the
 * source bitmap stays valid for the caller's main encode.
 *
 * Returns null (never throws) on any failure: a missing preview must not fail a conversion.
 *
 * @param {ImageBitmap} bitmap  NOT consumed — caller still owns it.
 * @param {number} size
 * @returns {Promise<string|null>} object URL, or null
 */
async function makeThumbnail(bitmap, size) {
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > size ? size / longest : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    // A NEW small bitmap; the source is untouched. resizeQuality:'high' => real downsample.
    const small = await createImageBitmap(bitmap, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
    // encodeBitmap consumes `small` (closes it) — exactly what we want for the throwaway.
    const blob = await encodeBitmap(small, { format: 'image/jpeg', quality: 0.7 });
    return URL.createObjectURL(blob);
  } catch (_) {
    return null;
  }
}

let nextItemId = 1;

/**
 * Create a conversion queue. Does NOT start automatically — call `queue.start()`.
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency=min(hardwareConcurrency,4)]
 * @param {'image/jpeg'|'image/png'|'image/webp'|'application/pdf'} [opts.format='image/jpeg']
 * @param {number} [opts.quality=0.85]
 * @param {number} [opts.maxDimension]
 * @param {boolean} [opts.thumbnails=false] Opt-in. When true, each item gets a small JPEG
 *   preview generated from the decoded bitmap (before it's consumed) and exposed as
 *   `item.thumbnail` — an OBJECT URL STRING (e.g. "blob:...") the UI can drop straight into
 *   `<img src>`. Off by default, and off means zero extra work and no `item.thumbnail`.
 *   OWNERSHIP: the queue owns these object URLs and revokes them on remove(id), clear(),
 *   retryItem(id) (before regenerating), and dispose(). If you discard a queue, call
 *   clear() or dispose() first or the URLs leak.
 * @param {number} [opts.thumbnailSize=160] Longest-side px for the thumbnail.
 * @param {(item) => void} [opts.onItemStart]
 * @param {(item) => void} [opts.onItemDone]    item.blob / item.outputName are set
 * @param {(item, err) => void} [opts.onItemError]
 * @param {(done, total) => void} [opts.onProgress]  `done` = items in a FINAL state
 *   (done + error + cancelled), so it rises monotonically through a run and reaches
 *   `total` exactly once everything has settled.
 * @param {(items) => void} [opts.onAllDone]
 * @returns {object} queue
 */
export function createQueue(opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const format = opts.format || 'image/jpeg';
  const wantThumbnails = opts.thumbnails === true;
  const thumbnailSize = opts.thumbnailSize > 0 ? opts.thumbnailSize : 160;

  /** Release an item's thumbnail object URL, if it has one. Idempotent. */
  function revokeThumbnail(item) {
    if (item && typeof item.thumbnail === 'string') {
      try {
        URL.revokeObjectURL(item.thumbnail);
      } catch (_) {
        /* already revoked / not a blob URL */
      }
      item.thumbnail = undefined;
    }
  }

  /** @type {Array<object>} live array — the UI may hold this reference and re-render it. */
  const items = [];

  let started = false;
  let cancelled = false;
  let drained = false;
  let running = 0;

  const isFinal = (status) => status === 'done' || status === 'error' || status === 'cancelled';
  const countFinal = () => items.reduce((n, item) => n + (isFinal(item.status) ? 1 : 0), 0);

  /** An item is stopped if the whole queue was cancelled, it was cancelled, or removed. */
  const isStopped = (item) =>
    cancelled || item.status === 'cancelled' || items.indexOf(item) === -1;

  function reportProgress() {
    safeCall(opts.onProgress, countFinal(), items.length);
  }

  function maybeAllDone() {
    if (!started || drained || running > 0) return;
    // While cancelling we don't wait for the pending ones — they'll never run.
    if (!cancelled && items.some((item) => item.status === 'pending')) return;
    drained = true;
    started = false;
    safeCall(opts.onAllDone, items);
  }

  function pump() {
    if (started && !cancelled) {
      while (running < concurrency) {
        const next = items.find((item) => item.status === 'pending');
        if (!next) break;
        void runItem(next); // deliberately not awaited: this is the fan-out
      }
    }
    maybeAllDone();
  }

  async function runItem(item) {
    running++;
    item.status = 'running';
    item.error = undefined;
    safeCall(opts.onItemStart, item);

    let bitmap = null;
    try {
      // Cheap, early, and gives a far better message than the decoder would. Also tells us
      // which decode path this file takes (HEIC via WASM, or web format natively).
      const kind = await assertSupportedImage(item.file);
      if (isStopped(item)) throw new CancelledError();

      const decoded = await decodeItem(item.file, kind);
      bitmap = decoded.bitmap;
      item.width = decoded.width;
      item.height = decoded.height;
      if (isStopped(item)) throw new CancelledError(); // finally{} closes the bitmap

      // Thumbnail must be made HERE — from the full decoded bitmap, before encodeBitmap
      // consumes it. It derives a small bitmap and never retains the big one, so the cost
      // is ~one ~160px image, not a second full decode.
      if (wantThumbnails) {
        const url = await makeThumbnail(bitmap, thumbnailSize); // null on failure
        if (url) {
          if (isStopped(item)) URL.revokeObjectURL(url); // removed mid-flight — don't leak
          else {
            revokeThumbnail(item); // a retry may have left an old one
            item.thumbnail = url;
          }
        }
      }
      if (isStopped(item)) throw new CancelledError();

      // encodeBitmap CONSUMES the bitmap (closes it) on success and on throw alike, so
      // from here on it is not ours to free — drop the reference so finally{} won't
      // double-close it.
      const consumed = bitmap;
      bitmap = null;
      const blob = await encodeBitmap(consumed, {
        format,
        quality: opts.quality,
        maxDimension: opts.maxDimension,
      });

      if (isStopped(item)) throw new CancelledError(); // just drop the blob

      item.blob = blob;
      item.outputName = outputFilename(item.name, format);
      item.outputSize = blob.size;
      item.status = 'done';
      safeCall(opts.onItemDone, item);
    } catch (err) {
      if (err instanceof CancelledError || isStopped(item)) {
        item.status = 'cancelled';
      } else {
        item.status = 'error';
        item.error = err instanceof Error ? err : new Error(String(err));
        // Isolated on purpose: this item is done, the batch is not.
        safeCall(opts.onItemError, item, item.error);
      }
    } finally {
      // Only reached with a non-null bitmap if we bailed between decode and encode.
      if (bitmap && typeof bitmap.close === 'function') {
        try {
          bitmap.close();
        } catch (_) {
          /* already gone */
        }
      }
      running--;
      reportProgress();
      pump(); // backfill this lane
    }
  }

  const queue = {
    /**
     * @param {File} file
     * @returns {object} the created item
     */
    add(file) {
      const item = {
        id: nextItemId++,
        file,
        name: (file && file.name) || 'image.heic',
        status: 'pending',
        blob: undefined,
        outputName: undefined,
        error: undefined,
        width: undefined,
        height: undefined,
        thumbnail: undefined, // object URL string, only if createQueue({ thumbnails: true })
        inputSize: (file && file.size) || 0,
        outputSize: undefined,
      };
      items.push(item);
      // Adding to a queue that already drained re-opens it.
      if (started || drained) {
        drained = false;
        started = true;
        pump();
      }
      return item;
    },

    /** @param {Iterable<File>} files */
    addAll(files) {
      return Array.from(files || [], (file) => queue.add(file));
    },

    /** Begin (or resume) processing. Idempotent. */
    start() {
      cancelled = false;
      drained = false;
      started = true;
      pump();
    },

    /**
     * Cancel everything not already finished. Stops scheduling immediately; in-flight
     * items stop at their next checkpoint.
     */
    cancel() {
      cancelled = true;
      for (const item of items) {
        if (item.status === 'pending') item.status = 'cancelled';
        // 'running' items are left alone — runItem() sees `cancelled` and settles them.
      }
      reportProgress();
      maybeAllDone();
    },

    /** @param {number} id */
    cancelItem(id) {
      const item = items.find((i) => i.id === id);
      if (!item || isFinal(item.status)) return;
      // For a running item this is also the signal its runItem() checkpoints look for.
      item.status = 'cancelled';
      reportProgress();
      pump();
    },

    /** Requeue a failed/cancelled item. @param {number} id */
    retryItem(id) {
      const item = items.find((i) => i.id === id);
      if (!item || item.status === 'running' || item.status === 'pending') return;
      revokeThumbnail(item); // it'll be regenerated on the re-run; don't leak the old one
      item.status = 'pending';
      item.error = undefined;
      item.blob = undefined;
      item.outputName = undefined;
      item.outputSize = undefined;
      if (started || drained) {
        drained = false;
        started = true;
      }
      pump();
    },

    /** @param {number} id */
    remove(id) {
      const index = items.findIndex((i) => i.id === id);
      if (index === -1) return;
      const [item] = items.splice(index, 1);
      revokeThumbnail(item); // free its preview URL
      // If it's mid-flight, isStopped() now returns true for it (it's no longer in
      // `items`), so its runItem() will bail and release its bitmap at the next
      // checkpoint. We must not just forget about it.
      if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';
      reportProgress();
      pump();
    },

    /** Cancel everything and empty the queue. */
    clear() {
      queue.cancel();
      for (const item of items) revokeThumbnail(item); // no preview URL outlives the queue
      items.length = 0;
      started = false;
      drained = false;
      cancelled = false;
      reportProgress();
    },

    /**
     * Tear the queue down: cancel work and revoke every thumbnail URL. Call this (or
     * clear()) before dropping a queue you built with `thumbnails: true`, otherwise the
     * object URLs leak — the browser can't GC a blob URL you never revoked.
     */
    dispose() {
      queue.clear();
    },

    get items() {
      return items;
    },

    get stats() {
      const stats = {
        total: items.length,
        done: 0,
        errored: 0,
        pending: 0,
        running: 0,
        cancelled: 0,
        inputBytes: 0,
        outputBytes: 0,
      };
      for (const item of items) {
        if (item.status === 'done') stats.done++;
        else if (item.status === 'error') stats.errored++;
        else if (item.status === 'pending') stats.pending++;
        else if (item.status === 'running') stats.running++;
        else if (item.status === 'cancelled') stats.cancelled++;
        stats.inputBytes += item.inputSize || 0;
        stats.outputBytes += item.outputSize || 0;
      }
      return stats;
    },
  };

  return queue;
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * DOWNLOADING A BATCH — three tiers, best first
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSTRAINT (measured; see test/verify.encode.mjs and test/README.md)
 * Chrome breaks Blobs past its in-memory blob quota when blob disk-spill is unavailable.
 * We measured ~350 MB of live blob data reading back fine and ~500 MB failing with
 * NotReadableError — with plain `new Blob()` and no zip library anywhere, so it is the
 * browser's wall, not ours. Its position MOVES between sessions (500 MB failed
 * repeatably in one session; 750 MB passed in another), so it can't be tuned against.
 *
 * The trap: a broken Blob still LOOKS fine. `blob.size` is right and createObjectURL()
 * succeeds; it only fails when the bytes are read — i.e. at the user's download. So
 * anything that builds a zip in memory can hand back a corrupt download that looks
 * perfect right up until the user opens it.
 *
 * THE TIERS
 *   1. streamZipToDisk()  — File System Access API. The zip is piped straight to disk and
 *      never exists in memory, so zip size stops mattering entirely. MEASURED: 600 MB
 *      written with a 5.7 MB peak JS heap. Chromium only, and needs a user gesture.
 *   2. zipItemsChunked()  — several zips, each kept safely under the wall. For Safari and
 *      Firefox, or when the user dismisses the save picker.
 *   3. Individual downloads — the floor; always works. That's the UI's job, per item.
 *
 * WHAT STREAMING DOES *NOT* FIX — be honest about this
 * Streaming removes the zip's in-memory copy, which is the bigger half of the problem, but
 * the queue still holds every converted JPEG as a Blob so the UI can offer per-file
 * downloads. 200 full-size 12 MP photos is ~600 MB of output blobs that are live no matter
 * how we zip. Streaming roughly HALVES peak live bytes (sources + zip -> sources only),
 * which is what lifts 200 photos from "fails" to "works", but the source blobs themselves
 * remain the next ceiling. Beating that would mean not retaining output blobs at all
 * (spooling them to OPFS instead) — a bigger change than this layer, and not done here.
 */

/** 'a.jpg' seen twice -> 'a.jpg', then 'a (1).jpg'. Zip entries must be unique. */
function uniqueName(used, name) {
  if (!used.has(name)) {
    used.set(name, 1);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = used.get(name);
  let candidate;
  do {
    candidate = `${stem} (${n++})${ext}`;
  } while (used.has(candidate));
  used.set(name, n);
  used.set(candidate, 1);
  return candidate;
}

/** Default cap per zip in the chunked tier. ~100 MB: well under the ~350 MB we measured as
 *  safe, with room for the wall to move (it does) and for the source blobs alive beside it. */
const DEFAULT_MAX_BYTES_PER_ZIP = 100 * 1024 * 1024;

/** Gap between programmatic downloads in downloadBlobs(). See that function's notes. */
const DEFAULT_DOWNLOAD_GAP_MS = 1200;

const readyItems = (items) => (items || []).filter((i) => i && i.status === 'done' && i.blob);

function assertSomethingToZip(ready) {
  if (ready.length === 0) throw new Error('There are no converted images to put in a zip yet.');
}

/**
 * Build client-zip entries, de-duplicating names GLOBALLY across the whole batch (not
 * per-zip). Two zips could each legally hold their own `IMG_0000.jpg`, but users extract
 * all the parts into one folder and one would silently overwrite the other — so a name is
 * only ever used once across every part.
 */
function zipEntries(ready, used = new Map()) {
  return ready.map((item) => ({
    name: uniqueName(used, item.outputName || outputFilename(item.name, 'image/jpeg')),
    input: item.blob,
    // Preserve the original photo's timestamp where the File exposes one.
    lastModified: item.file && item.file.lastModified ? new Date(item.file.lastModified) : new Date(),
  }));
}

/** ~97 KB of JSZip used to live here; client-zip is ~6 KB and streams. Loaded on demand so
 *  a user who never downloads a zip never pays for it. */
const loadZipLib = () => import('../vendor/client-zip.js');

/** A TransformStream that counts bytes as they flow past, for progress. */
function byteMeter(onBytes) {
  return new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
}

/**
 * Is the streaming tier available? Chromium-only today (Safari and Firefox have no
 * showSaveFilePicker). Also false inside a cross-origin iframe, where the API is blocked.
 *
 * @returns {boolean}
 */
export function canStreamZip() {
  return (
    typeof window !== 'undefined' &&
    typeof window.showSaveFilePicker === 'function' &&
    typeof ReadableStream === 'function' &&
    typeof TransformStream === 'function'
  );
}

/**
 * Ask the user where to save. MUST be called from a user gesture (see streamZipToDisk).
 *
 * Exists so the UI can grab a handle inside a click handler and hand it to
 * streamZipToDisk() later — e.g. after showing a confirmation step.
 *
 * @param {string} [suggestedName='photos.zip']
 * @returns {Promise<FileSystemFileHandle|null>} null if the user cancelled.
 */
export async function pickZipDestination(suggestedName = 'photos.zip') {
  if (!canStreamZip()) throw new Error('This browser cannot save files directly to disk.');
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return null; // user dismissed — not an error
    throw err;
  }
}

/**
 * TIER 1 — stream a zip of every converted item straight to a file on disk.
 *
 * The zip never exists in memory: client-zip emits a ReadableStream and we pipe it into a
 * FileSystemWritableFileStream, so RAM stays flat regardless of size. MEASURED: 600 MB
 * written with a 5.7 MB peak JS heap.
 *
 * ── FOR THE UI: THE USER-GESTURE RULE ──────────────────────────────────────────────
 * showSaveFilePicker() only works during "transient user activation" — i.e. it must be
 * reached from a real click, and the activation is spent by the first `await`. So:
 *
 *   GOOD — call it directly from the click handler:
 *     button.addEventListener('click', () => streamZipToDisk(queue.items, { onProgress }));
 *
 *   ALSO GOOD — take the handle in the gesture, use it whenever:
 *     button.addEventListener('click', async () => {
 *       const fileHandle = await pickZipDestination('photos.zip');   // in the gesture
 *       if (!fileHandle) return;                                     // user cancelled
 *       await streamZipToDisk(queue.items, { fileHandle, onProgress });
 *     });
 *
 *   BAD — any await before it eats the activation and the call throws SecurityError:
 *     button.addEventListener('click', async () => {
 *       await somethingElse();              // <-- activation is gone
 *       await streamZipToDisk(items);       // <-- throws
 *     });
 *
 * This function calls the picker BEFORE its own first await, so calling it straight from a
 * click handler is safe. Check canStreamZip() first and fall back to zipItemsChunked().
 *
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {FileSystemFileHandle} [opts.fileHandle] Pre-obtained handle; skips the picker
 *   (and with it the gesture requirement).
 * @param {string} [opts.suggestedName='photos.zip']
 * @param {(percent: number) => void} [opts.onProgress] 0..100
 * @returns {Promise<{cancelled: boolean, bytesWritten: number, entryCount: number, filename: string|null}>}
 *   `cancelled: true` when the user dismissed the picker — that is a normal outcome, not
 *   an error, so it does not throw.
 */
export async function streamZipToDisk(items, opts = {}) {
  // Everything before the picker call must stay SYNCHRONOUS to preserve user activation.
  const ready = readyItems(items);
  assertSomethingToZip(ready);

  let handle = opts.fileHandle;
  if (!handle) {
    if (!canStreamZip()) {
      throw new Error('This browser cannot save files directly to disk. Try the zip download instead.');
    }
    // Not awaited via a helper on purpose: pickZipDestination() would be fine here too,
    // but calling the picker inline keeps it provably the first async thing we touch.
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: opts.suggestedName || 'photos.zip',
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { cancelled: true, bytesWritten: 0, entryCount: 0, filename: null };
      }
      throw err;
    }
  }

  const { makeZip, predictLength } = await loadZipLib();
  const entries = zipEntries(ready);

  // Exact final size, computed from metadata alone — no bytes read. Gives real percentages
  // instead of a guess.
  let predicted = 0;
  try {
    predicted = Number(predictLength(entries));
  } catch (_) {
    predicted = 0; // progress degrades to "unknown"; not worth failing the download over
  }

  let written = 0;
  const meter = byteMeter((n) => {
    written += n;
    if (predicted > 0) safeCall(opts.onProgress, Math.min(100, (written / predicted) * 100));
  });

  const writable = await handle.createWritable();
  try {
    // pipeTo() closes `writable` for us on success and applies backpressure, which is what
    // keeps memory flat: client-zip only reads the next photo once the disk has taken the
    // previous chunk.
    await makeZip(entries).pipeThrough(meter).pipeTo(writable);
  } catch (err) {
    // Don't leave a half-written .zip looking like a real one.
    try {
      await writable.abort();
    } catch (_) {
      /* already errored out */
    }
    throw err instanceof Error ? err : new Error(String(err || 'Writing the zip failed.'));
  }

  safeCall(opts.onProgress, 100);
  return {
    cancelled: false,
    bytesWritten: written,
    entryCount: entries.length,
    filename: handle.name || opts.suggestedName || 'photos.zip',
  };
}

/**
 * Split items into groups that each stay under `maxBytesPerZip`.
 *
 * Greedy and order-preserving, so `photos-1-of-3.zip` holds the first photos rather than
 * an arbitrary selection. An item bigger than the cap on its own still gets its own zip —
 * never dropped.
 *
 * @param {Array<object>} ready
 * @param {number} maxBytesPerZip
 * @returns {Array<Array<object>>}
 */
function planChunks(ready, maxBytesPerZip) {
  const groups = [];
  let current = [];
  let bytes = 0;

  for (const item of ready) {
    const size = item.outputSize || (item.blob && item.blob.size) || 0;
    if (current.length > 0 && bytes + size > maxBytesPerZip) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Preview how a batch would be split, without building anything. Cheap — lets the UI say
 * "this will download as 3 zips" before the user commits.
 *
 * @param {Array<object>} items
 * @param {number} [maxBytesPerZip]
 * @returns {Array<{filename: string, count: number, bytes: number}>}
 */
export function planChunkedZips(items, maxBytesPerZip = DEFAULT_MAX_BYTES_PER_ZIP) {
  const groups = planChunks(readyItems(items), maxBytesPerZip);
  return groups.map((group, i) => ({
    filename: chunkName('photos', i, groups.length),
    count: group.length,
    bytes: group.reduce((n, item) => n + (item.outputSize || 0), 0),
  }));
}

const chunkName = (base, index, total) =>
  total === 1 ? `${base}.zip` : `${base}-${index + 1}-of-${total}.zip`;

/**
 * TIER 2 — build several zips, each safely under the blob wall.
 *
 * For Safari/Firefox (no File System Access API) and for Chromium users who dismiss the
 * save picker.
 *
 * ── MEMORY: PASS onChunk FOR BIG BATCHES ───────────────────────────────────────────
 * Chunking alone does NOT fix memory if you keep every part: 6 x 100 MB retained is the
 * same 600 MB that broke us in the first place, just in more pieces. The win only lands if
 * each part is downloaded and released before the next is built.
 *
 * So: if `onChunk` is given, each part is handed over as it's made, awaited, and then
 * dropped (its `blob` is null in the returned array) — peak memory stays ~one part. If
 * `onChunk` is omitted, every part is retained and returned, which is fine for small
 * batches and dangerous for large ones.
 *
 *   // Big batch: download each part as it appears, keep memory flat.
 *   await zipItemsChunked(items, {
 *     onChunk: async ({ blob, filename }) => { await downloadBlobs([{ blob, filename }]); },
 *     onProgress: (p) => bar.set(p),
 *   });
 *
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {number} [opts.maxBytesPerZip=100MB]
 * @param {string} [opts.baseName='photos'] -> 'photos-1-of-3.zip'
 * @param {(percent: number) => void} [opts.onProgress] 0..100 across ALL parts
 * @param {(chunk) => Promise<void>|void} [opts.onChunk] Awaited per part; enables release.
 * @returns {Promise<Array<{blob: Blob|null, filename: string, count: number, bytes: number, index: number, total: number}>>}
 */
export async function zipItemsChunked(items, opts = {}) {
  const maxBytesPerZip = opts.maxBytesPerZip || DEFAULT_MAX_BYTES_PER_ZIP;
  const baseName = opts.baseName || 'photos';
  const ready = readyItems(items);
  assertSomethingToZip(ready);

  const { makeZip, predictLength } = await loadZipLib();

  const groups = planChunks(ready, maxBytesPerZip);
  // One shared name registry so names are unique across every part (see zipEntries).
  const used = new Map();
  const perGroupEntries = groups.map((group) => zipEntries(group, used));

  // Predict the total across all parts up front so progress is smooth and monotonic
  // rather than restarting per part.
  let predictedAll = 0;
  try {
    for (const entries of perGroupEntries) predictedAll += Number(predictLength(entries));
  } catch (_) {
    predictedAll = 0;
  }

  let writtenAll = 0;
  const results = [];

  for (let i = 0; i < groups.length; i++) {
    const entries = perGroupEntries[i];
    const meter = byteMeter((n) => {
      writtenAll += n;
      if (predictedAll > 0) safeCall(opts.onProgress, Math.min(100, (writtenAll / predictedAll) * 100));
    });

    // Response.blob() drains the stream into one Blob. Each part is capped, so this stays
    // under the wall — and the zip is built one part at a time, never all at once.
    const raw = await new Response(makeZip(entries).pipeThrough(meter)).blob();
    // .slice() re-types without copying the bytes (new Blob([raw]) would duplicate them).
    const blob = raw.slice(0, raw.size, 'application/zip');

    const chunk = {
      blob,
      filename: chunkName(baseName, i, groups.length),
      count: groups[i].length,
      bytes: blob.size,
      index: i,
      total: groups.length,
    };

    if (typeof opts.onChunk === 'function') {
      await opts.onChunk(chunk);
      results.push({ ...chunk, blob: null }); // released: caller has had its turn
    } else {
      results.push(chunk);
    }
  }

  safeCall(opts.onProgress, 100);
  return results;
}

/**
 * Trigger browser downloads for a list of `{ blob, filename }`, staggered.
 *
 * WHY THE STAGGER: browsers actively defend against download bombs. Chrome permits the
 * first programmatic download freely and then prompts ("Download multiple files?") or
 * silently drops rapid subsequent ones; Safari is stricter still. Firing N anchor clicks
 * in a tight loop reliably loses files. A gap between them, all still within the original
 * click's activation, gets them through. This is best-effort, not a guarantee — a user who
 * denies the multiple-downloads permission will only get the first file, and no JS can
 * override that. If you need certainty for a big batch, prefer streamZipToDisk(), or drive
 * one part per click.
 *
 * We also delay revokeObjectURL: revoking immediately can cancel an in-flight download.
 *
 * Optional UI convenience — the only DOM-touching function in this module. Safe to ignore
 * and roll your own.
 *
 * @param {Array<{blob: Blob, filename: string}>} files
 * @param {object} [opts]
 * @param {number} [opts.delayMs=1200] Gap between downloads.
 * @param {(file, index: number) => void} [opts.onEach]
 * @returns {Promise<number>} how many downloads were triggered
 */
export async function downloadBlobs(files, opts = {}) {
  if (typeof document === 'undefined') {
    throw new Error('Downloads can only be triggered from a page.');
  }
  const list = (files || []).filter((f) => f && f.blob);
  const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : DEFAULT_DOWNLOAD_GAP_MS;

  let triggered = 0;
  for (let i = 0; i < list.length; i++) {
    const { blob, filename } = list[i];
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'download.zip';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Long enough for the download to actually start; short enough not to leak forever.
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    triggered++;
    safeCall(opts.onEach, list[i], i);
    if (i < list.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return triggered;
}

/**
 * Bundle every successfully converted item into ONE zip Blob, in memory.
 *
 * Kept for small batches and for callers that genuinely need a Blob. For anything large
 * prefer streamZipToDisk(), or zipItemsChunked() where streaming isn't available: this
 * holds the whole zip in memory beside the source blobs, which is exactly the ~350 MB
 * ceiling documented at the top of this section. It does not throw when it exceeds that —
 * the browser hands back a Blob that only fails when read.
 *
 * @param {Array<object>} items
 * @param {(percent: number) => void} [onProgress] 0..100
 * @returns {Promise<Blob>} an application/zip Blob
 */
export async function zipItems(items, onProgress) {
  const ready = readyItems(items);
  assertSomethingToZip(ready);

  const { makeZip, predictLength } = await loadZipLib();
  const entries = zipEntries(ready);

  let predicted = 0;
  try {
    predicted = Number(predictLength(entries));
  } catch (_) {
    predicted = 0;
  }

  let written = 0;
  const meter = byteMeter((n) => {
    written += n;
    if (predicted > 0) safeCall(onProgress, Math.min(100, (written / predicted) * 100));
  });

  const raw = await new Response(makeZip(entries).pipeThrough(meter)).blob();
  safeCall(onProgress, 100);
  // Re-type without copying the bytes.
  return raw.slice(0, raw.size, 'application/zip');
}
