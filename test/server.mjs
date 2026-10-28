/**
 * Minimal static file server for local testing.
 *
 * Deliberately sends NO COOP/COEP headers — this mirrors plain static hosting
 * (Cloudflare Pages) and proves the decoder does not need cross-origin isolation.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.heic': 'image/heic',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
};

export function createServer(root = ROOT) {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    // Browsers request this unprompted; answering 204 keeps the test's
    // "zero console errors" assertion honest instead of papering over a 404.
    if (rel === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    const file = path.join(root, rel === '/' ? '/index.html' : rel);

    // Don't serve outside the root.
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}

export function listen(root = ROOT) {
  return new Promise((resolve) => {
    const server = createServer(root);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run directly: `node test/server.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { port } = await listen();
  console.log(`serving ${ROOT} at http://127.0.0.1:${port}/`);
}
