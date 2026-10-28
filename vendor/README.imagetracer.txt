NOTICE — imagetracerjs (The Unlicense / public domain)
======================================================

This application can trace a raster image (HEIC, JPG, PNG or WebP) into a real
vector SVG entirely in the browser, using imagetracerjs. The library is pure
JavaScript — no WebAssembly, no network, no build step — so the product's
zero-upload guarantee is preserved: the trace runs on the user's own machine.

Library
-------
  Name             imagetracerjs — a raster image tracer / vectorizer
                   (bitmap → SVG) written in JavaScript.
  Vendored version 1.2.6  (pinned)
  Source           https://github.com/jankovicsandras/imagetracerjs
                   npm:  https://www.npmjs.com/package/imagetracerjs
                   Fetched from https://unpkg.com/imagetracerjs@1.2.6/imagetracer_v1.2.6.js
  Shipped file     imagetracer.js
  Author           András Jankovics (andras@jankovics.net)

Licence
-------
  The Unlicense — the software is released into the PUBLIC DOMAIN. The full text
  is in LICENSE.imagetracer.txt (copied verbatim from the package's own LICENSE
  file, and matching the licence header inside imagetracer_v1.2.6.js).

  NOTE: no attribution is legally required under the Unlicense. We credit the
  library anyway — in this file, in the footer of the converter page, and in
  vendor/README.md — as a matter of courtesy and honesty.

  (The upstream project historically described itself as "Public Domain or MIT";
  the 1.2.6 source and its LICENSE file both ship The Unlicense, so that is what
  is recorded here — the actual licence of the bytes we distribute.)

Vendoring adaptation
--------------------
  The file is imagetracer_v1.2.6.js VERBATIM except for its module-export tail.
  Upstream ends with a UMD block that assigns a browser/worker GLOBAL
  (self.ImageTracer / window.ImageTracer). We replaced only that block so the
  file is a clean ES module with a `default` export (the single ImageTracer
  instance) and pollutes no globals — see the banner at the top of the file.
  None of the tracer's logic is modified.

How it's loaded
---------------
  js/encode.js pulls this in with a DYNAMIC `import('../vendor/imagetracer.js')`
  ONLY inside the SVG trace path — i.e. only when SVG output is actually being
  produced. It is never in the module graph at page load, and a HEIC/JPG/PNG/WebP
  conversion that does not output SVG never fetches it. It is deliberately NOT in
  the service-worker precache (see sw.js): SVG-offline is a nice-to-have that
  becomes available after the first online SVG trace via runtime caching, whereas
  precaching it would make every first-time visitor download a tracer most of
  them never use.
