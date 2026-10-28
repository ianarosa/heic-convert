/**
 * encode.js — turns a decoded ImageBitmap into an output image Blob. 100% client-side.
 *
 * PUBLIC API
 *   encodeBitmap(bitmap, opts) -> Promise<Blob>       (image/jpeg|png|webp OR application/pdf)
 *   outputFilename(inputName, format) -> string
 *   combineFilesToPdf(files, opts) -> Promise<{ blob, pageCount, skipped }>
 *
 * ── BITMAP OWNERSHIP (important) ────────────────────────────────────────────────────
 * `encodeBitmap()` CONSUMES the bitmap you hand it: it calls `bitmap.close()` before
 * returning, on BOTH the success and the failure path (it's in a `finally`). After the
 * call the bitmap is dead — do not draw it again.
 *
 * Why consume rather than leave it to the caller: ImageBitmaps hold decoded pixels
 * (a 4032x3024 iPhone photo is ~48 MB of RGBA) and, unlike Blobs, they are NOT backed by
 * disk and are NOT reliably collected by GC — they pin memory until closed. In a 200-file
 * batch, one missed `close()` on an error path is enough to OOM the tab. Making the
 * consumer responsible for the release means there is exactly one owner and one place the
 * release can be forgotten, instead of one per caller. queue.js therefore never closes
 * bitmaps itself on the happy path — it hands them to encodeBitmap and forgets them.
 *
 * If you need the bitmap afterwards (e.g. to also paint a UI thumbnail), pass
 * `keepBitmap: true` and you become responsible for closing it.
 *
 * ── OFF-MAIN-THREAD ─────────────────────────────────────────────────────────────────
 * The per-bitmap encode path only touches OffscreenCanvas when it can, and never touches
 * `document` unless OffscreenCanvas is missing, so encodeBitmap() is safe inside a Worker.
 * combineFilesToPdf() drives the decoder and is intended for the main thread.
 *
 * ── decode.js IS A LAZY DEPENDENCY ──────────────────────────────────────────────────
 * Only combineFilesToPdf() needs the decoder, and it pulls it in with a dynamic import at
 * the point of use — NOT a static top-level import. That keeps decode.js out of the module
 * graph of encodeBitmap-only consumers (e.g. the /compress/ tool, which never decodes
 * HEIC). encodeBitmap() itself never imports or calls the decoder.
 */

/** Output format -> file extension. Also the allow-list of formats we accept. */
const EXT_BY_FORMAT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'image/svg+xml': 'svg',
};

/** Formats that carry an alpha channel. JPEG notably does not. PDF wraps a JPEG, so no.
 *  SVG tracing works on the raw RGBA (transparent regions trace as their own paths), so we
 *  draw it on a transparent canvas — no white matte. */
const SUPPORTS_ALPHA = {
  'image/jpeg': false,
  'image/png': true,
  'image/webp': true,
  'application/pdf': false,
  'image/svg+xml': true,
};

/**
 * Safety cap for the SVG trace INPUT. Tracing scales badly with pixel count — a full 12 MP
 * photo is slow and produces a many-megabyte SVG. We never trace beyond this longest-side
 * size; a user-set resize below it wins. (SVG is vector, so a capped trace still scales to
 * any display size — the cap only bounds how much raster detail we try to follow.)
 */
const TRACE_MAX_DIM = 2000;

const DEFAULT_QUALITY = 0.85;

/** ~523 KB of pdf-lib, loaded on demand so callers who never export a PDF never pay it. */
const loadPdfLib = () => import('../vendor/pdf-lib.js');

/** JPEG has no alpha; transparent pixels composite to BLACK unless we lay down a matte. */
const JPEG_MATTE = '#ffffff';

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return DEFAULT_QUALITY;
  return Math.min(1, Math.max(0, n));
}

/**
 * Prefer OffscreenCanvas (works on a worker thread, no DOM). Fall back to a detached
 * <canvas> only when we're on the main thread and OffscreenCanvas is unavailable.
 */
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('This browser has no canvas available to encode images with.');
}

/** OffscreenCanvas.convertToBlob() / HTMLCanvasElement.toBlob(), normalised to a Promise. */
async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    // `quality` is ignored by the PNG encoder; pass it only when it means something.
    return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
  }
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The browser failed to produce an image.'))),
        type,
        quality
      );
    });
  }
  throw new Error('This browser cannot turn a canvas into an image file.');
}

/**
 * Longest-side-capped target size, preserving aspect ratio. Never upscales, never
 * returns a zero dimension.
 */
function targetSize(width, height, maxDimension) {
  if (!maxDimension || typeof maxDimension !== 'number' || maxDimension <= 0) {
    return { width, height };
  }
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height }; // don't upscale
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Ask the browser for a resampled bitmap. Chrome/Safari implement `resizeQuality: 'high'`
 * with a proper multi-tap filter (Skia's mipmap/Lanczos-ish path), which is both better
 * and faster than anything we can do in JS. Returns null if the browser won't do it, so
 * the caller can fall back.
 */
async function tryResizeBitmap(bitmap, width, height) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    // Some engines silently ignore the resize hints. If we didn't get what we asked for,
    // throw it away rather than drawing it at the wrong size.
    if (resized.width !== width || resized.height !== height) {
      resized.close();
      return null;
    }
    return resized;
  } catch (_) {
    return null;
  }
}

/**
 * Draw `bitmap` into `ctx` at exactly targetW x targetH.
 *
 * A single naive drawImage() from 4032px down to 800px point-samples and aliases badly
 * (moiré on brick/fabric, crunchy edges) because the filter only reads a 2x2 neighbourhood
 * regardless of how far you're shrinking. Two ways out, best first:
 *   1. createImageBitmap()'s resizeQuality:'high' — a real downsample filter.
 *   2. Stepped halving — repeatedly halve the image (each halving averages a 2x2 block,
 *      so no source pixel is ever skipped) until we're within 2x of the target, then do
 *      the last, small step. This is the classic canvas workaround.
 */
async function drawScaled(ctx, bitmap, sourceW, sourceH, targetW, targetH) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (sourceW === targetW && sourceH === targetH) {
    ctx.drawImage(bitmap, 0, 0);
    return;
  }

  const resized = await tryResizeBitmap(bitmap, targetW, targetH);
  if (resized) {
    ctx.drawImage(resized, 0, 0);
    resized.close(); // intermediate we created — always ours to free
    return;
  }

  // Fallback: stepped halving.
  let source = bitmap;
  let currentW = sourceW;
  let currentH = sourceH;

  while (currentW > targetW * 2 && currentH > targetH * 2) {
    const nextW = Math.max(targetW, Math.round(currentW / 2));
    const nextH = Math.max(targetH, Math.round(currentH / 2));
    const step = makeCanvas(nextW, nextH);
    const stepCtx = step.getContext('2d');
    stepCtx.imageSmoothingEnabled = true;
    stepCtx.imageSmoothingQuality = 'high';
    stepCtx.drawImage(source, 0, 0, currentW, currentH, 0, 0, nextW, nextH);
    source = step; // previous intermediate canvas is now garbage; GC handles canvases
    currentW = nextW;
    currentH = nextH;
  }

  ctx.drawImage(source, 0, 0, currentW, currentH, 0, 0, targetW, targetH);
}

/**
 * Draw a bitmap to a canvas at the maxDimension-capped size and encode it to a raster Blob
 * (jpeg/png/webp). Does NOT close the bitmap — the caller owns that.
 *
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
async function encodeRaster(bitmap, format, opts) {
  const { width, height } = targetSize(bitmap.width, bitmap.height, opts.maxDimension);
  const canvas = makeCanvas(width, height);

  // alpha:false lets the compositor skip the alpha channel entirely for JPEG. The
  // context then starts out opaque black, which is exactly the bug we're about to
  // paper over with the white matte below.
  const ctx = canvas.getContext('2d', { alpha: SUPPORTS_ALPHA[format] });
  if (!ctx) throw new Error('This browser refused to give us a 2D canvas to draw on.');

  if (!SUPPORTS_ALPHA[format]) {
    // JPEG has no alpha channel. Without this matte, anything transparent in the source
    // (HEICs genuinely can carry alpha — Apple stores it as an aux image) encodes as
    // black. Lay down white FIRST, then composite the image over it with source-over.
    ctx.fillStyle = JPEG_MATTE;
    ctx.fillRect(0, 0, width, height);
  }

  await drawScaled(ctx, bitmap, bitmap.width, bitmap.height, width, height);

  const quality = format === 'image/png' ? undefined : clamp01(opts.quality);
  const blob = await canvasToBlob(canvas, format, quality);

  if (!blob || blob.size === 0) {
    throw new Error('The browser produced an empty image file.');
  }
  // canvas.toBlob()/convertToBlob() silently fall back to PNG for a format the browser
  // can't encode (this is spec'd behaviour, not a bug). Catch it rather than handing
  // back a PNG named .webp.
  if (blob.type && blob.type !== format) {
    throw new Error(
      `This browser can't save ${EXT_BY_FORMAT[format].toUpperCase()} files. Try JPEG instead.`
    );
  }

  return { blob, width, height };
}

/**
 * Embed one JPEG into a fresh single-page PDF and return the PDF Blob.
 *
 * The page is sized to the JPEG's pixel dimensions mapped 1px -> 1pt, which is 72 dpi (PDF
 * user-space units ARE points, and 72 pt = 1 inch), so a 3024x4032 photo becomes a
 * 3024x4032-point page and the image fills it exactly with no scaling artefacts.
 *
 * @param {Uint8Array} jpegBytes
 * @param {number} width  pixel width of the JPEG
 * @param {number} height pixel height of the JPEG
 * @returns {Promise<Blob>}
 */
async function jpegToPdfBlob(jpegBytes, width, height) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(jpegBytes);
  const page = doc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  const bytes = await doc.save(); // Uint8Array
  return new Blob([bytes], { type: 'application/pdf' });
}

/**
 * Trace a decoded bitmap into a real vector SVG (genuine `<path>` shapes, not a raster
 * wrapped in `<image>`).
 *
 * Pipeline: cap the longest side (user resize if set, else TRACE_MAX_DIM) → draw to a
 * transparent canvas → getImageData → ImageTracer.imagedataToSVG → wrap the string in a
 * Blob. Does NOT close the bitmap; encodeBitmap's `finally` owns that, exactly like
 * encodeRaster.
 *
 * ── LAZY DEPENDENCY ── ImageTracer (~47 KB of pure JS, NO WASM) is dynamically imported
 * HERE, at the point of use, so it is fetched only when SVG output is actually produced. A
 * page load, or any conversion whose output isn't SVG, never pulls it in.
 *
 * @returns {Promise<Blob>} an image/svg+xml Blob
 */
async function traceToSvg(bitmap, opts) {
  // Resize FIRST — tracing a full-res photo is slow and produces a giant SVG. Always cap the
  // trace input: a user resize below TRACE_MAX_DIM wins, otherwise TRACE_MAX_DIM applies.
  const requested = opts.maxDimension && opts.maxDimension > 0 ? opts.maxDimension : Infinity;
  const cap = Math.min(requested, TRACE_MAX_DIM);
  const { width, height } = targetSize(bitmap.width, bitmap.height, cap);

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('This browser refused to give us a 2D canvas to trace on.');
  await drawScaled(ctx, bitmap, bitmap.width, bitmap.height, width, height);
  const imagedata = ctx.getImageData(0, 0, width, height);

  const ImageTracer = (await import('../vendor/imagetracer.js')).default;
  const svg = ImageTracer.imagedataToSVG(imagedata, svgTraceOptions(opts.quality));
  if (!svg || svg.indexOf('<svg') === -1) {
    throw new Error('Tracing produced no SVG output.');
  }
  return new Blob([svg], { type: 'image/svg+xml' });
}

/**
 * Tracing options tuned for flat graphics (logos, icons, UI). The quality slider maps to
 * colour count: higher quality follows more colours and detail (a closer, larger trace),
 * lower quality posterises harder (fewer colours, smaller file). `roundcoords` and `pathomit`
 * keep the output small and clean; `viewbox` makes the SVG scale to any size.
 */
function svgTraceOptions(quality) {
  const q = typeof quality === 'number' && quality > 0 ? quality : DEFAULT_QUALITY;
  const numberofcolors = Math.max(2, Math.min(64, Math.round(q * 32)));
  return {
    numberofcolors,
    colorsampling: 2,
    mincolorratio: 0,
    colorquantcycles: 3,
    pathomit: 8, // drop tiny speckle paths — cleaner and smaller
    ltres: 1, // straight-line fit tolerance
    qtres: 1, // curve fit tolerance
    rightangleenhance: true,
    blurradius: 0,
    roundcoords: 1, // 1 decimal place — much smaller output, no visible loss on flat art
    linefilter: false,
    strokewidth: 1,
    scale: 1,
    viewbox: true, // scalable; no fixed px width/height baked in
    desc: false, // no per-path description attributes
  };
}

/**
 * Encode a decoded bitmap to an output Blob.
 *
 * Formats: image/jpeg, image/png, image/webp, application/pdf (a one-page PDF with the
 * photo embedded as a JPEG — PDF is therefore LOSSY and `quality` applies to that JPEG),
 * and image/svg+xml (a real vector trace via ImageTracer — see traceToSvg).
 *
 * CONSUMES `bitmap` (closes it) unless `opts.keepBitmap` is true — see the ownership note
 * at the top of this file. This holds for the PDF path too.
 *
 * @param {ImageBitmap} bitmap
 * @param {object} opts
 * @param {'image/jpeg'|'image/png'|'image/webp'|'application/pdf'|'image/svg+xml'} opts.format
 * @param {number} [opts.quality=0.85] 0..1. Ignored for image/png. Applies to the JPEG
 *   inside a PDF.
 * @param {number} [opts.maxDimension] Cap on the longest side. Scales down only.
 * @param {boolean} [opts.keepBitmap=false] Don't close the input bitmap.
 * @returns {Promise<Blob>}
 * @throws {Error} with a human-readable `.message`.
 */
export async function encodeBitmap(bitmap, opts = {}) {
  const format = opts.format || 'image/jpeg';
  const keepBitmap = opts.keepBitmap === true;

  try {
    if (!EXT_BY_FORMAT[format]) {
      throw new Error(`"${format}" isn't an output format this app can write.`);
    }
    if (!bitmap || typeof bitmap.width !== 'number' || typeof bitmap.height !== 'number') {
      throw new Error('No decoded image was provided to encode.');
    }
    if (bitmap.width < 1 || bitmap.height < 1) {
      // A closed ImageBitmap reports 0x0 — this is the usual symptom of a double-encode.
      throw new Error('The decoded image is empty (it may have already been used).');
    }

    if (format === 'application/pdf') {
      // A PDF page is a JPEG in a wrapper: rasterise to JPEG first (honouring quality +
      // maxDimension), then embed at the JPEG's real size.
      const { blob, width, height } = await encodeRaster(bitmap, 'image/jpeg', opts);
      const jpegBytes = new Uint8Array(await blob.arrayBuffer());
      return await jpegToPdfBlob(jpegBytes, width, height);
    }

    if (format === 'image/svg+xml') {
      // Vector trace — a different pipeline from canvas.toBlob (SVG isn't a canvas format).
      return await traceToSvg(bitmap, opts);
    }

    const { blob } = await encodeRaster(bitmap, format, opts);
    return blob;
  } finally {
    // Runs on success AND on every throw above — the one place the bitmap is released.
    if (!keepBitmap && bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch (_) {
        /* already closed — nothing to do */
      }
    }
  }
}

/**
 * Derive the output filename from the input filename.
 *
 *   ('IMG_1234.HEIC', 'image/jpeg')  -> 'IMG_1234.jpg'
 *   ('IMG.1234.heic', 'image/png')   -> 'IMG.1234.png'   (only the LAST extension goes)
 *   ('no-extension',  'image/jpeg')  -> 'no-extension.jpg'
 *   ('.hidden',       'image/jpeg')  -> '.hidden.jpg'     (leading dot isn't an extension)
 *   ('a/b/IMG.HEIC',  'image/jpeg')  -> 'IMG.jpg'         (folder drops give paths)
 *
 * Path components are stripped and separators/control characters are scrubbed: these names
 * become zip entry names, and a name like `../x.jpg` is a zip-slip vector for whatever
 * unpacks it.
 *
 * @param {string} inputName
 * @param {'image/jpeg'|'image/png'|'image/webp'|'application/pdf'|'image/svg+xml'} format
 * @returns {string}
 */
export function outputFilename(inputName, format) {
  const ext = EXT_BY_FORMAT[format] || 'jpg';

  let name = typeof inputName === 'string' ? inputName : '';
  // Take the basename: File.webkitRelativePath and drag-and-drop of folders both yield
  // names with separators in them.
  name = name.split(/[/\\]/).pop() || '';
  // Strip control chars and characters that are illegal in Windows filenames, so the zip
  // unpacks cleanly everywhere.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();
  // '.' and '..' are not usable names.
  if (name === '.' || name === '..') name = '';
  if (!name) name = 'image';

  // Drop the final extension, but only if there is a real one: a dot at index 0 is a
  // "hidden file" marker, not an extension separator.
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;

  return `${stem}.${ext}`;
}

/**
 * Combine many HEIC files into ONE multi-page PDF, one photo per page, in file order.
 *
 * This is the highest-intent "heic to pdf" flow: the user wants a single document, not N
 * files. The UI passes the queue's source Files, in order.
 *
 * ── MEMORY ──────────────────────────────────────────────────────────────────────────
 * Same discipline as the queue: decode -> embed as JPEG -> RELEASE the bitmap, one file at
 * a time. At most one decoded ImageBitmap is ever alive, so 200 12 MP photos do NOT mean
 * 200 x ~48 MB of pixels. What DOES accumulate is the pdf-lib document: each page holds its
 * embedded JPEG (compressed, ~the JPEG's size, not raw pixels), and doc.save() then
 * serialises the whole thing into one byte array before the Blob exists. That in-memory
 * assembly is the real ceiling — measured in test/verify.pdf.mjs; see test/README.md for
 * the honest number. There is no streaming-PDF option the way there is for zip.
 *
 * ── FAILURE ISOLATION ───────────────────────────────────────────────────────────────
 * A corrupt / non-decodable file is SKIPPED (its page is omitted) and recorded in the
 * returned `skipped` array — it does not abort the document. If EVERY file fails, that's
 * an error (there is no such thing as a zero-page PDF worth handing back).
 *
 * @param {Array<File|Blob>} files  original HEIC files, in the order pages should appear.
 * @param {object} [opts]
 * @param {number} [opts.quality=0.85] JPEG quality for every embedded page. 0..1.
 * @param {number} [opts.maxDimension] Cap each page image's longest side. Scales down only.
 * @param {(done: number, total: number) => void} [opts.onProgress] Fires after each file is
 *   handled (whether it produced a page or was skipped), so done reaches total exactly.
 * @returns {Promise<{ blob: Blob, pageCount: number, skipped: Array<{ index: number, name: string, error: string }> }>}
 * @throws {Error} on empty input, or if not a single file could be added.
 */
export async function combineFilesToPdf(files, opts = {}) {
  const list = Array.from(files || []);
  if (list.length === 0) {
    throw new Error('There are no files to put in a PDF.');
  }

  // Lazy: only this function needs the decoder, so it stays out of the module graph of
  // encodeBitmap-only consumers (e.g. the /compress/ tool). Both imports run concurrently.
  const [{ PDFDocument }, { decodeHeic }] = await Promise.all([loadPdfLib(), import('./decode.js')]);
  const doc = await PDFDocument.create();

  const skipped = [];
  let pageCount = 0;

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const name = (file && file.name) || `image-${i + 1}.heic`;
    let bitmap = null;
    try {
      const decoded = await decodeHeic(file);
      bitmap = decoded.bitmap;
      // Rasterise to JPEG (honours quality + maxDimension). encodeRaster does NOT close the
      // bitmap, so we own the release below.
      const { blob, width, height } = await encodeRaster(bitmap, 'image/jpeg', opts);
      const jpegBytes = new Uint8Array(await blob.arrayBuffer());
      const image = await doc.embedJpg(jpegBytes);
      doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      pageCount++;
    } catch (err) {
      // One bad photo must not sink the whole document.
      skipped.push({ index: i, name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        try {
          bitmap.close(); // release BEFORE the next decode — never hold N bitmaps
        } catch (_) {
          /* already closed */
        }
      }
      if (typeof opts.onProgress === 'function') {
        try {
          opts.onProgress(i + 1, list.length);
        } catch (_) {
          /* a UI callback throwing is not our problem to die over */
        }
      }
    }
  }

  if (pageCount === 0) {
    throw new Error('None of the files could be added to the PDF — they may all be corrupt or unsupported.');
  }

  const bytes = await doc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  return { blob, pageCount, skipped };
}
