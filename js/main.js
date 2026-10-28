/**
 * main.js — app logic and wiring. Owns no DOM details; ui.js does the drawing.
 *
 * ── FIRST PAINT ─────────────────────────────────────────────────────────────────────
 * This module statically imports ONLY config.js and ui.js — a couple of KB. The decoder
 * (js/decode.js, and behind it a 1.4 MB WASM build of libheif) and the queue are pulled
 * in with a dynamic import, and only once you show intent to convert something: hovering,
 * focusing, dragging over or touching the drop zone. So the page paints without ever
 * waiting on the decoder, and by the time a file is actually dropped the WASM is usually
 * already compiled and the workers are warm.
 *
 * Nobody who reads the article and leaves ever downloads the decoder at all.
 */

import { DEFAULTS, FORMATS, RESIZE_OPTIONS, LIMITS, STORAGE_KEY, SIZE_NOTE, VERSION } from './config.js';
import { createWireTap, createQueueView, initRoom, formatBytes, formatDelta } from './ui.js';

const $ = (id) => document.getElementById(id);

const els = {
  drop: $('drop'),
  pick: $('pick'),
  input: $('file-input'),
  format: $('format'),
  formatHint: $('format-hint'),
  quality: $('quality'),
  qualityOut: $('quality-out'),
  resize: $('resize'),
  queue: $('queue'),
  queueScroll: $('queue-scroll'),
  queueBox: $('queue-box'),
  queueMore: $('queue-more'),
  queueCount: $('queue-count'),
  queueStatus: $('queue-status'),
  meter: $('meter'),
  meterWrap: $('meter-wrap'),
  saveAll: $('save-all'),
  stopAll: $('stop-all'),
  clearAll: $('clear-all'),
  reconvert: $('reconvert'),
  combinePdf: $('combine-pdf'),
  combineNote: $('combine-note'),
  combineResult: $('combine-result'),
  mismatch: $('mismatch'),
  ledgerIn: $('ledger-in'),
  ledgerOut: $('ledger-out'),
  ledgerDelta: $('ledger-delta'),
  ledgerWhy: $('ledger-why'),
  globalError: $('global-error'),
  zipWarning: $('zip-warning'),
  svgWarning: $('svg-warning'),
  sizeNote: $('size-note'),
  roomToggle: $('room-toggle'),
};

/* ── Settings ───────────────────────────────────────────────────────────────────── */

const loadSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      format: FORMATS.some((f) => f.id === saved.format) ? saved.format : DEFAULTS.format,
      quality: typeof saved.quality === 'number' && saved.quality > 0 && saved.quality <= 1
        ? saved.quality
        : DEFAULTS.quality,
      maxDimension: RESIZE_OPTIONS.some((o) => o.value === saved.maxDimension)
        ? saved.maxDimension
        : DEFAULTS.maxDimension,
    };
  } catch (_) {
    return { ...DEFAULTS };
  }
};

const saveSettings = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {
    /* private mode / full quota — settings just won't stick, which is survivable */
  }
};

let settings = loadSettings();

/* ── Landing-page format preselect ─────────────────────────────────────────────────────
 * This is the ONE universal converter every format landing page funnels into. A visitor
 * arriving from e.g. /png-to-jpg/ (which links to /?to=jpg) should land with the matching
 * output already chosen under "Save as". A valid `?to=` OVERRIDES the saved/default output
 * format for the INITIAL state only; it never persists on load, so a returning user's saved
 * choice is left untouched on disk unless they change a control themselves. Invalid/absent →
 * no change, saved settings stand. */
const TO_PARAM_FORMATS = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
};

function formatFromUrl() {
  try {
    const to = new URLSearchParams(window.location.search).get('to');
    if (!to) return null;
    const fmt = TO_PARAM_FORMATS[to.trim().toLowerCase()];
    return fmt && FORMATS.some((f) => f.id === fmt) ? fmt : null;
  } catch (_) {
    return null;
  }
}

const preselectFormat = formatFromUrl();
if (preselectFormat) settings.format = preselectFormat;

/* ── Lazy engine ────────────────────────────────────────────────────────────────── */

/** Set once the modules resolve, so click handlers can use them without awaiting. */
let mods = null;
let enginePromise = null;

/**
 * Preload the engine MODULES only — queue.js + encode.js, a few KB, and NO WASM. decode.js
 * (and behind it the 1.4 MB libheif WASM) is deliberately NOT loaded here: the converter is
 * now universal, and a visitor who only converts JPG/PNG/WebP must never pay for the HEIC
 * decoder. It's pulled in by warmDecoder(), and by queue.js's decodeItem(), only once a
 * HEIC/HEIF is actually present.
 */
function loadEngine() {
  if (!enginePromise) {
    enginePromise = Promise.all([import('./queue.js'), import('./encode.js')])
      .then(([queueMod, encodeMod]) => {
        mods = { queueMod, encodeMod };
        return mods;
      })
      .catch((err) => {
        enginePromise = null; // let a real drop retry
        throw err;
      });
  }
  return enginePromise;
}

/** Warm the engine modules on intent (hover/focus/drag). Cheap, no WASM. Idempotent. */
let warmed = false;
function warm() {
  if (warmed) return;
  warmed = true;
  loadEngine().catch(() => {
    warmed = false;
  });
}

/**
 * Spin up the libheif worker/WASM — the ONLY thing that fetches the 1.4 MB decoder. Called
 * exclusively when a HEIC/HEIF file is actually in a batch, so the heavy decoder loads
 * precisely when it's needed and never before (and never at all for a JPG/PNG/WebP-only
 * run). Idempotent; a warmup failure is only a lost optimisation — the real decode reports it.
 */
let decoderWarmed = false;
function warmDecoder() {
  if (decoderWarmed) return;
  decoderWarmed = true;
  import('./decode.js')
    .then((decodeMod) => decodeMod.initDecoder())
    .catch(() => {
      decoderWarmed = false;
    });
}

/* ── Queue ──────────────────────────────────────────────────────────────────────── */

/**
 * ── THE MODEL: settings apply to NEW files. Finished work stays finished. ───────────
 *
 * Changing the format never re-encodes what's already converted. Convert ten photos as
 * JPG, switch to PNG, and those ten are still JPG — the next file you add is PNG. One
 * batch may therefore legitimately hold several formats at once.
 *
 * WHY THIS SHAPE: createQueue() freezes `format` at construction, so one queue can only
 * ever emit one format. A mixed batch is therefore not one queue — it is a list of RUNS,
 * each with its own frozen settings, presented to the user as a single list of rows.
 *
 * ── THE HAZARD THIS CREATES, AND THE RULE THAT CONTAINS IT ─────────────────────────
 * "Selector says PNG, file is JPG" is the exact confusion this whole tool has been
 * fighting. It is only survivable because the UI never speaks for the selector:
 *
 *   EVERY row's format comes from `item.outputName`, which outputFilename() derived from
 *   the format its own run was built with. It is a record of what was ENCODED. Nothing on
 *   a row is ever read from `settings`.
 *
 * When finished rows disagree with the current settings, update() says so permanently and
 * the always-present "Re-convert all" button acts on it. Nothing is implied, nothing is
 * hidden behind a state change someone has to notice.
 */

/** @type {Array<{ queue: object, settings: object, id: number }>} */
let runs = [];
/** True while a combined PDF is being built, so its button doesn't get re-enabled under it. */
let combining = false;
/** The last combine's real result ({pageCount, skipped}), exposed for verification. */
let lastPdfResult = null;
/** Above this many files, warn that a single combined PDF is memory-heavy. Measured ceiling
 *  is >1100 photos, so this is a heads-up well under the wall, not a gate. */
const COMBINE_PDF_WARN_FILES = 600;
/** item.id -> the run that owns it, so a row can report its own real settings. */
const runByItem = new Map();
let runSeq = 0;

const showError = (message) => {
  els.globalError.hidden = !message;
  els.globalError.textContent = message || '';
};

/** Every row, oldest run first — i.e. the order the user added them. */
const allItems = () => runs.flatMap((run) => run.queue.items);

const allStats = () => {
  const agg = {
    total: 0, done: 0, errored: 0, pending: 0, running: 0, cancelled: 0,
    inputBytes: 0, outputBytes: 0,
  };
  for (const run of runs) {
    const s = run.queue.stats;
    for (const key of Object.keys(agg)) agg[key] += s[key] || 0;
  }
  return agg;
};

const sameSettings = (a, b) =>
  !!a && !!b && a.format === b.format && a.quality === b.quality && a.maxDimension === b.maxDimension;

const allFiles = () => allItems().map((i) => i.file).filter(Boolean);

/** Files already converted (or queued) under settings that differ from the current ones. */
const staleItems = () =>
  allItems().filter((item) => {
    const run = runByItem.get(item.id);
    return run && !sameSettings(run.settings, settings);
  });

/** Start a new run with the CURRENT settings. Existing runs are untouched. */
function startRun(files) {
  const run = { settings: { ...settings }, id: ++runSeq, queue: null };
  const onEvent = () => {
    if (runs.includes(run)) update();
  };
  run.queue = mods.queueMod.createQueue({
    format: run.settings.format,
    quality: run.settings.quality,
    maxDimension: run.settings.maxDimension || undefined,
    // The queue mints a small preview object-URL per item and owns its whole lifecycle —
    // it revokes on remove/clear/retry/dispose. We render item.thumbnail, never revoke it.
    thumbnails: true,
    thumbnailSize: 160,
    onItemStart: onEvent,
    onItemDone: onEvent,
    onItemError: onEvent,
    onProgress: onEvent,
    onAllDone: onEvent,
  });
  runs.push(run);
  for (const item of run.queue.addAll(files)) runByItem.set(item.id, run);
  run.queue.start();
  update();
  return run;
}

function clearRuns() {
  for (const run of runs) run.queue.clear();
  runs = [];
  runByItem.clear();
}

/**
 * Re-convert everything under the current settings. The ONE path that touches finished
 * work, and only ever from an explicit click on a visible button.
 */
function reconvertAll() {
  if (!mods) return;
  const files = allFiles();
  if (files.length === 0) return;
  clearRuns();
  startRun(files);
}

async function addFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;

  showError('');
  els.queue.hidden = false;

  try {
    await loadEngine();
  } catch (_) {
    showError('The converter failed to load. Check your connection and reload the page.');
    return;
  }

  // Spin up the 1.4 MB libheif decoder ONLY now, and ONLY if a HEIC/HEIF is actually in this
  // batch. A JPG/PNG/WebP-only batch decodes natively and never touches the WASM. (queue.js's
  // decodeItem() would lazy-load it anyway on the first HEIC; this just starts it a beat
  // earlier so the workers are warm by the time that item runs.)
  if (list.some(looksHeic)) warmDecoder();

  // Join the newest run only if it was built with exactly these settings; otherwise this
  // file needs a run of its own. Adding to a run with a different frozen format is what
  // silently produced the wrong extension before.
  const last = runs[runs.length - 1];
  if (last && sameSettings(last.settings, settings)) {
    for (const item of last.queue.addAll(list)) runByItem.set(item.id, last);
    last.queue.start();
    update();
    return;
  }
  startRun(list);
}

/* ── Painting ───────────────────────────────────────────────────────────────────── */

/**
 * The dimensions the OUTPUT file actually has — which is not what the item records.
 *
 * queue.js sets item.width/height from the decode, i.e. the source photo, so with a resize
 * cap active they are not the size of the file the user ends up with. This mirrors
 * encode.js's targetSize(): cap the longest side, preserve aspect, never upscale. It is
 * deliberately the same rule, and test/verify.ui.mjs asserts this label against the
 * DECODED output so the two can't quietly drift apart.
 */
function outputDims(item) {
  if (!item.width || !item.height) return null;
  // The cap this item was ACTUALLY encoded with — its own run's, never the live selector's.
  const run = runByItem.get(item.id);
  const max = run ? run.settings.maxDimension : 0;
  const longest = Math.max(item.width, item.height);
  if (!max || longest <= max) return [item.width, item.height];
  const scale = max / longest;
  return [Math.max(1, Math.round(item.width * scale)), Math.max(1, Math.round(item.height * scale))];
}

const view = createQueueView({
  root: document.documentElement,
  scroll: els.queueScroll,
  box: els.queueBox,
  more: els.queueMore,
  outputDims,
  virtualizeAbove: LIMITS.virtualizeAbove,
  overscan: LIMITS.overscanRows,
  onAction: (act, id) => {
    // Route the action to the run that owns this row — with several runs in play, "the
    // queue" is no longer a single thing.
    const run = runByItem.get(id);
    if (!run) return;
    const item = run.queue.items.find((i) => i.id === id);
    if (!item) return;
    if (act === 'download' && item.blob) downloadBlob(item.blob, item.outputName || item.name);
    else if (act === 'retry') run.queue.retryItem(id);
    else if (act === 'cancel') run.queue.cancelItem(id);
    else if (act === 'remove') {
      run.queue.remove(id);
      runByItem.delete(id);
      // Drop empty runs so a stale settings snapshot can't linger and claim a mismatch.
      runs = runs.filter((r) => r.queue.items.length > 0);
    }
    update();
  },
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function update() {
  const stats = allStats();
  const items = allItems();
  view.render(items);

  els.queue.hidden = stats.total === 0;
  els.queueCount.textContent = plural(stats.total, 'file', 'files');

  const settled = stats.done + stats.errored + stats.cancelled;
  const pct = stats.total ? Math.round((settled / stats.total) * 100) : 0;
  els.meter.style.width = `${pct}%`;
  els.meterWrap.setAttribute('aria-label', `Batch progress: ${pct}%`);

  const working = stats.running > 0 || stats.pending > 0;
  els.stopAll.hidden = !working;
  els.saveAll.disabled = stats.done === 0;

  // Ledger — input vs output, live, with the sign shown.
  els.ledgerIn.textContent = formatBytes(stats.inputBytes);
  els.ledgerOut.textContent = formatBytes(stats.outputBytes);

  // Compare like with like: only files that finished have an output size, so the ratio
  // must use their inputs, not the whole batch's. Otherwise it reads far too good early
  // in a run and creeps up as it finishes — dishonest by accident.
  const doneInput = items.reduce(
    (n, i) => n + (i.status === 'done' && i.outputSize ? i.inputSize || 0 : 0),
    0
  );
  const delta = formatDelta(doneInput, stats.outputBytes);
  els.ledgerDelta.textContent = delta ? delta.text : '';
  if (delta) els.ledgerDelta.dataset.dir = delta.dir;

  // Status line, also the screen-reader announcement for the batch.
  const parts = [];
  if (working) parts.push(`Converting… ${settled} of ${stats.total} done`);
  else if (stats.total) parts.push(`${plural(stats.done, 'file', 'files')} converted`);
  if (stats.errored) parts.push(`${plural(stats.errored, 'file', 'files')} failed — retry from the row`);
  if (stats.cancelled) parts.push(`${plural(stats.cancelled, 'file', 'files')} stopped`);
  els.queueStatus.textContent = parts.join(' · ');

  paintMismatch(items);
  paintCombinePdf(items);
  tap.noteLocalWork(stats.done);
  paintZipWarning(stats);
  paintSvgWarning();
}

/**
 * The "Combine into one PDF" control. It works off the queue's SOURCE files, so it is
 * available regardless of what the batch was converted to — you can convert as JPG and
 * still bind the originals into a PDF.
 *
 * Feature-detected: if the build lacks combineFilesToPdf, the button is removed entirely
 * rather than offered and then failing on click.
 */
function paintCombinePdf(items) {
  const hasApi = mods && typeof mods.encodeMod.combineFilesToPdf === 'function';
  if (!hasApi) {
    els.combinePdf.hidden = true;
    return;
  }
  els.combinePdf.hidden = false;
  // Enabled once there's at least one source file to bind. Corrupt files are skipped by
  // combineFilesToPdf itself, so we don't try to predict decodability here.
  const files = items.filter((i) => i.file).length;
  if (!combining) els.combinePdf.disabled = files === 0;

  // Honest size heads-up, same spirit as the zip warning: a combined PDF is assembled in
  // memory, so a very large batch is where a low-memory device could struggle.
  if (files > COMBINE_PDF_WARN_FILES) {
    els.combineNote.hidden = false;
    els.combineNote.textContent =
      `Combining ${files} photos into one PDF builds the whole file in memory. It may be ` +
      `slow, or hit a memory limit on a phone or an older machine. It'll still try.`;
  } else {
    els.combineNote.hidden = true;
  }
}

/** The label a format id wears in the UI ('image/png' -> 'PNG'). */
const formatLabel = (id) => {
  const found = FORMATS.find((f) => f.id === id);
  return found ? found.label : id;
};

/**
 * Say — plainly, permanently, and in the page rather than a tooltip — when the rows on
 * screen were made with settings that are no longer the ones selected.
 *
 * This notice is the price of "settings only apply to new files". Without it the model is
 * indistinguishable from the bug that started all this: selector says PNG, files are JPG.
 * With it, that state is a sentence the user can read.
 */
function paintMismatch(items) {
  const stale = staleItems();
  const target = formatLabel(settings.format);

  // The re-convert button is ALWAYS in the bar — never revealed by a state change someone
  // has to spot. It only goes disabled when there is genuinely nothing to re-convert.
  els.reconvert.textContent = `Re-convert all as ${target}`;
  els.reconvert.disabled = stale.length === 0 || items.length === 0;

  if (stale.length === 0) {
    els.mismatch.hidden = true;
    return;
  }

  // Group by what each run ACTUALLY encoded, so the sentence is true for a batch that
  // mixes three formats as much as for one that mixes two.
  const byFormat = new Map();
  for (const item of stale) {
    const run = runByItem.get(item.id);
    const label = formatLabel(run.settings.format);
    byFormat.set(label, (byFormat.get(label) || 0) + 1);
  }
  const made = [...byFormat].map(([label, n]) => `${plural(n, 'file', 'files')} as ${label}`);
  els.mismatch.hidden = false;
  els.mismatch.textContent =
    `${made.join(', ')} — already converted, and left alone. New files use ${target}.`;
}

/**
 * Tell the user what "Save all as zip" is actually going to do, before they click.
 *
 * The ceiling behind this is real and measured (see queue.js): a browser breaks Blobs
 * past its in-memory quota, and a broken Blob looks perfectly healthy until something
 * reads the bytes — i.e. it fails at the user's download, not here. So a big batch either
 * streams to disk (one file, no ceiling) or is split into several zips. Either is fine;
 * silently handing someone three files when they expected one is not.
 */
function paintZipWarning(stats) {
  const q = mods && mods.queueMod;
  const hide = () => {
    els.zipWarning.hidden = true;
  };
  if (!q || stats.done === 0) return hide();

  // Streaming: one file, any size. Nothing to warn about.
  if (typeof q.canStreamZip === 'function' && q.canStreamZip()) return hide();

  if (typeof q.planChunkedZips === 'function') {
    const parts = q.planChunkedZips(allItems());
    if (parts.length <= 1) return hide();
    els.zipWarning.hidden = false;
    els.zipWarning.textContent =
      `That's ${formatBytes(stats.outputBytes)} of photos — more than this browser can put ` +
      `in one zip. "Save all" will download ${parts.length} zips instead, one after another. ` +
      `Let them all finish.`;
    return;
  }

  // No chunking available: the honest option is per-file saves.
  if (stats.outputBytes > LIMITS.zipSafeOutputBytes) {
    els.zipWarning.hidden = false;
    els.zipWarning.textContent =
      `That's ${formatBytes(stats.outputBytes)} of converted photos — more than a browser ` +
      `will reliably put in a single zip. Save the files individually and they'll all come ` +
      `through. A zip this size can download and still be broken.`;
    return;
  }
  hide();
}

/* ── SVG photo-guard ────────────────────────────────────────────────────────────────
 *
 * Vector tracing is genuinely good for logos and flat graphics and genuinely bad for
 * photographs — a traced photo is large and blurry/posterised. The static up-front warning
 * lives on the "Save as" hint (config.js); THIS is the active half: whenever SVG output is in
 * play and the batch holds anything that looks like a photo, say so plainly. It never blocks —
 * proceeding is the user's call — it just refuses to pretend a traced photo is a good result.
 *
 * Heuristic (any one is enough): a camera source format (HEIC/HEIF/JPEG), a large pixel
 * count, or a traced file that came out big — each a strong "this is a photo" signal. A small
 * flat PNG/WebP graphic trips none of them, so the guard stays quiet for the case SVG is for.
 */
const SVG_PHOTO_MEGAPIXELS = 3_000_000; // > ~3 MP source → almost certainly a photo
const SVG_PHOTO_BYTES = 500 * 1024; // a traced file this large is a photo, not a logo

function looksLikePhotoForSvg(item) {
  const type = ((item.file && item.file.type) || '').toLowerCase();
  const name = ((item.file && item.file.name) || '').toLowerCase();
  const cameraFormat = /image\/(hei[cf]|jpeg)/.test(type) || /\.(hei[cf]|jpe?g)$/.test(name);
  const manyPixels = item.width && item.height && item.width * item.height > SVG_PHOTO_MEGAPIXELS;
  const bigOutput = item.outputSize && item.outputSize > SVG_PHOTO_BYTES;
  return cameraFormat || manyPixels || bigOutput;
}

function paintSvgWarning() {
  // Only rows actually headed for (or already traced to) SVG matter here.
  const svgItems = allItems().filter((item) => {
    const run = runByItem.get(item.id);
    return run && run.settings.format === 'image/svg+xml';
  });
  const flagged = svgItems.filter(looksLikePhotoForSvg);
  if (flagged.length === 0) {
    els.svgWarning.hidden = true;
    return;
  }
  els.svgWarning.hidden = false;
  els.svgWarning.textContent =
    `${plural(flagged.length, 'file', 'files')} here ${flagged.length === 1 ? 'looks' : 'look'} like ` +
    `${flagged.length === 1 ? 'a photograph' : 'photographs'}, and SVG tracing isn't built ` +
    `for photos — expect a large file that looks blurry or posterised. It'll still trace if ` +
    `you want it; for a photo, JPG or WebP is the honest choice.`;
}

/* ── Downloads ──────────────────────────────────────────────────────────────────── */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke late: Safari needs the URL alive past the click for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * "Save all as zip", best mechanism first. Every tier is feature-detected, so this
 * degrades to a plain in-memory zip on a browser (or a build) that has none of them.
 *
 *   1. streamZipToDisk   — Chromium. Straight to a file the user picks; memory stays flat
 *                          no matter how big the batch is.
 *   2. zipItemsChunked   — everyone else. Several zips, each under the browser's blob
 *                          wall, downloaded AND RELEASED one at a time via onChunk. Without
 *                          onChunk the parts are all retained and we're back to the wall
 *                          we were trying to avoid.
 *   3. zipItems          — one blob, small batches.
 *
 * ── GESTURE-CRITICAL ────────────────────────────────────────────────────────────────
 * showSaveFilePicker() needs transient user activation, and the FIRST `await` spends it.
 * So this function is called straight from the click handler and does not await anything
 * before invoking streamZipToDisk(). Don't add an `await` above that call.
 */
async function saveAll() {
  if (!mods) return;
  const { queueMod } = mods;
  const ready = allItems().filter((i) => i.status === 'done' && i.blob);
  if (ready.length === 0) return;

  const setBusy = (on, label) => {
    els.saveAll.disabled = on;
    els.saveAll.textContent = on ? label : 'Save all as zip';
  };
  const onProgress = (percent) => setBusy(true, `Saving… ${Math.round(percent)}%`);

  // Name the zip after what's actually inside it — read off the real output filenames, so
  // it cannot drift from the bytes. A uniform batch gets photos-jpg.zip / photos-png.zip,
  // which stops the browser from silently appending " (1)" to a second photos.zip and
  // sending someone back to the wrong file. A MIXED batch gets the neutral name, because
  // claiming one format for a zip holding three would be the same lie in a new outfit.
  const exts = new Set(ready.map((i) => (i.outputName || '').split('.').pop() || ''));
  const baseName = exts.size === 1 ? `photos-${[...exts][0]}` : 'photos';

  // 1 — stream to disk. Called before any await, on purpose.
  if (
    typeof queueMod.canStreamZip === 'function' &&
    typeof queueMod.streamZipToDisk === 'function' &&
    queueMod.canStreamZip()
  ) {
    const streaming = queueMod.streamZipToDisk(ready, { suggestedName: `${baseName}.zip`, onProgress });
    setBusy(true, 'Saving…');
    try {
      // Dismissing the picker resolves with cancelled:true — a normal outcome, not an error.
      await streaming;
      return;
    } catch (err) {
      console.warn('Streaming zip failed; falling back to an in-memory zip.', err);
      // fall through to the tiers below
    } finally {
      setBusy(false);
    }
  }

  setBusy(true, 'Zipping…');
  try {
    // 2 — chunked. onChunk downloads each part and lets it go before the next is built.
    if (typeof queueMod.zipItemsChunked === 'function' && typeof queueMod.downloadBlobs === 'function') {
      await queueMod.zipItemsChunked(ready, {
        baseName,
        onProgress,
        onChunk: async ({ blob, filename }) => {
          await queueMod.downloadBlobs([{ blob, filename }]);
        },
      });
      return;
    }

    // 3 — one zip.
    const blob = await queueMod.zipItems(ready, onProgress);
    downloadBlob(blob, `${baseName}.zip`);
  } catch (err) {
    showError(
      (err && err.message ? err.message : 'The zip failed.') +
        ' Saving the files one at a time will work.'
    );
  } finally {
    setBusy(false);
  }
}

/* ── Input ──────────────────────────────────────────────────────────────────────── */

const HEIC_RE = /\.(heic|heif)$/i;
const looksHeic = (file) => HEIC_RE.test(file.name || '') || /^image\/hei[cf]/i.test(file.type || '');

/**
 * Walk a dropped folder. Camera roll exports arrive as folders, and a folder dropped
 * without this yields one unreadable zero-byte "file" and a baffling error.
 *
 * Filters to HEIC-looking names on the way: a folder is a bulk gesture, and turning a
 * dropped Pictures folder into 400 red "this is a PNG" rows would be useless. Files
 * chosen or dropped ONE BY ONE are never filtered — there the error is the answer.
 */
async function readEntry(entry, out, depth = 0) {
  if (!entry || depth > 8 || out.length > 5000) return;
  if (entry.isFile) {
    await new Promise((resolve) => {
      entry.file((file) => {
        if (looksHeic(file)) out.push(file);
        resolve();
      }, resolve);
    });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries() returns at most ~100 at a time and must be called until it's empty.
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, out, depth + 1);
    }
  }
}

async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  const hasDirectory = entries.some((entry) => entry.isDirectory);
  if (!hasDirectory || entries.length === 0) return Array.from(dataTransfer.files || []);

  const out = [];
  for (const entry of entries) await readEntry(entry, out);
  return out;
}

/* Drag and drop */
let dragDepth = 0;
const setDrag = (on) => {
  els.drop.dataset.drag = String(on);
};

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
  dragDepth++;
  setDrag(true);
  warm();
});

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDrag(false);
});

// Dropping anywhere works. Dropping outside the zone is a miss, not a mistake — but a
// stray drop onto the page must never navigate the browser to the file.
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDrag(false);
  if (!event.dataTransfer) return;
  addFiles(await filesFromDrop(event.dataTransfer));
});

/* Picker */
els.pick.addEventListener('click', () => els.input.click());
els.drop.addEventListener('click', (event) => {
  if (event.target === els.pick || event.target.closest('button')) return;
  els.input.click();
});
els.input.addEventListener('change', () => {
  addFiles(els.input.files);
  els.input.value = ''; // so picking the same file twice fires again
});

/* Paste */
window.addEventListener('paste', (event) => {
  const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
  if (files.length) addFiles(files);
});

/* Warm on intent */
for (const type of ['pointerenter', 'focusin', 'touchstart']) {
  els.drop.addEventListener(type, warm, { once: true, passive: true });
}

/* ── Controls ───────────────────────────────────────────────────────────────────── */

function buildFormatPicker() {
  for (const format of FORMATS) {
    const label = document.createElement('label');
    label.className = 'seg__opt';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'format';
    input.value = format.id;
    input.checked = format.id === settings.format;
    const span = document.createElement('span');
    span.textContent = format.label;
    label.append(input, span);
    els.format.append(label);

    input.addEventListener('change', () => {
      settings.format = format.id;
      saveSettings();
      paintFormatHint();
      // Deliberately does NOT re-encode anything: settings apply to files converted from
      // here on. update() restates what the existing rows really are.
      update();
    });
  }
  paintFormatHint();
}

function paintFormatHint() {
  const format = FORMATS.find((f) => f.id === settings.format);
  els.formatHint.textContent = format ? format.hint : '';
  // Quality applies to JPEG, WebP and PDF (all wrap a lossy JPEG). Only PNG is lossless,
  // so it is the sole format that greys the slider out.
  const lossless = settings.format === 'image/png';
  els.quality.disabled = lossless;
  els.qualityOut.textContent = lossless ? 'lossless' : settings.quality.toFixed(2);
}

function buildResizePicker() {
  for (const option of RESIZE_OPTIONS) {
    const node = document.createElement('option');
    node.value = String(option.value);
    node.textContent = option.label;
    node.selected = option.value === settings.maxDimension;
    els.resize.append(node);
  }
  els.resize.addEventListener('change', () => {
    settings.maxDimension = Number(els.resize.value) || 0;
    saveSettings();
    update();
  });
}

els.quality.value = String(settings.quality);
els.quality.addEventListener('input', () => {
  settings.quality = Number(els.quality.value);
  // paintFormatHint owns this label — it knows PNG must keep reading "lossless" rather
  // than a number the encoder would ignore. Two writers meant two answers.
  paintFormatHint();
  update(); // no debounce needed: a quality change no longer starts any work
});
els.quality.addEventListener('change', saveSettings);

buildFormatPicker();
buildResizePicker();
paintFormatHint();

/* ── Queue controls ─────────────────────────────────────────────────────────────── */

els.saveAll.addEventListener('click', () => {
  void saveAll();
});

els.stopAll.addEventListener('click', () => {
  for (const run of runs) run.queue.cancel();
  update();
});

els.reconvert.addEventListener('click', () => {
  reconvertAll();
});

/**
 * Bind every source photo into a single multi-page PDF and download it.
 *
 * Works on the ORIGINAL files, not the converted output, so it is independent of the
 * batch's format. combineFilesToPdf skips files it can't decode (returning them in
 * `skipped`) rather than failing the whole document, and throws only if nothing survived.
 * We route through a plain Blob download — no File System Access picker — so no user
 * gesture is spent and this can safely await the build.
 */
async function combineAllToPdf() {
  if (!mods || typeof mods.encodeMod.combineFilesToPdf !== 'function') return;
  const files = allItems().map((i) => i.file).filter(Boolean);
  if (files.length === 0) return;

  combining = true;
  els.combinePdf.disabled = true;
  const restingLabel = els.combinePdf.textContent;
  showError('');
  els.combineResult.hidden = true;

  try {
    const { blob, pageCount, skipped } = await mods.encodeMod.combineFilesToPdf(files, {
      quality: settings.quality,
      maxDimension: settings.maxDimension || undefined,
      onProgress: (done, total) => {
        els.combinePdf.textContent = `Building PDF… ${done}/${total}`;
        els.queueStatus.textContent = `Building a ${total}-page PDF… ${done} of ${total} added`;
      },
    });

    downloadBlob(blob, 'photos.pdf');

    // Expose the real result for verification — this is the count pdf-lib actually wrote.
    lastPdfResult = { pageCount, skipped: skipped ? skipped.length : 0 };

    // Never swallow skips. This lands in its OWN note so update()'s size-warning logic
    // (which shares no element with it) can't wipe it the instant it appears.
    if (skipped && skipped.length > 0) {
      els.combineResult.hidden = false;
      els.combineResult.textContent =
        `${plural(skipped.length, 'file', 'files')} couldn't be added and ${skipped.length === 1 ? 'was' : 'were'} ` +
        `skipped — the other ${plural(pageCount, 'page', 'pages')} are in the PDF.`;
    }
    els.queueStatus.textContent = `Saved a ${plural(pageCount, 'page', 'pages')} PDF.`;
  } catch (err) {
    showError(
      (err && err.message ? err.message : 'The PDF could not be built.') +
        ' Try saving the photos individually instead.'
    );
  } finally {
    combining = false;
    els.combinePdf.textContent = restingLabel;
    update();
  }
}

els.combinePdf.addEventListener('click', () => {
  void combineAllToPdf();
});

els.clearAll.addEventListener('click', () => {
  clearRuns();
  els.queue.hidden = true;
  showError('');
  els.zipWarning.hidden = true;
  els.svgWarning.hidden = true;
  els.combineNote.hidden = true;
  els.combineResult.hidden = true;
  els.sizeNote.hidden = true;
  update();
});

// Toggle, not a one-way reveal: the answer is a paragraph, and you should be able to put
// it away again.
els.ledgerWhy.addEventListener('click', () => {
  const showing = !els.sizeNote.hidden;
  els.sizeNote.hidden = showing;
  els.sizeNote.textContent = SIZE_NOTE;
  els.ledgerWhy.setAttribute('aria-expanded', String(!showing));
});
els.ledgerWhy.setAttribute('aria-expanded', 'false');
els.ledgerWhy.setAttribute('aria-controls', 'size-note');

/* ── Wire tap + room ────────────────────────────────────────────────────────────── */

const tap = createWireTap({
  uploaded: $('tap-uploaded'),
  thirdParty: $('tap-thirdparty'),
  local: $('tap-local'),
  connection: $('tap-connection'),
  connectionNote: $('tap-connection-note'),
});

initRoom(els.roomToggle);

/* Test hook. Harmless in production, and the verification driver needs a way to know the
   app finished wiring itself up. */
window.__app = {
  version: VERSION,
  /** A read-only view over every run, so the outside sees one batch. */
  get queue() {
    if (runs.length === 0) return null;
    return {
      get items() { return allItems(); },
      get stats() { return allStats(); },
      remove(id) {
        const run = runByItem.get(id);
        if (!run) return;
        run.queue.remove(id);
        runByItem.delete(id);
        runs = runs.filter((r) => r.queue.items.length > 0);
        update();
      },
    };
  },
  get settings() { return settings; },
  /** What each row was ACTUALLY encoded with — for tests that must not trust labels. */
  get runs() { return runs.map((r) => ({ settings: r.settings, count: r.queue.items.length })); },
  /** The real {pageCount, skipped} of the last combined PDF — for verification. */
  get lastPdf() { return lastPdfResult; },
};
window.__ready = true;
