/**
 * Browser verification for encode.js + queue.js.
 *
 * Same shape as verify.mjs (which covers decode.js): real headless Chrome via
 * puppeteer-core + system Chrome, real static server with no COOP/COEP, real HEIC in and
 * real bytes asserted on the way out. Nothing here is mocked.
 *
 * Run:  node test/verify.encode.mjs      (Windows node; see test/README.md for WSL paths)
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
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-precise-memory-info', // makes performance.memory usable for the peak-RAM check
  ],
  protocolTimeout: 180000, // the 20-file batch is the long pole
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
  await page.evaluate(() => window.__queue && undefined); // touch it so a bad import surfaces now

  // ── outputFilename ────────────────────────────────────────────────────────────────
  console.log('── outputFilename ──────────────────────────────────────');
  const names = await page.evaluate(() => {
    const f = window.__encode.outputFilename;
    return {
      basic: f('IMG_1234.HEIC', 'image/jpeg'),
      lower: f('img_1234.heic', 'image/jpeg'),
      png: f('IMG_1234.HEIC', 'image/png'),
      webp: f('IMG_1234.HEIC', 'image/webp'),
      dots: f('IMG.1234.heic', 'image/jpeg'),
      noExt: f('no-extension', 'image/jpeg'),
      hidden: f('.hidden', 'image/jpeg'),
      pathy: f('album/sub/IMG_9.HEIC', 'image/jpeg'),
      backslash: f('C:\\photos\\IMG_9.HEIC', 'image/jpeg'),
      traversal: f('../../etc/passwd.heic', 'image/jpeg'),
      empty: f('', 'image/jpeg'),
    };
  });
  ok('IMG_1234.HEIC -> IMG_1234.jpg', names.basic === 'IMG_1234.jpg', names.basic);
  ok('lowercase .heic handled', names.lower === 'img_1234.jpg', names.lower);
  ok('png format -> .png', names.png === 'IMG_1234.png', names.png);
  ok('webp format -> .webp', names.webp === 'IMG_1234.webp', names.webp);
  ok('only the LAST extension is replaced', names.dots === 'IMG.1234.jpg', names.dots);
  ok('extensionless name gets one', names.noExt === 'no-extension.jpg', names.noExt);
  ok('leading dot is not an extension', names.hidden === '.hidden.jpg', names.hidden);
  ok('path components stripped (/)', names.pathy === 'IMG_9.jpg', names.pathy);
  ok('path components stripped (\\)', names.backslash === 'IMG_9.jpg', names.backslash);
  ok('zip-slip traversal defused', names.traversal === 'passwd.jpg', names.traversal);
  ok('empty name gets a fallback', names.empty === 'image.jpg', names.empty);

  // ── encode to JPEG ────────────────────────────────────────────────────────────────
  console.log('\n── encodeBitmap -> JPEG ────────────────────────────────');
  const jpeg = await page.evaluate(async () => {
    const file = await window.__readSample();
    const { bitmap, width, height } = await (await import('/js/decode.js')).decodeHeic(file);

    const t = performance.now();
    const blob = await window.__encode.encodeBitmap(bitmap, { format: 'image/jpeg', quality: 0.85 });
    const ms = performance.now() - t;

    // Decode the OUTPUT back to prove it's a real, openable image.
    const round = await createImageBitmap(blob);
    const out = { rw: round.width, rh: round.height };
    round.close();

    return {
      ms,
      srcW: width, srcH: height,
      type: blob.type,
      size: blob.size,
      magic: await window.__magic(blob, 3),
      tail: Array.from(new Uint8Array(await blob.slice(blob.size - 2).arrayBuffer())),
      bitmapWidthAfter: bitmap.width, // ownership probe: a closed ImageBitmap reports 0
      ...out,
    };
  });
  ok('output MIME is image/jpeg', jpeg.type === 'image/jpeg', jpeg.type);
  ok('JPEG magic bytes FF D8 FF', jpeg.magic[0] === 0xff && jpeg.magic[1] === 0xd8 && jpeg.magic[2] === 0xff,
    jpeg.magic.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  ok('JPEG EOI marker FF D9 at end', jpeg.tail[0] === 0xff && jpeg.tail[1] === 0xd9,
    jpeg.tail.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  ok('output is non-trivial in size', jpeg.size > 20000, `${jpeg.size} bytes`);
  ok('output re-decodes at the source dimensions', jpeg.rw === jpeg.srcW && jpeg.rh === jpeg.srcH,
    `${jpeg.rw} x ${jpeg.rh} (source ${jpeg.srcW} x ${jpeg.srcH})`);
  ok('encodeBitmap CONSUMED the bitmap (closed it)', jpeg.bitmapWidthAfter === 0,
    `bitmap.width after encode = ${jpeg.bitmapWidthAfter}`);
  info(`ENCODE TIME = ${jpeg.ms.toFixed(1)} ms for ${jpeg.srcW}x${jpeg.srcH}`);

  // ── other formats ─────────────────────────────────────────────────────────────────
  console.log('\n── encodeBitmap -> PNG / WebP ──────────────────────────');
  const others = await page.evaluate(async () => {
    const { decodeHeic } = await import('/js/decode.js');
    const one = async (format) => {
      const file = await window.__readSample();
      const { bitmap } = await decodeHeic(file);
      const blob = await window.__encode.encodeBitmap(bitmap, { format, quality: 0.85 });
      return { type: blob.type, size: blob.size, magic: await window.__magic(blob, 8) };
    };
    return { png: await one('image/png'), webp: await one('image/webp') };
  });
  ok('PNG magic bytes 89 50 4E 47',
    others.png.magic[0] === 0x89 && others.png.magic[1] === 0x50 &&
    others.png.magic[2] === 0x4e && others.png.magic[3] === 0x47,
    `${others.png.type}, ${others.png.size} bytes`);
  ok('WebP magic bytes RIFF....WEBP',
    String.fromCharCode(...others.webp.magic.slice(0, 4)) === 'RIFF',
    `${others.webp.type}, ${others.webp.size} bytes`);

  // ── JPEG alpha matte ──────────────────────────────────────────────────────────────
  console.log('\n── JPEG alpha handling (transparent must not go black) ─');
  const matte = await page.evaluate(async () => {
    // Build a bitmap that is fully TRANSPARENT — the exact case that renders black if
    // you encode to JPEG without compositing onto a matte first.
    const c = new OffscreenCanvas(64, 64);
    c.getContext('2d').clearRect(0, 0, 64, 64);
    const transparent = await createImageBitmap(c);

    const blob = await window.__encode.encodeBitmap(transparent, { format: 'image/jpeg', quality: 0.9 });
    const back = await createImageBitmap(blob);
    const rc = new OffscreenCanvas(back.width, back.height);
    const rctx = rc.getContext('2d');
    rctx.drawImage(back, 0, 0);
    const px = rctx.getImageData(0, 0, 64, 64).data;
    back.close();

    // PNG for contrast: alpha must SURVIVE there.
    const c2 = new OffscreenCanvas(64, 64);
    c2.getContext('2d').clearRect(0, 0, 64, 64);
    const t2 = await createImageBitmap(c2);
    const pngBlob = await window.__encode.encodeBitmap(t2, { format: 'image/png' });
    const pngBack = await createImageBitmap(pngBlob);
    const pc = new OffscreenCanvas(64, 64);
    const pctx = pc.getContext('2d');
    pctx.drawImage(pngBack, 0, 0);
    const ppx = pctx.getImageData(0, 0, 64, 64).data;
    pngBack.close();

    return {
      jpegCorner: [px[0], px[1], px[2], px[3]],
      jpegAllWhite: (() => {
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) return false;
        }
        return true;
      })(),
      pngAlpha: ppx[3],
    };
  });
  ok('transparent -> JPEG renders WHITE, not black', matte.jpegAllWhite,
    `corner RGBA = [${matte.jpegCorner.join(', ')}]`);
  ok('transparent -> PNG keeps its alpha (matte is JPEG-only)', matte.pngAlpha === 0,
    `alpha = ${matte.pngAlpha}`);

  // ── maxDimension ──────────────────────────────────────────────────────────────────
  console.log('\n── maxDimension downscaling ────────────────────────────');
  const scaled = await page.evaluate(async () => {
    const { decodeHeic } = await import('/js/decode.js');
    const at = async (maxDimension) => {
      const file = await window.__readSample();
      const { bitmap } = await decodeHeic(file);
      const blob = await window.__encode.encodeBitmap(bitmap, { format: 'image/jpeg', quality: 0.85, maxDimension });
      const back = await createImageBitmap(blob);
      const dims = { w: back.width, h: back.height, size: blob.size };
      back.close();
      return dims;
    };
    return { d800: await at(800), d256: await at(256), d5000: await at(5000) };
  });
  // sample.heic is 1440x960 (3:2). 800/1440 => 800 x 533.
  ok('maxDimension 800 -> 800 x 533 (aspect preserved)',
    scaled.d800.w === 800 && scaled.d800.h === 533, `${scaled.d800.w} x ${scaled.d800.h}, ${scaled.d800.size} bytes`);
  ok('maxDimension 256 -> 256 x 171',
    scaled.d256.w === 256 && scaled.d256.h === 171, `${scaled.d256.w} x ${scaled.d256.h}, ${scaled.d256.size} bytes`);
  ok('maxDimension larger than the image does NOT upscale',
    scaled.d5000.w === 1440 && scaled.d5000.h === 960, `${scaled.d5000.w} x ${scaled.d5000.h}`);
  ok('smaller maxDimension -> smaller file',
    scaled.d256.size < scaled.d800.size && scaled.d800.size < scaled.d5000.size,
    `${scaled.d256.size} < ${scaled.d800.size} < ${scaled.d5000.size} bytes`);

  // ── non-HEIC rejection (magic bytes) ──────────────────────────────────────────────
  console.log('\n── non-HEIC rejection via ftyp sniffing ────────────────');
  const sniff = await page.evaluate(async () => {
    const mk = (bytes, name) => new File([new Uint8Array(bytes)], name);
    const run = async (file) => {
      const q = window.__queue.createQueue({ format: 'image/jpeg' });
      const item = q.add(file);
      await new Promise((res) => { q.start(); const t = setInterval(() => {
        if (item.status === 'done' || item.status === 'error') { clearInterval(t); res(); }
      }, 10); });
      return { status: item.status, message: item.error && item.error.message };
    };

    const ftyp = (brand, compat = []) => {
      const size = 16 + compat.length * 4;
      const out = [ (size >> 24) & 255, (size >> 16) & 255, (size >> 8) & 255, size & 255 ];
      for (const s of ['ftyp', brand, '\0\0\0\0', ...compat]) {
        for (const ch of s) out.push(ch.charCodeAt(0));
      }
      while (out.length < 300) out.push(0);
      return out;
    };

    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(300).fill(0)];
    const txt = Array.from('hello world, this is definitely not a photograph at all', (c) => c.charCodeAt(0));

    return {
      png: await run(mk(png, 'photo.png')),
      text: await run(mk(txt, 'notes.txt')),
      empty: await run(new File([], 'empty.heic')),
      mp4: await run(mk(ftyp('isom', ['isom', 'mp42']), 'movie.mp4')),
      // These must be ACCEPTED by the sniffer (they get past it and fail later, in the
      // decoder, because the body is zeroed — which is the point: sniffing let them in).
      brandHeic: await run(mk(ftyp('heic', ['mif1', 'MiHE']), 'iphone.heic')),
      brandMif1: await run(mk(ftyp('mif1', ['mif1', 'heic']), 'iphone2.heic')),
      brandMiHB: await run(mk(ftyp('mif1', ['MiHB', 'miaf']), 'burst.heic')),
      brandMsf1: await run(mk(ftyp('msf1', ['msf1', 'hevc']), 'live.heic')),
    };
  });
  // The converter is now UNIVERSAL: the input gate (queue.js assertSupportedImage) accepts
  // HEIC/HEIF *and* JPG/PNG/WebP, and rejects only genuinely unsupported input, with the
  // message "…isn't an image this converter can read…". So a PNG is no longer rejected at the
  // gate — it is accepted like a HEIC brand and (with a zeroed body) fails later in the
  // decoder. Plain text and a non-HEIF MP4 still hit the gate.
  const GATE_REJECT = /isn.t an image this converter can read|empty/i;
  const rejectedAtGate = (r) => r.status === 'error' && GATE_REJECT.test(r.message || '');
  const acceptedThenFailedLater = (r) => r.status === 'error' && !GATE_REJECT.test(r.message || '');
  ok('a PNG is ACCEPTED at the gate now (universal converter) — a zeroed body then fails in the decoder',
    acceptedThenFailedLater(sniff.png), JSON.stringify(sniff.png.message));
  ok('plain text is rejected at the gate', rejectedAtGate(sniff.text), JSON.stringify(sniff.text.message));
  ok('empty file is rejected', sniff.empty.status === 'error', JSON.stringify(sniff.empty.message));
  ok('an MP4 (ftyp, but not a HEIF or web-image header) is rejected at the gate',
    rejectedAtGate(sniff.mp4), JSON.stringify(sniff.mp4.message));
  for (const [key, label] of [
    ['brandHeic', 'major heic'], ['brandMif1', 'major mif1 + compatible heic'],
    ['brandMiHB', 'Apple MiHB burst'], ['brandMsf1', 'msf1 sequence (Live Photo)'],
  ]) {
    const r = sniff[key];
    ok(`sniffer ACCEPTS ${label} (fails later in the decoder, not at the gate)`,
      acceptedThenFailedLater(r), JSON.stringify(r.message));
  }

  // ── the 20-file batch ─────────────────────────────────────────────────────────────
  console.log('\n── queue: 20-file batch ────────────────────────────────');
  const batch = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 20 }, (_, i) =>
      new File([blob], `IMG_${String(i).padStart(4, '0')}.HEIC`, { type: 'image/heic', lastModified: Date.now() }));

    const progress = [];
    const startOrder = [];
    const doneOrder = [];
    let allDoneCalls = 0;

    const memBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
    let peak = memBefore;
    const sampler = setInterval(() => {
      if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
    }, 20);

    const q = window.__queue.createQueue({
      format: 'image/jpeg',
      quality: 0.85,
      onItemStart: (i) => startOrder.push(i.id),
      onItemDone: (i) => doneOrder.push({ id: i.id, hasBlob: !!i.blob, name: i.outputName, size: i.outputSize }),
      onProgress: (done, total) => progress.push([done, total]),
      onAllDone: () => { allDoneCalls++; },
    });

    const items = q.addAll(files);
    const statsBefore = q.stats;

    const t = performance.now();
    const finished = new Promise((resolve) => {
      const orig = q.items;
      const check = setInterval(() => {
        if (orig.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(check); resolve(); }
      }, 10);
    });
    q.start();
    await finished;
    const ms = performance.now() - t;
    clearInterval(sampler);

    // Everything is converted; the only ImageBitmaps still alive should be none.
    const memAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;

    return {
      ms,
      count: items.length,
      statsBefore,
      stats: q.stats,
      allDone: items.every((i) => i.status === 'done'),
      allHaveBlobs: items.every((i) => i.blob instanceof Blob && i.blob.size > 0),
      allHaveNames: items.every((i) => /^IMG_\d{4}\.jpg$/.test(i.outputName)),
      allHaveDims: items.every((i) => i.width === 1440 && i.height === 960),
      progress,
      startCount: startOrder.length,
      doneCount: doneOrder.length,
      allDoneCalls,
      firstOut: doneOrder[0],
      totalOut: items.reduce((n, i) => n + (i.outputSize || 0), 0),
      memBeforeMB: memBefore / 1048576,
      peakMB: peak / 1048576,
      memAfterMB: memAfter / 1048576,
      hasMemoryApi: !!performance.memory,
    };
  });

  ok('all 20 items reached status "done"', batch.allDone && batch.count === 20,
    `${batch.stats.done}/${batch.count} done, ${batch.stats.errored} errored`);
  ok('every item has a real output Blob', batch.allHaveBlobs);
  ok('every item has a correct output name', batch.allHaveNames, `e.g. ${batch.firstOut && batch.firstOut.name}`);
  ok('every item recorded source dimensions', batch.allHaveDims, '1440 x 960');
  ok('onItemStart fired once per item', batch.startCount === 20, `${batch.startCount} calls`);
  ok('onItemDone fired once per item', batch.doneCount === 20, `${batch.doneCount} calls`);
  ok('onAllDone fired exactly once', batch.allDoneCalls === 1, `${batch.allDoneCalls} calls`);
  ok('onProgress is monotonic and ends at total',
    batch.progress.every((p, i) => i === 0 || p[0] >= batch.progress[i - 1][0]) &&
    batch.progress[batch.progress.length - 1][0] === 20 &&
    batch.progress.every((p) => p[1] === 20),
    `${batch.progress.length} calls, last = [${batch.progress[batch.progress.length - 1]}]`);
  ok('stats.total correct before running', batch.statsBefore.total === 20 && batch.statsBefore.pending === 20,
    `total=${batch.statsBefore.total} pending=${batch.statsBefore.pending}`);
  ok('stats after: done=20 errored=0 pending=0 running=0',
    batch.stats.done === 20 && batch.stats.errored === 0 && batch.stats.pending === 0 && batch.stats.running === 0,
    JSON.stringify({ ...batch.stats, inputBytes: undefined, outputBytes: undefined }));
  ok('stats.inputBytes matches the real input',
    batch.stats.inputBytes === 293608 * 20, `${batch.stats.inputBytes} bytes`);
  ok('stats.outputBytes matches the sum of the output blobs',
    batch.stats.outputBytes === batch.totalOut && batch.totalOut > 0, `${batch.stats.outputBytes} bytes`);

  const perImage = batch.ms / 20;
  info('');
  info(`THROUGHPUT: 20 files in ${batch.ms.toFixed(0)} ms  =  ${perImage.toFixed(1)} ms/image  =  ${(1000 / perImage).toFixed(1)} img/sec`);
  info(`INPUT  ${(batch.stats.inputBytes / 1048576).toFixed(2)} MB  ->  OUTPUT ${(batch.stats.outputBytes / 1048576).toFixed(2)} MB  (${((batch.stats.outputBytes / batch.stats.inputBytes) * 100).toFixed(0)}% of input)`);
  info(`avg output = ${(batch.stats.outputBytes / 20 / 1024).toFixed(0)} KB/image at quality 0.85`);
  if (batch.hasMemoryApi) {
    info(`JS HEAP: ${batch.memBeforeMB.toFixed(1)} MB before -> peak ${batch.peakMB.toFixed(1)} MB -> ${batch.memAfterMB.toFixed(1)} MB after`);
    info('(NB: ImageBitmap pixels live OUTSIDE the JS heap, so this understates real RSS.)');
  }
  info(`extrapolated: 200 files ~ ${((batch.ms / 20) * 200 / 1000).toFixed(0)}s, ~${((batch.stats.outputBytes / 20) * 200 / 1048576).toFixed(0)} MB of output`);

  // ── failure isolation ─────────────────────────────────────────────────────────────
  console.log('\n── failure isolation (bad files in a good batch) ───────');
  const isolation = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const sampleBuf = await blob.arrayBuffer();

    const files = [];
    for (let i = 0; i < 5; i++) files.push(new File([blob], `good_${i}.HEIC`, { type: 'image/heic' }));
    // 1. not a HEIC at all -> rejected by the sniffer
    files.push(new File([new Uint8Array(4000).fill(65)], 'garbage.txt', { type: 'text/plain' }));
    // 2. passes the ftyp sniff but the bitstream is truncated -> rejected by the DECODER
    files.push(new File([sampleBuf.slice(0, 4000)], 'truncated.heic', { type: 'image/heic' }));
    // 3. empty
    files.push(new File([], 'empty.heic', { type: 'image/heic' }));
    for (let i = 5; i < 10; i++) files.push(new File([blob], `good_${i}.HEIC`, { type: 'image/heic' }));

    const errored = [];
    const q = window.__queue.createQueue({
      format: 'image/jpeg',
      onItemError: (item, err) => errored.push({ name: item.name, message: err.message }),
    });
    const items = q.addAll(files);
    const finished = new Promise((resolve) => {
      const t = setInterval(() => {
        if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); resolve(); }
      }, 10);
    });
    q.start();
    await finished;

    return {
      stats: q.stats,
      goodAllDone: items.filter((i) => i.name.startsWith('good_')).every((i) => i.status === 'done' && i.blob),
      badAllErrored: items.filter((i) => !i.name.startsWith('good_')).every((i) => i.status === 'error'),
      errored,
      errorsAreReadable: errored.every((e) => e.message && e.message.length > 10 && /[a-z]/.test(e.message)),
    };
  });
  ok('all 10 good files still converted', isolation.goodAllDone && isolation.stats.done === 10,
    `${isolation.stats.done}/13 done`);
  ok('all 3 bad files errored (and only them)', isolation.badAllErrored && isolation.stats.errored === 3,
    `${isolation.stats.errored} errored`);
  ok('every error has a human-readable message', isolation.errorsAreReadable);
  for (const e of isolation.errored) info(`${e.name}: ${JSON.stringify(e.message)}`);

  // ── cancellation ──────────────────────────────────────────────────────────────────
  console.log('\n── cancellation ────────────────────────────────────────');
  const cancel = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const files = Array.from({ length: 40 }, (_, i) => new File([blob], `c_${i}.HEIC`, { type: 'image/heic' }));

    let startedCount = 0;
    const q = window.__queue.createQueue({
      format: 'image/jpeg',
      concurrency: 2,
      onItemStart: () => { startedCount++; },
    });
    const items = q.addAll(files);
    q.start();

    // Let a couple of items get going, then pull the plug.
    await new Promise((r) => setTimeout(r, 120));
    const startedAtCancel = startedCount;
    const doneAtCancel = q.stats.done;
    q.cancel();

    // Give it plenty of time to (incorrectly) keep working if cancellation is broken.
    await new Promise((r) => setTimeout(r, 800));

    const startedAfter = startedCount;
    const settled = items.every((i) => i.status !== 'pending' && i.status !== 'running');

    return {
      startedAtCancel, startedAfter, doneAtCancel,
      settled,
      stats: q.stats,
      // How many items did we AVOID even starting? Should be most of the 40.
      neverStarted: 40 - startedAfter,
    };
  });
  ok('cancel() stops scheduling new work',
    cancel.startedAfter <= cancel.startedAtCancel + 2,
    `${cancel.startedAtCancel} started at cancel -> ${cancel.startedAfter} total started (concurrency 2: at most the 2 in flight may still finish)`);
  ok('most of the batch was never started', cancel.neverStarted > 30, `${cancel.neverStarted}/40 never started`);
  ok('no item is left pending or running after cancel', cancel.settled,
    JSON.stringify({ pending: cancel.stats.pending, running: cancel.stats.running }));
  ok('cancelled items are marked "cancelled"', cancel.stats.cancelled > 30, `${cancel.stats.cancelled} cancelled`);

  // ── cancelItem / retryItem / remove / clear ───────────────────────────────────────
  console.log('\n── cancelItem / retryItem / remove / clear ─────────────');
  const ops = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    const mk = (n) => new File([blob], n, { type: 'image/heic' });

    // retryItem: a bad file fails, we swap in a good one and retry.
    const q = window.__queue.createQueue({ format: 'image/jpeg' });
    const bad = q.add(new File([new Uint8Array(2000).fill(1)], 'bad.txt'));
    q.start();
    await new Promise((r) => { const t = setInterval(() => { if (bad.status === 'error') { clearInterval(t); r(); } }, 10); });
    const afterError = bad.status;
    bad.file = mk('now-good.heic'); // pretend the user re-picked the file
    q.retryItem(bad.id);
    await new Promise((r) => { const t = setInterval(() => { if (bad.status === 'done' || bad.status === 'error') { clearInterval(t); r(); } }, 10); });
    const afterRetry = { status: bad.status, hasBlob: !!bad.blob, errorCleared: bad.error === undefined };

    // cancelItem on a pending item
    const q2 = window.__queue.createQueue({ format: 'image/jpeg', concurrency: 1 });
    const a = q2.add(mk('a.heic'));
    const b = q2.add(mk('b.heic'));
    q2.cancelItem(b.id);
    q2.start();
    await new Promise((r) => { const t = setInterval(() => { if (a.status === 'done') { clearInterval(t); r(); } }, 10); });
    const cancelItemResult = { a: a.status, b: b.status };

    // remove
    const q3 = window.__queue.createQueue({ format: 'image/jpeg' });
    const r1 = q3.add(mk('r1.heic'));
    q3.add(mk('r2.heic'));
    const beforeRemove = q3.stats.total;
    q3.remove(r1.id);
    const afterRemove = q3.stats.total;

    // clear
    q3.clear();
    const afterClear = q3.stats.total;

    return { afterError, afterRetry, cancelItemResult, beforeRemove, afterRemove, afterClear, itemsLen: q3.items.length };
  });
  ok('a bad item goes to "error"', ops.afterError === 'error', ops.afterError);
  ok('retryItem() re-runs it and it succeeds', ops.afterRetry.status === 'done' && ops.afterRetry.hasBlob,
    JSON.stringify(ops.afterRetry));
  ok('retryItem() clears the previous error', ops.afterRetry.errorCleared);
  ok('cancelItem() on a pending item keeps it out of the run',
    ops.cancelItemResult.a === 'done' && ops.cancelItemResult.b === 'cancelled', JSON.stringify(ops.cancelItemResult));
  ok('remove() drops the item', ops.beforeRemove === 2 && ops.afterRemove === 1, `${ops.beforeRemove} -> ${ops.afterRemove}`);
  ok('clear() empties the queue', ops.afterClear === 0 && ops.itemsLen === 0);

  // ── zipItems ──────────────────────────────────────────────────────────────────────
  console.log('\n── zipItems ────────────────────────────────────────────');
  const zip = await page.evaluate(async () => {
    const blob = await (await fetch('/test/sample.heic')).blob();
    // Include a DUPLICATE name to prove entries get de-duplicated rather than clobbered.
    const files = Array.from({ length: 8 }, (_, i) =>
      new File([blob], i === 7 ? 'IMG_0000.HEIC' : `IMG_${String(i).padStart(4, '0')}.HEIC`,
        { type: 'image/heic', lastModified: Date.now() }));

    const q = window.__queue.createQueue({ format: 'image/jpeg', quality: 0.85, maxDimension: 800 });
    const items = q.addAll(files);
    await new Promise((resolve) => { q.start(); const t = setInterval(() => {
      if (items.every((i) => i.status === 'done' || i.status === 'error')) { clearInterval(t); resolve(); }
    }, 10); });

    const percents = [];
    const t = performance.now();
    const zipBlob = await window.__queue.zipItems(items, (p) => percents.push(p));
    const ms = performance.now() - t;

    // Re-open the zip we just made with a FRESH JSZip and read the bytes back out.
    const reopened = await window.__JSZip.loadAsync(zipBlob);
    const entryNames = Object.keys(reopened.files);
    const firstEntry = await reopened.file(entryNames[0]).async('uint8array');

    // Also confirm an entry really decodes as an image.
    const entryBlob = new Blob([firstEntry], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(entryBlob);
    const dims = { w: bmp.width, h: bmp.height };
    bmp.close();

    const empty = await (async () => {
      try { await window.__queue.zipItems([], () => {}); return '<<no throw>>'; }
      catch (e) { return e.message; }
    })();

    return {
      ms,
      type: zipBlob.type,
      size: zipBlob.size,
      magic: await window.__magic(zipBlob, 4),
      entryNames,
      entryCount: entryNames.length,
      firstEntryMagic: Array.from(firstEntry.slice(0, 3)),
      dims,
      percents,
      percentsMonotonic: percents.every((p, i) => i === 0 || p >= percents[i - 1]),
      lastPercent: percents[percents.length - 1],
      sumOfBlobs: items.reduce((n, i) => n + (i.outputSize || 0), 0),
      emptyError: empty,
    };
  });
  ok('zip magic bytes PK\\x03\\x04',
    zip.magic[0] === 0x50 && zip.magic[1] === 0x4b && zip.magic[2] === 0x03 && zip.magic[3] === 0x04,
    zip.magic.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  ok('zip MIME is application/zip', zip.type === 'application/zip', zip.type);
  ok('zip contains all 8 entries', zip.entryCount === 8, zip.entryNames.join(', '));
  ok('duplicate filenames are de-duplicated, not clobbered',
    zip.entryNames.includes('IMG_0000.jpg') && zip.entryNames.includes('IMG_0000 (1).jpg'));
  ok('zip re-opens and its entries are real JPEGs',
    zip.firstEntryMagic[0] === 0xff && zip.firstEntryMagic[1] === 0xd8 && zip.firstEntryMagic[2] === 0xff);
  ok('an entry decodes back to the expected (downscaled) size',
    zip.dims.w === 800 && zip.dims.h === 533, `${zip.dims.w} x ${zip.dims.h}`);
  ok('onProgress reports monotonic 0..100', zip.percentsMonotonic && zip.lastPercent === 100,
    `${zip.percents.length} calls, last = ${zip.lastPercent}`);
  ok('zipItems() with nothing converted throws a clear error',
    zip.emptyError !== '<<no throw>>' && /no converted images/i.test(zip.emptyError), JSON.stringify(zip.emptyError));
  ok('STORE (no deflate): zip is ~the sum of its payloads',
    zip.size >= zip.sumOfBlobs && zip.size < zip.sumOfBlobs * 1.02,
    `zip ${zip.size} bytes vs ${zip.sumOfBlobs} bytes of JPEG (+${(zip.size - zip.sumOfBlobs)} bytes of framing)`);
  info(`zip of 8 took ${zip.ms.toFixed(0)} ms`);

  // ── zip scaling ───────────────────────────────────────────────────────────────────
  //
  // A zip Blob that merely EXISTS proves nothing: Chrome will hand back a Blob whose
  // backing data is broken, and you only find out when you read it. `zipBlob.size` and
  // even URL.createObjectURL() both still succeed on a broken Blob. So every case here
  // reads the bytes back. (An earlier version of this test asserted only on .size and
  // "passed" at 500 MB — the data was already unreadable. Don't do that.)
  //
  // The wall is the browser's, not JSZip's: allocating plain Blobs with no JSZip anywhere
  // fails the same way at the same threshold, identically in headless and headful Chrome.
  // See the note in js/queue.js.
  console.log('\n── zip scaling probe (bytes READ BACK, not just allocated) ─');
  const scaling = await page.evaluate(async () => {
    // Synthetic ~3 MB payloads ~ a real full-size 12 MP iPhone JPEG at q0.85, so we can
    // push the file count without waiting on hundreds of real decodes.
    const each = 3 * 1024 * 1024;
    const chunk = new Uint8Array(each);
    crypto.getRandomValues(chunk.subarray(0, 65536)); // incompressible-ish head
    const mkItems = (n) => Array.from({ length: n }, (_, i) => ({
      status: 'done',
      name: `IMG_${i}.HEIC`,
      outputName: `IMG_${i}.jpg`,
      blob: new Blob([chunk], { type: 'image/jpeg' }),
      outputSize: each,
      file: { lastModified: Date.now() },
    }));

    const results = [];
    for (const n of [20, 50]) {
      const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
      let peak = before;
      const sampler = setInterval(() => {
        if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
      }, 20);
      const t = performance.now();
      let size = 0, error = null, readable = false;
      try {
        const z = await window.__queue.zipItems(mkItems(n));
        size = z.size;
        // THE point of this test: can we actually get the bytes out again?
        const head = new Uint8Array(await z.slice(0, 4).arrayBuffer());
        const tail = await z.slice(z.size - 4).arrayBuffer(); // forces a real read of the end
        readable = head[0] === 0x50 && head[1] === 0x4b && tail.byteLength === 4;
      } catch (e) {
        error = e.name + ': ' + e.message;
      }
      clearInterval(sampler);
      results.push({
        n, ms: performance.now() - t, size, error, readable,
        peakMB: peak / 1048576,
        payloadMB: (n * each) / 1048576,
        liveMB: (n * each * 2) / 1048576, // sources + the zip are alive at the same time
      });
    }
    return results;
  });
  for (const r of scaling) {
    ok(`zip of ${r.n} x 3 MB JPEGs (${r.payloadMB.toFixed(0)} MB payload, ~${r.liveMB.toFixed(0)} MB live) is READABLE`,
      !r.error && r.size > 0 && r.readable,
      r.error ? r.error : `${(r.size / 1048576).toFixed(0)} MB zip in ${(r.ms / 1000).toFixed(1)}s, JS heap peak ${r.peakMB.toFixed(0)} MB`);
  }

  // ── the ceiling: OBSERVED, NOT ASSERTED ───────────────────────────────────────────
  //
  // Deliberately not an ok() check. The wall is real and reproducible — a standalone
  // probe hit NotReadableError at ~500 MB of live blob data on every attempt, in headless
  // AND headful Chrome, with no JSZip involved — but its exact position MOVES between
  // sessions (a later run read 600 MB back cleanly). It's Chromium's in-memory blob quota
  // interacting with whether blob disk-spill is available, which is environment- and
  // free-memory-dependent. Asserting a number here would just be a flaky test that fails
  // for reasons unrelated to our code. So we measure, print, and let a human read it.
  console.log('\n── the ceiling (OBSERVED — informational, not asserted) ─');
  const ceiling = await page.evaluate(async () => {
    const each = 3 * 1024 * 1024;
    const chunk = new Uint8Array(each);
    const blobs = [];
    // No JSZip, no our code: just Blobs. Whatever this finds is the browser's limit.
    for (let i = 0; i < 250; i++) blobs.push(new Blob([chunk], { type: 'image/jpeg' }));
    let readMB = 0, firstFailAt = -1, error = null;
    for (let i = 0; i < blobs.length; i++) {
      try { readMB += (await blobs[i].arrayBuffer()).byteLength / 1048576; }
      catch (e) { firstFailAt = i; error = e.name; break; }
    }
    return { readMB, firstFailAt, error, totalMB: (250 * each) / 1048576 };
  });
  info(
    ceiling.firstFailAt === -1
      ? `this run: read back all ${ceiling.totalMB.toFixed(0)} MB of live blob data with no failure.`
      : `this run: ${ceiling.error} at blob #${ceiling.firstFailAt}, after ${ceiling.readMB.toFixed(0)} MB of live blob data (of ${ceiling.totalMB.toFixed(0)} MB).`
  );
  info('Previously measured: NotReadableError at ~500 MB live, repeatably, headless and headful.');
  info('The position of the wall MOVES between sessions — treat ~350 MB live as the safe budget.');
  info('=> zipItems() holds sources + zip at once, so its safe OUTPUT budget is ~half that:');
  info('   ~150-175 MB, i.e. ~50-60 full-size 12 MP JPEGs, or 200+ downscaled ones.');
  info('=> A broken Blob still reports the right .size and gives a working object URL —');
  info('   it only fails when the bytes are read, i.e. at the user\'s download.');
  info('');
  info('THIS IS WHY zipItems() IS NO LONGER THE MAIN PATH. queue.js now offers');
  info('streamZipToDisk() (streams to disk, memory flat, 600 MB verified) and');
  info('zipItemsChunked() (capped parts). See test/verify.zip.mjs — it proves a 4x bigger');
  info('zip costs no more memory. zipItems() remains for small batches only.');

  // ── console cleanliness ───────────────────────────────────────────────────────────
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
