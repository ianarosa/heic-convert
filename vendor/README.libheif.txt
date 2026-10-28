NOTICE — libheif (LGPL-3.0)
==========================

This application decodes HEIC/HEIF images in the browser using libheif, and
ships a compiled WebAssembly build of it to end users. Under the GNU Lesser
General Public License, version 3.0, that distribution ("conveying") carries
the obligations recorded here.

Library
-------
  Name            libheif — an ISO/IEC 23008-12 (HEIF/HEIC) image codec.
  Distributed as  libheif-js, an Emscripten (WebAssembly) build of libheif
                  packaged for the browser and Node.js.
  Vendored version  libheif-js 1.19.8
                    (per the package's own convention, the major.minor
                    "1.19" tracks the bundled libheif release; the patch
                    ".8" is the JS packaging.)
  Shipped file    libheif-bundle.mjs  (the libheif-wasm/libheif-bundle.mjs
                  variant, with the .wasm inlined as a base64 data URI).

Unmodified
----------
The library is used UNMODIFIED. vendor/libheif-bundle.mjs is a verbatim,
byte-for-byte copy of node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs
as published on npm. It is loaded as a separate file via a dynamic ES-module
import (js/decode.worker.js), so relinking against a different build of the
library is satisfied by construction: replacing this one file with a
compatible libheif-js build is sufficient (LGPL-3.0 §4(d)(1)/§4(e)).

Source
------
  Pinned npm release   https://www.npmjs.com/package/libheif-js/v/1.19.8
  JS packaging repo    https://github.com/catdad-experiments/libheif-js
  Upstream libheif     https://github.com/strukturag/libheif

License
-------
libheif / libheif-js is licensed under the GNU Lesser General Public License,
version 3.0 (LGPL-3.0). The two license texts LGPL-3.0 §4(b) requires are
kept alongside this notice in the same directory:

  LICENSE.libheif-js.txt   GNU Lesser General Public License v3.0 (verbatim)
  LICENSE.gpl-3.0.txt      GNU General Public License v3.0 (verbatim; the
                           LGPL incorporates and references the GPL)

Keep all three files (this notice and the two license texts) next to
libheif-bundle.mjs when redistributing.
