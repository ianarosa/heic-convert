/**
 * compress.js — the image compressor at /compress/. 100% client-side, no build step.
 *
 * ── WHY THIS IS ITS OWN FILE, NOT js/queue.js ───────────────────────────────────────
 * The HEIC tool's queue.js statically imports js/decode.js, which fronts a 1.4 MB WASM
 * build of libheif. This tool's inputs are ALREADY web formats (JPG/PNG/WebP), which the
 * browser decodes natively with `createImageBitmap(file)` — no WASM, no worker pool. So
 * importing queue.js would drag the entire HEIC decoder onto a page that never needs it,
 * wrecking first paint for nothing. Instead this file carries a small, focused
 * decode→encode→release engine of its own.
 *
 * WHAT IT REUSES (read-only imports, no duplication):
 *   • js/encode.js      — encodeBitmap()/outputFilename(). The exact same encoder the HEIC
 *                         tool re-encodes with; it CONSUMES the bitmap it's handed. (encode.js
 *                         itself statically imports decode.js, so a ~10 KB decode.js module
 *                         rides along on load — but its heavy parts, the 1.4 MB libheif WASM
 *                         bundle and the decode workers, stay lazy and never load here, since
 *                         this tool never calls initDecoder(). Sharing the one encoder is
 *                         worth more than shaving that 10 KB: it can't drift from the sibling.)
 *   • js/ui.js          — createWireTap(), initRoom(), formatBytes(), formatDelta(). The
 *                         privacy instrument and the byte formatting are shared verbatim, so
 *                         the two tools can't drift apart on either.
 *   • vendor/client-zip — the same ~6 KB streaming zip library, loaded on demand.
 *
 * ── THE HONESTY INVERSION ───────────────────────────────────────────────────────────
 * The HEIC tool has to admit files come out BIGGER. Here they come out SMALLER — that's
 * the product. The one place honesty bites the same way: re-compressing a file that's
 * already small (an optimised JPEG, a tiny PNG) can produce a LARGER file. We never hand
 * that back. When the re-encode isn't smaller and the user didn't ask for a resize, we
 * keep the ORIGINAL bytes and mark the row "kept original". Never a bigger file, silently
 * or otherwise.
 *
 * ── MEMORY ──────────────────────────────────────────────────────────────────────────
 * A 200-image batch decoded all at once is gigabytes of RGBA. So we never do: each item is
 * decoded, encoded, and released before the next one on that lane starts. At most
 * `CONCURRENCY` bitmaps exist at any moment. encodeBitmap() closes the bitmap it's given,
 * so the release is structural. Output Blobs we keep — a Blob is disk-backed and cheap.
 *
 * ── FAILURE ISOLATION ───────────────────────────────────────────────────────────────
 * Every item runs in its own try/catch. One corrupt or oversized file marks exactly one
 * row `error` and the batch carries on.
 */

import { encodeBitmap, outputFilename } from './encode.js';
import { createWireTap, initRoom, formatBytes, formatDelta } from './ui.js';

const VERSION = '2026-07-16.svg-output';

/* ── Configuration ──────────────────────────────────────────────────────────────────
 * Deliberately local to this file, not imported from config.js: config.js's FORMATS carry
 * HEIC-specific size ratios that are meaningless here, and this tool offers a "keep the
 * source format" option the converter has no use for. */

const STORAGE_KEY = 'safelight.compress.v1';

/**
 * This tool COMPRESSES ONLY — it never changes the file type. Every image is re-encoded as
 * its own source format (`keep`): a JPG stays a JPG, a PNG stays a PNG, a WebP stays a WebP.
 * Format conversion lives in the sibling tool, the converter at `/`. So there is exactly one
 * output mode and no "Save as" control; this single-entry list keeps loadSettings()/
 * formatLabel()/resolveFormat() working while making `keep` the only possible value. A
 * returning user whose saved settings still carry an old converted format (e.g. 'image/webp'
 * from before this tool dropped conversion) is harmlessly coerced back to `keep` on load,
 * because that value is no longer in this list.
 */
const FORMATS = [
  { id: 'keep', label: 'Keep', hint: 'Re-compress each image as itself — the format never changes.' },
];

const RESIZE_OPTIONS = [
  { value: 0, label: 'Original size' },
  { value: 4096, label: '4096 px' },
  { value: 2560, label: '2560 px' },
  { value: 1920, label: '1920 px' },
  { value: 1280, label: '1280 px' },
  { value: 800, label: '800 px' },
];

const DEFAULTS = { format: 'keep', quality: 0.8, maxDimension: 0 };

const LIMITS = {
  /** Above this many files the queue list gets a fixed height and windowed rendering. */
  virtualizeAbove: 24,
  overscanRows: 6,
  /** Past this much output, a single in-memory zip gets unreliable — steer to per-file. */
  zipSafeOutputBytes: 150 * 1024 * 1024,
};

/** Decode/encode lanes. Matches the machine, capped so a huge batch can't spawn a hundred. */
const CONCURRENCY = Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 4);

const SIZE_NOTE =
  'Every number here is measured, not estimated. "In" is the total size of the original ' +
  'files that have finished; "Out" is the total size of what came back — the smaller of ' +
  'the re-compressed file and the original, per image. "Reclaimed" is the difference. Files ' +
  'still being worked on are not counted, so the figure never flatters itself early and ' +
  'then creeps down. Check any single row against the file on your disk.';

const $ = (id) => document.getElementById(id);

const els = {
  drop: $('drop'),
  pick: $('pick'),
  input: $('file-input'),
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
  mismatch: $('mismatch'),
  reclaim: $('reclaim'),
  reclaimBig: $('reclaim-big'),
  reclaimLabel: $('reclaim-label'),
  reclaimIn: $('reclaim-in'),
  reclaimOut: $('reclaim-out'),
  ledgerWhy: $('ledger-why'),
  sizeNote: $('size-note'),
  globalError: $('global-error'),
  zipWarning: $('zip-warning'),
  roomToggle: $('room-toggle'),
};

/* ── Settings ───────────────────────────────────────────────────────────────────── */

const loadSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      format: FORMATS.some((f) => f.id === saved.format) ? saved.format : DEFAULTS.format,
      quality:
        typeof saved.quality === 'number' && saved.quality > 0 && saved.quality <= 1
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

const sameSettings = (a, b) =>
  !!a && !!b && a.format === b.format && a.quality === b.quality && a.maxDimension === b.maxDimension;

const formatLabel = (id) => {
  const found = FORMATS.find((f) => f.id === id);
  return found ? found.label : id;
};

/**
 * Resolve `keep` to a concrete output MIME type from the source file. Everything else is
 * already a concrete type. Falls back to JPEG for an unrecognised source — a photo is the
 * safe assumption for a compressor.
 */
function resolveFormat(setting, file) {
  if (setting !== 'keep') return setting;
  const type = (file.type || '').toLowerCase();
  if (type.includes('png')) return 'image/png';
  if (type.includes('webp')) return 'image/webp';
  if (type.includes('jpeg') || type.includes('jpg')) return 'image/jpeg';
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/* ── The engine ─────────────────────────────────────────────────────────────────────
 *
 * A flat list of items processed CONCURRENCY-at-a-time. Each item carries the settings it
 * was added under, frozen at add time — so changing the controls never silently re-encodes
 * finished work, and a batch that mixes formats stays honest: every row records what it was
 * ACTUALLY encoded as, never what the selector currently says. */

/** @type {Array<Item>} */
let items = [];
let seq = 0;
let active = 0;
let onIdle = null;

/** Kick the scheduler: fill idle lanes with pending work. */
function pump() {
  while (active < CONCURRENCY) {
    const item = items.find((i) => i.status === 'pending');
    if (!item) break;
    active++;
    processItem(item).finally(() => {
      active--;
      // Defer so a burst of finishes coalesces into one repaint, not one per lane.
      queueMicrotask(() => {
        if (active < CONCURRENCY) pump();
        else update();
        if (active === 0 && !items.some((i) => i.status === 'pending') && onIdle) onIdle();
      });
    });
  }
  update();
}

async function processItem(item) {
  item.status = 'running';
  update();

  try {
    // createImageBitmap decodes JPG/PNG/WebP natively, off the main thread, with no WASM.
    const bitmap = await createImageBitmap(item.file);

    if (item.cancelled) {
      bitmap.close();
      item.status = 'cancelled';
      return;
    }

    // Read the source dimensions BEFORE encoding — encodeBitmap() consumes (closes) the
    // bitmap, and the row wants to show the picture's real size.
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    item.width = srcW;
    item.height = srcH;

    const format = resolveFormat(item.settings.format, item.file);
    const max = item.settings.maxDimension || 0;
    const longest = Math.max(srcW, srcH);
    // A resize the user asked for is a real transformation, not just compression: if it
    // actually changes the pixels, we always return the encoded output even when the byte
    // count didn't drop. The "keep original" escape hatch is only for the pure-compression
    // case, where a bigger file would be a pointless bad trade.
    const didResize = max > 0 && longest > max;

    const encoded = await encodeBitmap(bitmap, {
      format,
      quality: item.settings.quality,
      maxDimension: max || undefined,
    });

    if (item.cancelled) {
      item.status = 'cancelled';
      return;
    }

    if (!didResize && encoded.size >= item.file.size) {
      // Re-compressing didn't help. Hand back the ORIGINAL bytes, in the original format,
      // and say so. This is the honesty inversion: never a heavier file than we were given.
      item.kept = true;
      item.blob = item.file;
      item.outputSize = item.file.size;
      item.outputName = basename(item.name);
      item.outputFormat = item.file.type || format;
    } else {
      item.kept = false;
      item.blob = encoded;
      item.outputSize = encoded.size;
      item.outputName = outputFilename(item.name, format);
      item.outputFormat = format;
    }
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = err instanceof Error ? err : new Error(String(err || 'Compression failed.'));
  }
}

function basename(name) {
  const n = typeof name === 'string' ? name : '';
  return (n.split(/[/\\]/).pop() || 'image').replace(/[\x00-\x1f<>:"|?*]/g, '').trim() || 'image'; // eslint-disable-line no-control-regex
}

/** Add files under the CURRENT settings, frozen onto each new item. */
function addItems(files) {
  const added = [];
  for (const file of files) {
    const item = {
      id: ++seq,
      file,
      name: file.name || `image-${seq}`,
      status: 'pending',
      inputSize: file.size,
      outputSize: 0,
      outputName: '',
      outputFormat: '',
      blob: null,
      width: 0,
      height: 0,
      kept: false,
      cancelled: false,
      error: null,
      settings: { ...settings },
    };
    items.push(item);
    added.push(item);
  }
  return added;
}

const stats = () => {
  const s = {
    total: 0, done: 0, errored: 0, pending: 0, running: 0, cancelled: 0,
    kept: 0, inputBytes: 0, outputBytes: 0, doneInput: 0, doneOutput: 0,
  };
  for (const item of items) {
    s.total++;
    if (item.status === 'done') s.done++;
    else if (item.status === 'error') s.errored++;
    else if (item.status === 'pending') s.pending++;
    else if (item.status === 'running') s.running++;
    else if (item.status === 'cancelled') s.cancelled++;
    if (item.kept) s.kept++;
    s.inputBytes += item.inputSize || 0;
    if (item.status === 'done') {
      s.doneInput += item.inputSize || 0;
      s.doneOutput += item.outputSize || 0;
    }
  }
  s.outputBytes = s.doneOutput;
  return s;
};

/** Files finished (or queued) under settings that differ from the current ones. */
const staleItems = () => items.filter((item) => !sameSettings(item.settings, settings));

/* ── Input ──────────────────────────────────────────────────────────────────────── */

const IMG_RE = /\.(jpe?g|png|webp)$/i;
const looksImage = (file) =>
  IMG_RE.test(file.name || '') || /^image\/(jpeg|png|webp)$/i.test(file.type || '');

const showError = (message) => {
  els.globalError.hidden = !message;
  els.globalError.textContent = message || '';
};

async function addFiles(fileList) {
  const list = Array.from(fileList || []);
  if (list.length === 0) return;
  showError('');
  els.queue.hidden = false;
  addItems(list);
  pump();
}

/* Walk a dropped folder, filtering to image-looking names — a folder is a bulk gesture, so
   turning a dropped Pictures folder into 400 red "this isn't an image" rows would be
   useless. Files chosen or dropped one by one are never filtered; there the error is the
   answer. */
async function readEntry(entry, out, depth = 0) {
  if (!entry || depth > 8 || out.length > 5000) return;
  if (entry.isFile) {
    await new Promise((resolve) => {
      entry.file((file) => {
        if (looksImage(file)) out.push(file);
        resolve();
      }, resolve);
    });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, out, depth + 1);
    }
  }
}

async function filesFromDrop(dataTransfer) {
  const dtItems = Array.from(dataTransfer.items || []);
  const entries = dtItems
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  const hasDirectory = entries.some((entry) => entry.isDirectory);
  if (!hasDirectory || entries.length === 0) return Array.from(dataTransfer.files || []);
  const out = [];
  for (const entry of entries) await readEntry(entry, out);
  return out;
}

let dragDepth = 0;
const setDrag = (on) => {
  els.drop.dataset.drag = String(on);
};

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
  dragDepth++;
  setDrag(true);
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
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDrag(false);
  if (!event.dataTransfer) return;
  addFiles(await filesFromDrop(event.dataTransfer));
});

els.pick.addEventListener('click', () => els.input.click());
els.drop.addEventListener('click', (event) => {
  if (event.target === els.pick || event.target.closest('button')) return;
  els.input.click();
});
els.input.addEventListener('change', () => {
  addFiles(els.input.files);
  els.input.value = '';
});
window.addEventListener('paste', (event) => {
  const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
  if (files.length) addFiles(files);
});

/* ── The queue view ─────────────────────────────────────────────────────────────────
 *
 * Windowed exactly like the HEIC tool's ui.js: below LIMITS.virtualizeAbove the list grows
 * naturally; above it, only the rows you can see exist in the DOM. Rows are a fixed height
 * (--row-h) so the maths is exact. The additions over the sibling are compression-specific:
 * a green saving badge per row, and the muted "kept original" state. */

const rowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 60;

/** @type {Map<number, HTMLElement>} live rows, keyed by item id. */
const liveRows = new Map();
let viewFrame = 0;

const statusText = (item) => {
  switch (item.status) {
    case 'pending':
      return 'Waiting';
    case 'running':
      return 'Compressing…';
    case 'cancelled':
      return 'Stopped';
    case 'error':
      return item.error ? item.error.message : 'Something went wrong.';
    case 'done': {
      const dims = outputDims(item);
      const size = dims ? `${dims[0]} × ${dims[1]}` : '';
      if (item.kept) return size ? `Kept original · ${size}` : 'Kept original — already small';
      return size || 'Compressed';
    }
    default:
      return '';
  }
};

/** Output dimensions the file actually has, mirroring encode.js's targetSize(). */
function outputDims(item) {
  if (!item.width || !item.height) return null;
  const max = item.settings.maxDimension || 0;
  const longest = Math.max(item.width, item.height);
  if (item.kept || !max || longest <= max) return [item.width, item.height];
  const scale = max / longest;
  return [Math.max(1, Math.round(item.width * scale)), Math.max(1, Math.round(item.height * scale))];
}

const makeRow = () => {
  const row = document.createElement('li');
  row.className = 'row';
  row.innerHTML = `
    <span class="row__dot" aria-hidden="true"></span>
    <span class="row__main">
      <span class="row__name"></span>
      <span class="row__meta"></span>
    </span>
    <span class="row__sizes"></span>
    <span class="row__acts"></span>`;
  return row;
};

const actionButton = (act, label, id, primary) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn--sm ${primary ? '' : 'btn--quiet'}`;
  button.dataset.act = act;
  button.dataset.id = String(id);
  button.textContent = label;
  return button;
};

const paintRow = (row, item, index, total) => {
  row.dataset.status = item.status;
  row.dataset.id = String(item.id);
  row.dataset.kept = String(item.status === 'done' && item.kept);
  row.style.transform = `translateY(${index * rowHeight()}px)`;
  row.setAttribute('aria-posinset', String(index + 1));
  row.setAttribute('aria-setsize', String(total));

  const name = row.querySelector('.row__name');
  const outName = item.status === 'done' && item.outputName ? item.outputName : item.name;
  if (name.textContent !== outName) name.textContent = outName;

  const meta = row.querySelector('.row__meta');
  const text = statusText(item);
  if (meta.textContent !== text) meta.textContent = text;

  const sizes = row.querySelector('.row__sizes');
  if (item.status === 'done' && item.outputSize) {
    sizes.innerHTML = '';
    sizes.append(
      document.createTextNode(`${formatBytes(item.inputSize)} → `),
      Object.assign(document.createElement('b'), { textContent: formatBytes(item.outputSize) })
    );
    // The saving is the whole point — its own green badge, not a grey afterthought.
    if (item.kept) {
      const span = document.createElement('span');
      span.className = 'row__save';
      span.dataset.dir = 'kept';
      span.textContent = ' 0%';
      span.style.color = 'var(--muted)';
      sizes.append(span);
    } else {
      const delta = formatDelta(item.inputSize, item.outputSize);
      if (delta) {
        const span = document.createElement('span');
        span.className = 'row__save';
        span.dataset.dir = delta.dir;
        span.textContent = ` ${delta.text}`;
        sizes.append(span);
      }
    }
  } else {
    sizes.textContent = formatBytes(item.inputSize);
  }

  const acts = row.querySelector('.row__acts');
  acts.innerHTML = '';
  if (item.status === 'done') acts.append(actionButton('download', 'Save', item.id, true));
  if (item.status === 'error' || item.status === 'cancelled') {
    acts.append(actionButton('retry', 'Retry', item.id, false));
  }
  if (item.status === 'running' || item.status === 'pending') {
    acts.append(actionButton('cancel', 'Stop', item.id, false));
  }
  acts.append(actionButton('remove', '✕', item.id, false));
  const remove = acts.lastElementChild;
  remove.setAttribute('aria-label', `Remove ${item.name}`);
  remove.title = 'Remove';
};

function drawRows() {
  viewFrame = 0;
  const total = items.length;
  const height = rowHeight();
  const virtual = total > LIMITS.virtualizeAbove;

  els.queueScroll.dataset.virtual = String(virtual);
  els.queueBox.style.height = `${total * height}px`;

  let first = 0;
  let last = total - 1;
  if (virtual) {
    const top = els.queueScroll.scrollTop;
    const viewH = els.queueScroll.clientHeight || 1;
    first = Math.max(0, Math.floor(top / height) - LIMITS.overscanRows);
    last = Math.min(total - 1, Math.ceil((top + viewH) / height) + LIMITS.overscanRows);
  }

  const wanted = new Set();
  for (let i = first; i <= last; i++) {
    const item = items[i];
    if (!item) continue;
    wanted.add(item.id);
    let row = liveRows.get(item.id);
    if (!row) {
      row = makeRow();
      liveRows.set(item.id, row);
      els.queueBox.append(row);
    }
    paintRow(row, item, i, total);
  }
  for (const [id, row] of liveRows) {
    if (!wanted.has(id)) {
      row.remove();
      liveRows.delete(id);
    }
  }

  const shown = Math.min(total, last - first + 1);
  els.queueMore.hidden = !virtual;
  if (virtual) els.queueMore.textContent = `Showing ${shown} of ${total} files — scroll for the rest.`;
}

const scheduleDraw = () => {
  if (viewFrame) return;
  viewFrame = requestAnimationFrame(drawRows);
};

els.queueScroll.addEventListener('scroll', scheduleDraw, { passive: true });
window.addEventListener('resize', scheduleDraw);
els.queueScroll.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  onRowAction(button.dataset.act, Number(button.dataset.id));
});

function onRowAction(act, id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (act === 'download' && item.blob) {
    downloadBlob(item.blob, item.outputName || item.name);
  } else if (act === 'retry') {
    item.status = 'pending';
    item.cancelled = false;
    item.error = null;
    item.blob = null;
    item.kept = false;
    item.outputSize = 0;
    // A retry re-reads the CURRENT settings — the row the user is looking at is the one
    // they want fixed with what's selected now.
    item.settings = { ...settings };
    pump();
  } else if (act === 'cancel') {
    item.cancelled = true;
    if (item.status === 'pending') item.status = 'cancelled';
  } else if (act === 'remove') {
    items = items.filter((i) => i.id !== id);
  }
  update();
}

/* ── Painting the summary ───────────────────────────────────────────────────────── */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function update() {
  const s = stats();
  scheduleDraw();

  els.queue.hidden = s.total === 0;
  els.queueCount.textContent = plural(s.total, 'file', 'files');

  const settled = s.done + s.errored + s.cancelled;
  const pct = s.total ? Math.round((settled / s.total) * 100) : 0;
  els.meter.style.width = `${pct}%`;
  els.meterWrap.setAttribute('aria-label', `Batch progress: ${pct}%`);

  const working = s.running > 0 || s.pending > 0;
  els.stopAll.hidden = !working;
  els.saveAll.disabled = s.done === 0;

  paintReclaim(s);
  paintMismatch();
  paintStatus(s, working, settled);
  paintZipWarning(s);
  tap.noteLocalWork(s.done);
}

/**
 * The reclaim readout. Compares like with like — only finished files have an output size,
 * so the ratio uses their inputs, never the whole batch's, or it would read far too good
 * early and creep down as the batch finishes. Shows a saving only when there genuinely is
 * one; otherwise it goes quiet rather than wearing the green over a "+0%".
 */
function paintReclaim(s) {
  els.reclaimIn.textContent = formatBytes(s.doneInput);
  els.reclaimOut.textContent = formatBytes(s.doneOutput);

  const saved = s.doneInput - s.doneOutput;
  if (s.done === 0) {
    els.reclaim.dataset.state = 'idle';
    els.reclaimLabel.textContent = 'Reclaimed';
    els.reclaimBig.textContent = '—';
    return;
  }
  if (saved <= 0) {
    els.reclaim.dataset.state = 'none';
    els.reclaimLabel.textContent = 'Reclaimed';
    els.reclaimBig.textContent = 'Nothing to reclaim';
    return;
  }
  const pctSaved = Math.round((saved / s.doneInput) * 100);
  els.reclaim.dataset.state = 'saved';
  els.reclaimLabel.textContent = s.kept ? `Reclaimed · ${s.kept} kept as-is` : 'Reclaimed';
  els.reclaimBig.textContent = `${formatBytes(saved)} · ${pctSaved}% smaller`;
}

/**
 * Say — plainly and permanently — when rows on screen were made with settings that are no
 * longer selected. Same discipline as the HEIC tool: the "settings apply to new files"
 * model is only honest if the mismatch is a sentence you can read, not a surprise.
 */
function paintMismatch() {
  const stale = staleItems().filter((i) => i.status === 'done');
  els.reconvert.textContent = 'Re-compress all';
  els.reconvert.disabled = stale.length === 0 || items.length === 0;

  if (stale.length === 0) {
    els.mismatch.hidden = true;
    return;
  }
  els.mismatch.hidden = false;
  els.mismatch.textContent =
    `${plural(stale.length, 'file', 'files')} already compressed with earlier settings, and left ` +
    `alone. New files use quality ${settings.quality.toFixed(2)}${
      settings.maxDimension ? `, capped at ${settings.maxDimension} px` : ''
    }. Re-compress all to apply them to everything.`;
}

function paintStatus(s, working, settled) {
  const parts = [];
  if (working) parts.push(`Compressing… ${settled} of ${s.total} done`);
  else if (s.total) parts.push(`${plural(s.done, 'file', 'files')} compressed`);
  if (s.kept) parts.push(`${plural(s.kept, 'file', 'files')} kept original`);
  if (s.errored) parts.push(`${plural(s.errored, 'file', 'files')} failed — retry from the row`);
  if (s.cancelled) parts.push(`${plural(s.cancelled, 'file', 'files')} stopped`);
  els.queueStatus.textContent = parts.join(' · ');
}

function paintZipWarning(s) {
  if (s.done === 0 || canStreamZip()) {
    els.zipWarning.hidden = true;
    return;
  }
  if (s.doneOutput > LIMITS.zipSafeOutputBytes) {
    els.zipWarning.hidden = false;
    els.zipWarning.textContent =
      `That's ${formatBytes(s.doneOutput)} of compressed images — more than a browser will ` +
      `reliably put in a single zip. Save the files individually and they'll all come ` +
      `through. A zip this size can download and still be broken.`;
    return;
  }
  els.zipWarning.hidden = true;
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

const loadZipLib = () => import('../vendor/client-zip.js');

/** Tier 1 (Chromium): stream a zip straight to disk, so its size never matters. */
function canStreamZip() {
  return (
    typeof window !== 'undefined' &&
    typeof window.showSaveFilePicker === 'function' &&
    typeof ReadableStream === 'function' &&
    typeof TransformStream === 'function'
  );
}

/** Unique zip entry names: 'a.jpg' seen twice -> 'a.jpg', then 'a (1).jpg'. */
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

function zipEntries(ready) {
  const used = new Map();
  return ready.map((item) => ({
    name: uniqueName(used, item.outputName || basename(item.name)),
    input: item.blob,
    lastModified: item.file && item.file.lastModified ? new Date(item.file.lastModified) : new Date(),
  }));
}

/**
 * "Save all as zip", best mechanism first — the same two tiers the HEIC tool uses, minus
 * the chunking it needs for gigabyte HEIC batches (compressed output is smaller, so one
 * capped zip is plenty; oversize batches are steered to per-file saves by paintZipWarning).
 *
 * GESTURE-CRITICAL: showSaveFilePicker() needs transient user activation and the first
 * await spends it, so this is called straight from the click handler with no await before
 * the picker.
 */
async function saveAll() {
  const ready = items.filter((i) => i.status === 'done' && i.blob);
  if (ready.length === 0) return;

  const exts = new Set(ready.map((i) => (i.outputName || '').split('.').pop() || ''));
  const baseName = exts.size === 1 ? `images-${[...exts][0]}` : 'images';

  const setBusy = (on, label) => {
    els.saveAll.disabled = on;
    els.saveAll.textContent = on ? label : 'Save all as zip';
  };

  // Tier 1 — stream to disk. Called before any await, on purpose.
  if (canStreamZip()) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: `${baseName}.zip`,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user dismissed — normal
      handle = null;
    }
    if (handle) {
      setBusy(true, 'Saving…');
      try {
        const { makeZip } = await loadZipLib();
        const writable = await handle.createWritable();
        await makeZip(zipEntries(ready)).pipeTo(writable);
        return;
      } catch (err) {
        console.warn('Streaming zip failed; falling back to an in-memory zip.', err);
      } finally {
        setBusy(false);
      }
    }
  }

  // Tier 2 — one in-memory zip. Fine for the sizes a compressor produces.
  setBusy(true, 'Zipping…');
  try {
    const { makeZip } = await loadZipLib();
    const raw = await new Response(makeZip(zipEntries(ready))).blob();
    const blob = raw.slice(0, raw.size, 'application/zip');
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

/* ── Controls ───────────────────────────────────────────────────────────────────── */

/** There is no format control any more — the only readout the quality slider drives is its
 *  own value. `keep` re-encodes PNGs losslessly (quality is ignored there by the encoder),
 *  and JPG/WebP honour it, so the slider stays live for every input. */
function paintQuality() {
  els.qualityOut.textContent = settings.quality.toFixed(2);
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
  paintQuality();
  update();
});
els.quality.addEventListener('change', saveSettings);

buildResizePicker();
paintQuality();

/* ── Queue controls ─────────────────────────────────────────────────────────────── */

els.saveAll.addEventListener('click', () => {
  void saveAll();
});
els.stopAll.addEventListener('click', () => {
  for (const item of items) {
    if (item.status === 'pending' || item.status === 'running') {
      item.cancelled = true;
      if (item.status === 'pending') item.status = 'cancelled';
    }
  }
  update();
});
els.reconvert.addEventListener('click', () => {
  // Re-compress everything under the current settings. The one path that touches finished
  // work, and only ever from an explicit click.
  const files = items.map((i) => i.file).filter(Boolean);
  if (files.length === 0) return;
  items = [];
  liveRows.clear();
  els.queueBox.innerHTML = '';
  addItems(files);
  pump();
});
els.clearAll.addEventListener('click', () => {
  items = [];
  liveRows.clear();
  els.queueBox.innerHTML = '';
  els.queue.hidden = true;
  showError('');
  els.zipWarning.hidden = true;
  els.sizeNote.hidden = true;
  update();
});

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

/* Test hook. Harmless in production; the verification driver needs a way to read the real
   bytes and dimensions the app produced, so it can assert on them instead of on labels. */
window.__compress = {
  version: VERSION,
  get items() {
    return items.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      inputSize: i.inputSize,
      outputSize: i.outputSize,
      outputName: i.outputName,
      outputFormat: i.outputFormat,
      kept: i.kept,
      width: i.width,
      height: i.height,
      error: i.error ? i.error.message : null,
    }));
  },
  get stats() {
    return stats();
  },
  get settings() {
    return { ...settings };
  },
  /** First 16 bytes of an item's output blob, for magic-byte checks. */
  async magic(id) {
    const item = items.find((i) => i.id === id);
    if (!item || !item.blob) return null;
    const buf = await item.blob.slice(0, 16).arrayBuffer();
    return Array.from(new Uint8Array(buf));
  },
  /** Decode an item's output blob back to real pixels and report its true dimensions. */
  async decodedDims(id) {
    const item = items.find((i) => i.id === id);
    if (!item || !item.blob) return null;
    const bmp = await createImageBitmap(item.blob);
    const dims = [bmp.width, bmp.height];
    bmp.close();
    return dims;
  },
  onIdle(fn) {
    onIdle = fn;
  },
};
window.__ready = true;
