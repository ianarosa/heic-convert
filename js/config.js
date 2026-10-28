/**
 * config.js — every knob and string that an owner might want to change, in one file.
 *
 * Nothing here touches the DOM or imports anything. Landing pages built later should
 * import from here rather than re-declaring defaults.
 */

/* ── Site identity ──────────────────────────────────────────────────────────────────
 *
 * SITE.origin is the SINGLE source of truth for the canonical domain *in JavaScript*.
 *
 * HTML <head> tags cannot read this file before a crawler parses them, so index.html
 * carries its own copy of the origin inside one clearly-marked block:
 *
 *     <!-- ==== SITE ORIGIN ==== -->  ...  <!-- ==== /SITE ORIGIN ==== -->
 *
 * Moving to a new domain means editing exactly two places: that block, and SITE.origin
 * here. There is no third. (A build step could collapse them into one — this project
 * deliberately has no build step.)
 */
export const SITE = {
  origin: 'https://heic.kostelinha.com',
  name: 'Safelight',
  tagline: 'HEIC to JPG, in your browser only.',
};

/**
 * Build marker. Bump it when shipping.
 *
 * Exists because a stale cached copy of js/main.js is indistinguishable from a code bug
 * from the outside, and telling the two apart cost us multiple rounds once already.
 * Check it in the browser console:  __app.version
 * If that doesn't match this file, the browser is running an old build — hard-reload
 * (Ctrl+Shift+R), or open DevTools > Network > Disable cache.
 */
export const VERSION = '2026-07-16.svg-output';

/* ── Conversion defaults ──────────────────────────────────────────────────────────── */

/** Output formats offered in the UI, in display order. */
/**
 * Output formats offered in the UI, in display order.
 *
 * `typicalRatio` = output size as a share of the HEIC input, at quality 0.85.
 * These are MEASURED, not estimated — test/verify.ui.mjs re-measures them on every run
 * and fails if the page's claims drift away from what the browser actually produces.
 * Measured in Chrome on test/sample.heic (1440x960, 287 KB): JPG 168%, WebP 155%,
 * PNG 1186%. The JPG figure matches the ~168% average reported for real iPhone photos.
 *
 * Note WebP is only ~8% smaller than JPG here. The common claim that WebP is far more
 * efficient holds for encoders like cwebp; the browser's canvas WebP encoder, at a
 * matched quality number, is not that. Don't promise users more than this delivers.
 */
/**
 * `hint` is the line shown under the "Save as" control for the chosen OUTPUT. Since the
 * converter is now universal (HEIC, JPG, PNG or WebP in), the hints are written about the
 * output format itself — its honest trade — rather than a size ratio against one specific
 * input, which would be wrong for a PNG→JPG or JPG→WebP conversion.
 */
export const FORMATS = [
  {
    id: 'image/jpeg',
    label: 'JPG',
    hint: 'Opens anywhere. Lossy, and flattens any transparency to white.',
    typicalRatio: 1.68,
  },
  {
    id: 'image/webp',
    label: 'WebP',
    hint: 'Usually the smallest at a given quality. Modern software only.',
    typicalRatio: 1.55,
  },
  {
    id: 'image/png',
    label: 'PNG',
    hint: 'Lossless and keeps transparency. Large for photos — best for graphics.',
    typicalRatio: 11.86,
  },
  {
    id: 'application/pdf',
    label: 'PDF',
    hint: 'One image per page. Opens anywhere. Wraps a lossy JPEG.',
    // A PDF wraps a JPEG at the same quality, so it tracks JPG plus a small container.
    typicalRatio: 1.72,
  },
  {
    id: 'image/svg+xml',
    label: 'SVG',
    // The honest, up-front photo warning lives right here, on the format hint.
    hint: 'Traces your image into real vector shapes. Best for logos & flat graphics — photos come out large and blurry.',
    // Tracing size depends entirely on the picture (a logo is tiny, a photo is huge), so a
    // single ratio would be a lie. No typicalRatio.
  },
];

export const DEFAULTS = {
  format: 'image/jpeg',
  quality: 0.85,
  /** 0 = keep original dimensions. Otherwise a cap on the longest side, in pixels. */
  maxDimension: 0,
};

/** Offered in the resize control. 0 is "don't resize". */
export const RESIZE_OPTIONS = [
  { value: 0, label: 'Original size' },
  { value: 4032, label: '4032 px' },
  { value: 2560, label: '2560 px' },
  { value: 1920, label: '1920 px' },
  { value: 1280, label: '1280 px' },
  { value: 800, label: '800 px' },
];

export const QUALITY = { min: 0.4, max: 1, step: 0.01 };

/* ── Limits ─────────────────────────────────────────────────────────────────────────
 *
 * ZIP_SAFE_OUTPUT_BYTES is not a guess. test/verify.encode.mjs measures Chrome breaking
 * Blobs past its in-memory blob quota (~500 MB), and zipItems() must hold the source
 * blobs AND the finished zip alive at once — so its usable budget is about half the wall.
 * Past this we steer the user to per-file downloads or a streamed/chunked zip.
 */
export const LIMITS = {
  zipSafeOutputBytes: 150 * 1024 * 1024,
  /** Above this many files the queue list gets a fixed height and windowed rendering. */
  virtualizeAbove: 24,
  /** Rows kept in the DOM outside the viewport, above and below. */
  overscanRows: 6,
};

/* ── Storage ────────────────────────────────────────────────────────────────────────
 * Settings only. No file data, no history, no identifiers — there is nothing here worth
 * exfiltrating, which is the point.
 */
export const STORAGE_KEY = 'safelight.settings.v1';

/* ── Ad slots ───────────────────────────────────────────────────────────────────────
 *
 * OWNER: paste your AdSense publisher ID into AD_CLIENT below, then add the AdSense
 * script tag to index.html and an <ins class="adsbygoogle"> inside each container.
 * Leaving AD_CLIENT null keeps the containers reserved but empty.
 *
 * Each container already reserves its height in css/app.css (`--ad-h-*`), so filling a
 * slot later shifts nothing and cannot hurt CLS.
 */
export const AD_CLIENT = null; // e.g. 'ca-pub-0000000000000000'

export const AD_SLOTS = {
  /** Below the tool, above the explainer content. Seen after a conversion finishes. */
  belowTool: { id: 'ad-below-tool', slot: null, label: 'Advertisement' },
  /** In-content, between explainer sections. Also used by the landing pages. */
  inContent: { id: 'ad-in-content', slot: null, label: 'Advertisement' },
};

/* ── Copy that appears in more than one place ───────────────────────────────────── */

export const SIZE_NOTE =
  'JPG files come out bigger than the HEIC files you put in — around 168% at quality ' +
  '0.85. That is not a bug in this converter, and no converter avoids it. HEIC compresses ' +
  'with HEVC, a codec from 2013; JPG dates to 1992 and needs more bytes for the same ' +
  'picture. You are paying in megabytes for a file that opens everywhere. WebP saves you ' +
  'about 8% against JPG but is still bigger than your HEIC. The only way to come out ' +
  'smaller than the original is to lower the quality slider — around 0.6 lands near the ' +
  'original size, with visible quality loss.';
