/**
 * decode.worker.js — WASM HEIC decode worker (module worker).
 *
 * Owned by decode.js; do not instantiate directly. Protocol:
 *   main -> worker : { type: 'init',   id }
 *                    { type: 'decode', id, buffer }   // buffer is a transferred ArrayBuffer
 *   worker -> main : { type: 'ready',  id }
 *                    { type: 'result', id, bitmap, width, height }   // bitmap transferred
 *                    { type: 'error',  id, message }
 *
 * This is a MODULE worker (`new Worker(url, { type: 'module' })`) because the vendored
 * libheif build is an ES module. Requires Chrome 80+ / Safari 15+ / Firefox 114+.
 *
 * The vendored bundle inlines the .wasm as a base64 data URI, so there is no extra
 * fetch and no SharedArrayBuffer / COOP / COEP requirement. See vendor/README.md.
 */

import libheifFactory from '../vendor/libheif-bundle.mjs';

/** @type {Promise<any> | null} Cached libheif module instance (wasm compiled once per worker). */
let modulePromise = null;

/**
 * The Emscripten factory compiles the inlined wasm with a SYNCHRONOUS
 * `new WebAssembly.Module(...)` and returns the ready-to-use module object directly —
 * it is NOT a promise, so it cannot be `.catch()`ed or `.then()`ed.
 *
 * Two consequences worth knowing:
 *  1. We wrap the call in an async IIFE to normalise it into a promise.
 *  2. Synchronous compilation of a >4KB wasm module is only permitted OFF the main
 *     thread. That is a hard reason this must live in a worker: calling the factory on
 *     the main thread would throw in Chrome.
 */
function getModule() {
  if (!modulePromise) {
    modulePromise = (async () => libheifFactory())().catch((err) => {
      modulePromise = null; // allow a retry on a later message
      throw err;
    });
  }
  return modulePromise;
}

function friendlyParseError(message) {
  const m = String(message || '');
  if (/ftyp/i.test(m)) return 'This file is not a HEIC image.';
  if (/Unsupported/i.test(m)) return 'This HEIC file uses a feature that is not supported.';
  return 'This HEIC file could not be read (' + m.trim() + ').';
}

/**
 * Decode the PRIMARY image of a HEIC container and post it back as an ImageBitmap.
 *
 * We drive the low-level libheif C API rather than the friendlier `HeifDecoder` wrapper
 * for two reasons:
 *   1. `HeifDecoder.prototype.decode()` swallows parse errors, console.logs them, and
 *      returns [] — we need the real error text to build a useful message.
 *   2. It returns images in top-level-item order, which is not necessarily the primary
 *      image for multi-image containers (Live Photos, bursts). `is_primary()` can't help:
 *      it is broken in libheif-js 1.19.8 (calls a bare global
 *      `heif_image_handle_is_primary_image` instead of `Module.…`, so it always throws).
 * `heif_js_context_get_primary_image_handle()` gives us the primary directly.
 */
async function decodeMessage(id, buffer) {
  const mod = await getModule();
  const bytes = new Uint8Array(buffer);

  const ctx = mod.heif_context_alloc();
  if (!ctx) throw new Error('Could not initialise the HEIC decoder.');

  let image = null;
  try {
    const err = mod.heif_context_read_from_memory(ctx, bytes);
    if (err && err.code !== mod.heif_error_code.heif_error_Ok) {
      throw new Error(friendlyParseError(err.message));
    }

    const handle = mod.heif_js_context_get_primary_image_handle(ctx);
    if (!handle || handle.code) throw new Error('This HEIC file has no readable primary image.');

    image = new mod.HeifImage(handle);
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0) || !(height > 0)) throw new Error('This HEIC file reports an invalid image size.');

    // ORIENTATION: libheif applies the container's rotation/mirror transform properties
    // (irot/imir) during decode — that is how iPhone HEICs actually store orientation, so
    // those come out upright with no work from us. A standalone EXIF orientation tag is
    // NOT applied: this build does not expose the metadata accessors in a usable form
    // (the heif_js_* metadata helpers are absent, and the raw
    // heif_image_handle_get_metadata* functions are pointer-based with no embind
    // wrapper). Documented rather than rabbit-holed; see the report/caveats.
    const imageData = new ImageData(width, height);
    await new Promise((resolve, reject) => {
      // display() converts YCbCr -> RGBA into imageData and calls back with it, or with
      // a falsy value if the underlying decode failed (e.g. a truncated file).
      image.display(imageData, (displayData) => {
        if (!displayData) reject(new Error('This HEIC file appears to be corrupt or truncated.'));
        else resolve();
      });
    });

    const bitmap = await createImageBitmap(imageData);
    self.postMessage({ type: 'result', id, bitmap, width, height }, [bitmap]);
  } finally {
    if (image && typeof image.free === 'function') {
      try { image.free(); } catch (_) { /* best effort */ }
    }
    mod.heif_context_free(ctx);
  }
}

self.addEventListener('message', async (event) => {
  const { type, id, buffer } = event.data || {};

  try {
    if (type === 'init') {
      await getModule();
      self.postMessage({ type: 'ready', id });
      return;
    }

    if (type === 'decode') {
      await decodeMessage(id, buffer);
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      message: (err && err.message) || 'HEIC decoding failed.',
    });
  }
});
