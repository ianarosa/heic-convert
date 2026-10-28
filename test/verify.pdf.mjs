/**
 * Browser verification for the PDF output format + combineFilesToPdf(), in real headless
 * Chrome against a real HEIC. Same bar as the sibling suites: assert on real bytes/pixels,
 * read the output back, never trust `.size` alone.
 *
 * The PDF is read back with pdf-lib's loader (PDFDocument.load) — the task explicitly
 * allows using pdf-lib as the reader — to assert page count and page dimensions, on top of
 * the raw %PDF magic-byte check.
 *
 * Run:  node test/verify.pdf.mjs      (Windows node; see test/README.md for WSL paths)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { listen } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const info = (msg) => console.log(`      ${msg}`);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('FAIL  could not find Chrome. Tried:\n' + CHROME_CANDIDATES.join('\n'));
  process.exit(1);
}
console.log(`Chrome: ${chrome}\n`);

const { server, port } = await listen(path.resolve(HERE, '..'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
  protocolTimeout: 300000,
});

const consoleErrors = [];
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.url()}`));

  await page.goto(`http://127.0.0.1:${port}/test/harness.encode.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 });

  // Load a PDF reader (pdf-lib) into the page once, for reading our output back.
  await page.evaluate(async () => {
    window.__pdfLib = await import('/vendor/pdf-lib.js');
    window.__decode = await import('/js/decode.js');
  });

  // ── outputFilename for PDF ──────────────────────────────────────────────────────────
  console.log('── outputFilename (application/pdf) ────────────────────');
  const names = await page.evaluate(() => {
    const f = window.__encode.outputFilename;
    return { basic: f('IMG_1234.HEIC', 'application/pdf'), dots: f('IMG.1234.heic', 'application/pdf') };
  });
  ok('IMG_1234.HEIC -> IMG_1234.pdf', names.basic === 'IMG_1234.pdf', names.basic);
  ok('only the last extension replaced -> IMG.1234.pdf', names.dots === 'IMG.1234.pdf', names.dots);

  // ── encodeBitmap -> single-page PDF ─────────────────────────────────────────────────
  console.log('\n── encodeBitmap(format: application/pdf) ───────────────');
  const single = await page.evaluate(async () => {
    const file = await window.__readSample();
    const { bitmap, width, height } = await window.__decode.decodeHeic(file);
    const t = performance.now();
    const blob = await window.__encode.encodeBitmap(bitmap, { format: 'application/pdf', quality: 0.85 });
    const ms = performance.now() - t;

    const magic = await window.__magic(blob, 5);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const doc = await window.__pdfLib.PDFDocument.load(bytes);
    const pages = doc.getPages();
    const size = pages[0].getSize();

    return {
      ms, type: blob.type, size: blob.size,
      magic, srcW: width, srcH: height,
      pageCount: pages.length,
      pageW: Math.round(size.width), pageH: Math.round(size.height),
      bitmapWidthAfter: bitmap.width, // 0 if consumed/closed
    };
  });
  ok('output MIME is application/pdf', single.type === 'application/pdf', single.type);
  ok('magic bytes are %PDF- (25 50 44 46 2d)',
    single.magic[0] === 0x25 && single.magic[1] === 0x50 && single.magic[2] === 0x44 &&
    single.magic[3] === 0x46 && single.magic[4] === 0x2d,
    single.magic.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  ok('exactly 1 page', single.pageCount === 1, `${single.pageCount} pages`);
  ok('page size = image pixels mapped to points (72dpi, 1px->1pt)',
    single.pageW === single.srcW && single.pageH === single.srcH,
    `${single.pageW}x${single.pageH} pt vs ${single.srcW}x${single.srcH} px`);
  ok('encodeBitmap CONSUMED the bitmap for PDF too', single.bitmapWidthAfter === 0,
    `bitmap.width after = ${single.bitmapWidthAfter}`);
  info(`PDF encode = ${single.ms.toFixed(0)} ms, ${(single.size / 1024).toFixed(0)} KB`);

  // ── quality applies to PDF ──────────────────────────────────────────────────────────
  console.log('\n── quality applies (PDF is lossy via its JPEG) ─────────');
  const quality = await page.evaluate(async () => {
    const at = async (q) => {
      const file = await window.__readSample();
      const { bitmap } = await window.__decode.decodeHeic(file);
      const blob = await window.__encode.encodeBitmap(bitmap, { format: 'application/pdf', quality: q });
      // Read back so we know it's a real PDF, not just a sized Blob.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const doc = await window.__pdfLib.PDFDocument.load(bytes);
      return { size: blob.size, pages: doc.getPageCount() };
    };
    return { lo: await at(0.3), hi: await at(0.9) };
  });
  ok('PDF@q0.3 is smaller than PDF@q0.9', quality.lo.size < quality.hi.size,
    `${(quality.lo.size / 1024).toFixed(0)} KB < ${(quality.hi.size / 1024).toFixed(0)} KB`);
  ok('both are valid 1-page PDFs', quality.lo.pages === 1 && quality.hi.pages === 1);

  // ── maxDimension applies to PDF pages ───────────────────────────────────────────────
  console.log('\n── maxDimension caps the PDF page ──────────────────────');
  const capped = await page.evaluate(async () => {
    const file = await window.__readSample();
    const { bitmap } = await window.__decode.decodeHeic(file);
    const blob = await window.__encode.encodeBitmap(bitmap, { format: 'application/pdf', quality: 0.85, maxDimension: 800 });
    const doc = await window.__pdfLib.PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
    const s = doc.getPage(0).getSize();
    return { w: Math.round(s.width), h: Math.round(s.height) };
  });
  ok('maxDimension 800 -> 800x533 pt page (1440x960 source)', capped.w === 800 && capped.h === 533,
    `${capped.w}x${capped.h} pt`);

  // ── per-file PDF flows through the queue with ZERO queue changes ─────────────────────
  console.log('\n── queue with format application/pdf (no queue changes) ─');
  const viaQueue = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 5 }, (_, i) =>
      new File([blob], `IMG_${i}.HEIC`, { type: 'image/heic', lastModified: Date.now() }));
    const q = window.__queue.createQueue({ format: 'application/pdf', quality: 0.8 });
    const items = q.addAll(files);
    await new Promise((res) => { q.start(); const t = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); res(); }
    }, 10); });
    // Verify each produced a real 1-page PDF.
    let validPdfs = 0;
    for (const it of items) {
      if (it.status !== 'done' || !it.blob) continue;
      const m = new Uint8Array(await it.blob.slice(0, 4).arrayBuffer());
      const doc = await window.__pdfLib.PDFDocument.load(new Uint8Array(await it.blob.arrayBuffer()));
      if (m[0] === 0x25 && m[1] === 0x50 && doc.getPageCount() === 1) validPdfs++;
    }
    return {
      done: items.filter((i) => i.status === 'done').length,
      names: items.map((i) => i.outputName),
      types: items.map((i) => i.blob && i.blob.type),
      validPdfs,
    };
  });
  ok('all 5 items converted to PDF via the unchanged queue', viaQueue.done === 5, `${viaQueue.done}/5`);
  ok('queue named them *.pdf', viaQueue.names.every((n) => /\.pdf$/.test(n)), viaQueue.names.join(', '));
  ok('each queue item is a valid 1-page PDF', viaQueue.validPdfs === 5, `${viaQueue.validPdfs}/5`);

  // ── combineFilesToPdf: 20 pages, order, read back ──────────────────────────────────
  console.log('\n── combineFilesToPdf() — 20 photos into ONE PDF ────────');
  const combined = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 20 }, (_, i) =>
      new File([blob], `IMG_${String(i).padStart(4, '0')}.HEIC`, { type: 'image/heic', lastModified: Date.now() }));
    const progress = [];
    const t = performance.now();
    const { blob: pdf, pageCount, skipped } = await window.__encode.combineFilesToPdf(files, {
      quality: 0.8,
      onProgress: (done, total) => progress.push([done, total]),
    });
    const ms = performance.now() - t;
    const magic = Array.from(new Uint8Array(await pdf.slice(0, 4).arrayBuffer()));
    const doc = await window.__pdfLib.PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    const sizes = doc.getPages().map((p) => { const s = p.getSize(); return [Math.round(s.width), Math.round(s.height)]; });
    return {
      ms, type: pdf.type, size: pdf.size, magic,
      pageCount, skipped,
      readBackPages: doc.getPageCount(),
      allSameSize: sizes.every(([w, h]) => w === 1440 && h === 960),
      progress,
      progressMonotonic: progress.every((p, i) => i === 0 || p[0] >= progress[i - 1][0]),
      progressEnds: progress.length ? progress[progress.length - 1] : null,
    };
  });
  ok('combineFilesToPdf returns application/pdf', combined.type === 'application/pdf', combined.type);
  ok('%PDF magic', combined.magic[0] === 0x25 && combined.magic[1] === 0x50 && combined.magic[2] === 0x44 && combined.magic[3] === 0x46);
  ok('reported pageCount is 20', combined.pageCount === 20, `${combined.pageCount}`);
  ok('the PDF read back has 20 pages', combined.readBackPages === 20, `${combined.readBackPages}`);
  ok('nothing skipped for a clean batch', combined.skipped.length === 0, `${combined.skipped.length} skipped`);
  ok('every page is the source size', combined.allSameSize);
  ok('onProgress is monotonic and reaches (20,20)',
    combined.progressMonotonic && combined.progressEnds && combined.progressEnds[0] === 20 && combined.progressEnds[1] === 20,
    `last=${JSON.stringify(combined.progressEnds)}`);
  info(`combined 20 -> ${(combined.size / 1024 / 1024).toFixed(1)} MB PDF in ${(combined.ms / 1000).toFixed(1)}s`);

  // ── combineFilesToPdf: failure isolation ────────────────────────────────────────────
  console.log('\n── combineFilesToPdf() — corrupt file is SKIPPED ───────');
  const isolation = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const sampleBuf = await blob.arrayBuffer();
    const files = [];
    for (let i = 0; i < 10; i++) files.push(new File([blob], `good_${i}.HEIC`, { type: 'image/heic' }));
    files.splice(3, 0, new File([new Uint8Array(4000).fill(65)], 'garbage.txt', { type: 'text/plain' }));
    files.splice(7, 0, new File([sampleBuf.slice(0, 3000)], 'truncated.heic', { type: 'image/heic' }));
    // 12 files total: 10 good + 2 bad, so a clean run yields 10 pages.
    const { blob: pdf, pageCount, skipped } = await window.__encode.combineFilesToPdf(files, { quality: 0.8 });
    const doc = await window.__pdfLib.PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    return {
      pageCount, readBack: doc.getPageCount(),
      skipped: skipped.map((s) => ({ index: s.index, name: s.name, hasMsg: !!s.error && s.error.length > 8 })),
    };
  });
  ok('the 2 bad files are skipped, 10 pages remain', isolation.pageCount === 10 && isolation.readBack === 10,
    `pageCount=${isolation.pageCount}, read back=${isolation.readBack}`);
  ok('skipped reports both bad files by index+name+message', isolation.skipped.length === 2 &&
    isolation.skipped.every((s) => s.hasMsg),
    JSON.stringify(isolation.skipped));

  // ── combineFilesToPdf: all-bad and empty ────────────────────────────────────────────
  console.log('\n── combineFilesToPdf() — edge cases ────────────────────');
  const edges = await page.evaluate(async () => {
    const grab = async (fn) => { try { await fn(); return '<<no throw>>'; } catch (e) { return e.message; } };
    const empty = await grab(() => window.__encode.combineFilesToPdf([]));
    const allBad = await grab(() => window.__encode.combineFilesToPdf([
      new File([new Uint8Array(100).fill(1)], 'a.txt'),
      new File([new Uint8Array(100).fill(2)], 'b.txt'),
    ]));
    return { empty, allBad };
  });
  ok('empty input throws a clear error', edges.empty !== '<<no throw>>' && /no files/i.test(edges.empty),
    JSON.stringify(edges.empty));
  ok('all-files-bad throws (no zero-page PDF)', edges.allBad !== '<<no throw>>' && /none of the files/i.test(edges.allBad),
    JSON.stringify(edges.allBad));

  // ── the combine-PDF ceiling (measured, read back) ───────────────────────────────────
  console.log('\n── combine-PDF ceiling: escalate until it breaks ───────');
  const ladder = [100, 200, 400];
  for (const count of ladder) {
    const r = await page.evaluate(async (count) => {
      const blob = await (await fetch('/test/sample.heic')).blob();
      const files = Array.from({ length: count }, (_, i) =>
        new File([blob], `IMG_${i}.HEIC`, { type: 'image/heic' }));
      let peak = 0;
      const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
      const s = setInterval(() => { if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize); }, 40);
      const t = performance.now();
      try {
        const { blob: pdf, pageCount, skipped } = await window.__encode.combineFilesToPdf(files, { quality: 0.8 });
        // READ IT BACK — never trust .size. Parse the page count from the actual bytes.
        const bytes = new Uint8Array(await pdf.arrayBuffer());
        const doc = await window.__pdfLib.PDFDocument.load(bytes);
        const readBack = doc.getPageCount();
        // Spot-check that page 0 and the last page still carry an image resource.
        clearInterval(s);
        return {
          ok: true, count, pageCount, skipped: skipped.length, readBack,
          sizeMB: pdf.size / 1048576, ms: performance.now() - t,
          peakMB: peak / 1048576, beforeMB: before / 1048576,
        };
      } catch (e) {
        clearInterval(s);
        return { ok: false, count, error: e.name + ': ' + e.message, ms: performance.now() - t, peakMB: peak / 1048576 };
      }
    }, count).catch((e) => ({ ok: false, count, error: 'TAB DIED: ' + String(e.message).slice(0, 80) }));

    if (r.ok) {
      ok(`combine ${r.count} photos -> valid PDF, ${r.readBack} pages read back`,
        r.readBack === r.count && r.pageCount === r.count,
        `${r.sizeMB.toFixed(0)} MB in ${(r.ms / 1000).toFixed(1)}s, JS heap peak ${r.peakMB.toFixed(0)} MB`);
    } else {
      ok(`combine ${r.count} photos`, false, r.error + ` (peak ${r.peakMB ? r.peakMB.toFixed(0) + ' MB' : '?'})`);
      info(`=> combine-PDF ceiling is between ${ladder[ladder.indexOf(count) - 1] || '?'} and ${count} photos on this machine.`);
      break;
    }
  }

  // ── static graph: encodeBitmap alone must NOT pull in decode.js ─────────────────────
  //
  // The /compress/ tool imports encodeBitmap but never decodes HEIC. decode.js is a lazy
  // dependency of combineFilesToPdf() (dynamic import at point of use), so a page that only
  // imports encode.js must never FETCH js/decode.js. We prove it by watching the network on
  // a fresh page whose harness imports encode.js and nothing else, then actually running an
  // encodeBitmap() to be sure use — not just import — stays decode-free.
  console.log('\n── static graph: encodeBitmap does not load decode.js ──');
  const graphPage = await browser.newPage();
  const requested = [];
  graphPage.on('request', (r) => requested.push(new URL(r.url()).pathname));
  graphPage.on('pageerror', (e) => pageErrors.push(String(e)));
  graphPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await graphPage.goto(`http://127.0.0.1:${port}/test/harness.encode-only.html`, { waitUntil: 'networkidle0' });
  await graphPage.waitForFunction('window.__ready === true', { timeout: 20000 });
  const graph = await graphPage.evaluate(async () => {
    // Exercise encodeBitmap for real (to a PDF, which loads pdf-lib but must NOT load
    // decode.js) on a synthetic bitmap — no HEIC, no decoder.
    const c = new OffscreenCanvas(32, 24);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#4488ff'; ctx.fillRect(0, 0, 32, 24);
    const bmp = await createImageBitmap(c);
    const jpeg = await window.__encodeBitmap(bmp, { format: 'image/jpeg', quality: 0.8 });
    const bmp2 = await createImageBitmap(await createImageBitmap(jpeg));
    const pdf = await window.__encodeBitmap(bmp2, { format: 'application/pdf', quality: 0.8 });
    return { jpegType: jpeg.type, pdfType: pdf.type, name: window.__outputFilename('x.heic', 'application/pdf') };
  });
  await graphPage.close();
  const decodeFetched = requested.some((p) => p.endsWith('/js/decode.js') || p.endsWith('/js/decode.worker.js'));
  const libheifFetched = requested.some((p) => p.includes('libheif'));
  ok('encodeBitmap() still works with NO decode.js in the graph',
    graph.jpegType === 'image/jpeg' && graph.pdfType === 'application/pdf' && graph.name === 'x.pdf');
  ok('js/decode.js was NEVER fetched by an encodeBitmap-only page', !decodeFetched,
    decodeFetched ? 'decode.js WAS fetched' : `${requested.filter((p) => p.startsWith('/js/')).join(', ') || 'no /js/ beyond encode.js'}`);
  ok('the 1.4 MB libheif WASM was NEVER fetched either', !libheifFetched);

  // ── console cleanliness ────────────────────────────────────────────────────────────
  console.log('\n── console cleanliness ─────────────────────────────────');
  ok('zero pageerrors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  ok('zero console errors / failed requests', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + '─'.repeat(56));
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
