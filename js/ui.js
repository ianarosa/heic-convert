/**
 * ui.js — the view layer. Everything that reads or writes the DOM lives here; main.js
 * owns the app logic and never touches an element directly.
 *
 * PUBLIC API
 *   formatBytes(n) -> string
 *   createWireTap(els) -> { noteLocalWork(n), destroy() }
 *   createQueueView(opts) -> { render(items, stats), destroy() }
 *   createControls(opts) -> { get(), set(settings) }
 *   setRoom(room) / initRoom(els)
 */

/* ── Formatting ─────────────────────────────────────────────────────────────────── */

const KB = 1024;

/**
 * Bytes -> human string. Uses binary units but the familiar labels, and keeps 1 decimal
 * below 100 so a size ledger doesn't jitter between "2 MB" and "2 MB" while growing.
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < KB) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / KB;
  let unit = 0;
  while (value >= KB && unit < units.length - 1) {
    value /= KB;
    unit++;
  }
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** 1.68 -> "+68%", 0.9 -> "-10%". Sign is the whole point, so it's never dropped. */
export function formatDelta(inputBytes, outputBytes) {
  if (!inputBytes || !outputBytes) return null;
  const pct = Math.round((outputBytes / inputBytes - 1) * 100);
  return { pct, text: `${pct >= 0 ? '+' : ''}${pct}%`, dir: pct > 0 ? 'up' : 'down' };
}

const $ = (sel, root = document) => root.querySelector(sel);

/* ── Room (colour scheme) ───────────────────────────────────────────────────────────
 * The page follows the OS by default. The toggle is an override, remembered, and it is
 * diegetic: you are either at the lightbox or in the darkroom.
 */

const ROOM_KEY = 'safelight.room';

function currentRoom() {
  const forced = document.documentElement.dataset.room;
  if (forced) return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'darkroom' : 'lightbox';
}

export function initRoom(button) {
  const saved = (() => {
    try {
      return localStorage.getItem(ROOM_KEY);
    } catch (_) {
      return null;
    }
  })();
  if (saved === 'darkroom' || saved === 'lightbox') {
    document.documentElement.dataset.room = saved;
  }

  const label = () => {
    const room = currentRoom();
    button.textContent = room === 'darkroom' ? 'Darkroom' : 'Lightbox';
    button.setAttribute(
      'aria-label',
      room === 'darkroom' ? 'Darkroom colours. Switch to lightbox.' : 'Lightbox colours. Switch to darkroom.'
    );
  };

  button.addEventListener('click', () => {
    const next = currentRoom() === 'darkroom' ? 'lightbox' : 'darkroom';
    document.documentElement.dataset.room = next;
    try {
      localStorage.setItem(ROOM_KEY, next);
    } catch (_) {
      /* private mode — the toggle still works for this session */
    }
    label();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
  label();
}

/* ── SIGNATURE: the wire tap ────────────────────────────────────────────────────────
 *
 * The product's claim is "your photos never leave this device". A claim in marketing
 * copy is worth nothing, so this instruments the page and reports what actually went
 * over the wire — live, while you convert.
 *
 * HOW IT IS HONEST, precisely:
 *   • UPLOADED counts the bytes of every request BODY this page sends by any of the four
 *     ways a page can send one: fetch, XMLHttpRequest, sendBeacon, WebSocket. If a body
 *     is of a type we can't size, we do NOT report zero — we mark the panel dirty.
 *   • THIRD-PARTY counts every resource the page loaded from an origin that isn't ours,
 *     via PerformanceObserver — which sees loads we didn't initiate ourselves (a stray
 *     <img>, a font, an injected script). It is buffered, so it catches loads from
 *     before this ran.
 *
 * What it deliberately does NOT claim: that same-origin GETs are zero. They aren't —
 * the page's own HTML, JS and the 1.4 MB decoder come from the server on first load.
 * Those are downloads, not uploads, and after they land there are no more.
 *
 * The panel doesn't ask for blind trust: it points you at the check that can't be faked —
 * DevTools → Network, or airplane mode — and the copy dares you to run it.
 */
export function createWireTap(els) {
  const state = { uploaded: 0, thirdParty: 0, local: 0, dirty: false };
  const origin = location.origin;
  const undo = [];

  const paint = () => {
    els.uploaded.textContent = state.dirty ? '?' : formatBytes(state.uploaded);
    els.uploaded.dataset.dirty = String(state.dirty || state.uploaded > 0);
    els.thirdParty.textContent = String(state.thirdParty);
    els.thirdParty.dataset.dirty = String(state.thirdParty > 0);
    els.local.textContent = String(state.local);
  };

  /** Best-effort byte count of a request body. Returns null when we genuinely can't tell. */
  const sizeOf = (body) => {
    if (body == null) return 0;
    if (typeof body === 'string') return new Blob([body]).size;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return new Blob([body.toString()]).size;
    }
    return null; // FormData, ReadableStream, … — unknown, so say unknown
  };

  const record = (body) => {
    const size = sizeOf(body);
    if (size === null) state.dirty = true;
    else state.uploaded += size;
    paint();
  };

  // fetch
  if (typeof window.fetch === 'function') {
    const real = window.fetch;
    window.fetch = function (input, init) {
      try {
        const body = init && init.body != null ? init.body : input instanceof Request ? input.body : null;
        if (body != null) record(body);
      } catch (_) {
        /* never let the tap break a request */
      }
      return real.apply(this, arguments);
    };
    undo.push(() => {
      window.fetch = real;
    });
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest === 'function') {
    const real = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (body != null) record(body);
      } catch (_) {
        /* ignore */
      }
      return real.apply(this, arguments);
    };
    undo.push(() => {
      XMLHttpRequest.prototype.send = real;
    });
  }

  // sendBeacon — the classic analytics exfil path, so it gets counted too.
  if (navigator.sendBeacon) {
    const real = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        record(data);
      } catch (_) {
        /* ignore */
      }
      return real(url, data);
    };
    undo.push(() => {
      navigator.sendBeacon = real;
    });
  }

  // WebSocket — any open socket is worth flagging even before a byte moves.
  if (typeof window.WebSocket === 'function') {
    const RealWS = window.WebSocket;
    const Patched = function (url, protocols) {
      const socket = protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
      const realSend = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          record(data);
        } catch (_) {
          /* ignore */
        }
        return realSend(data);
      };
      try {
        if (new URL(url, location.href).origin !== origin) {
          state.thirdParty++;
          paint();
        }
      } catch (_) {
        /* ignore */
      }
      return socket;
    };
    Patched.prototype = RealWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = RealWS[k];
    window.WebSocket = Patched;
    undo.push(() => {
      window.WebSocket = RealWS;
    });
  }

  // Every resource load, including ones we didn't initiate.
  let observer = null;
  if (typeof PerformanceObserver === 'function') {
    try {
      observer = new PerformanceObserver((list) => {
        let changed = false;
        for (const entry of list.getEntries()) {
          try {
            if (new URL(entry.name, location.href).origin !== origin) {
              state.thirdParty++;
              changed = true;
            }
          } catch (_) {
            /* data: / blob: URLs — not a network origin */
          }
        }
        if (changed) paint();
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch (_) {
      observer = null;
    }
  }

  const paintConnection = () => {
    const online = navigator.onLine;
    els.connection.textContent = online ? 'Online' : 'Offline';
    // Verb-neutral on purpose: createWireTap is shared by the HEIC converter AND the
    // /compress/ tool, so this string must be true of both ("convert" would be wrong on
    // the compressor). Each page's static HTML default names its own action; this is what
    // renders once JS runs.
    els.connectionNote.textContent = online
      ? 'Turn on airplane mode and try it anyway. Nothing changes.'
      : "You're offline and it still works. That's the whole idea.";
  };
  window.addEventListener('online', paintConnection);
  window.addEventListener('offline', paintConnection);

  paint();
  paintConnection();

  return {
    /** Called by main.js as files finish, so the panel shows work happening at zero cost. */
    noteLocalWork(count) {
      state.local = count;
      paint();
    },
    destroy() {
      for (const fn of undo) fn();
      if (observer) observer.disconnect();
      window.removeEventListener('online', paintConnection);
      window.removeEventListener('offline', paintConnection);
    },
  };
}

/* ── Queue view ─────────────────────────────────────────────────────────────────────
 *
 * WHY WINDOWED: 200 files is the case this product is built for, and 200 rows × a few
 * elements each, re-rendered on every item completion, is where a "calm" batch turns
 * into a janky one. So only the rows you can actually see exist in the DOM. Rows are a
 * fixed height (--row-h) which makes the maths exact rather than a measurement guess.
 *
 * Below LIMITS.virtualizeAbove files the list just grows naturally — no scroll box, no
 * windowing — because a 5-file batch shouldn't be trapped in a 60vh viewport.
 */
export function createQueueView({ root, scroll, box, more, onAction, outputDims, virtualizeAbove, overscan }) {
  let items = [];
  let frame = 0;

  const rowHeight = () => {
    const raw = getComputedStyle(root).getPropertyValue('--row-h');
    return parseFloat(raw) || 60;
  };

  /** @type {Map<number, HTMLElement>} live rows, keyed by item id. */
  const live = new Map();

  const statusText = (item) => {
    switch (item.status) {
      case 'pending':
        return 'Waiting';
      case 'running':
        return 'Converting…';
      case 'cancelled':
        return 'Stopped';
      case 'error':
        return item.error ? item.error.message : 'Something went wrong.';
      case 'done': {
        // item.width/height are the SOURCE dimensions — queue.js fills them in from the
        // decode, before any resize. Printing them next to a resized output told the user
        // "1440 × 960" while the file on disk was 800 × 533. The row must describe the
        // file you get, so ask the caller what actually came out.
        const dims = outputDims ? outputDims(item) : null;
        return dims ? `${dims[0]} × ${dims[1]}` : 'Converted';
      }
      default:
        return '';
    }
  };

  const makeRow = () => {
    const row = document.createElement('li');
    row.className = 'row';
    // The thumb box is ALWAYS in the DOM and always the same size, whether or not a
    // preview exists yet — so a row never reflows when its thumbnail arrives mid-convert.
    // The status dot lives inside it, bottom-left, like a contact sheet's frame marker.
    row.innerHTML = `
      <span class="row__thumb" aria-hidden="true"><span class="row__dot"></span></span>
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
    row.style.transform = `translateY(${index * rowHeight()}px)`;
    row.setAttribute('aria-posinset', String(index + 1));
    row.setAttribute('aria-setsize', String(total));

    // Thumbnail: an object-URL string the queue owns. Feature-detected — off, or not yet
    // generated, means the reserved box just stays empty. We set the <img> src at most
    // once per URL so re-renders during a big batch don't thrash the image decoder.
    const thumb = row.querySelector('.row__thumb');
    if (typeof item.thumbnail === 'string') {
      let img = thumb.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.className = 'row__thumb-img';
        img.width = 40;
        img.height = 40;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        thumb.insertBefore(img, thumb.firstChild);
      }
      if (img.dataset.src !== item.thumbnail) {
        img.dataset.src = item.thumbnail;
        img.src = item.thumbnail;
      }
    } else {
      const img = thumb.querySelector('img');
      if (img) img.remove();
    }

    const name = row.querySelector('.row__name');
    const outName = item.status === 'done' && item.outputName ? item.outputName : item.name;
    if (name.textContent !== outName) name.textContent = outName;

    const meta = row.querySelector('.row__meta');
    const text = statusText(item);
    if (meta.textContent !== text) meta.textContent = text;

    const sizes = row.querySelector('.row__sizes');
    if (item.status === 'done' && item.outputSize) {
      const delta = formatDelta(item.inputSize, item.outputSize);
      sizes.innerHTML = '';
      sizes.append(
        document.createTextNode(`${formatBytes(item.inputSize)} → `),
        Object.assign(document.createElement('b'), { textContent: formatBytes(item.outputSize) })
      );
      if (delta) {
        const span = document.createElement('span');
        span.className = 'ledger__delta';
        span.dataset.dir = delta.dir;
        span.textContent = ` ${delta.text}`;
        sizes.append(span);
      }
    } else {
      sizes.textContent = formatBytes(item.inputSize);
    }

    // Rebuilt rather than diffed: at most ~20 rows are ever on screen, and the actions
    // change with status often enough that diffing them would cost more than it saves.
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

  const draw = () => {
    frame = 0;
    const total = items.length;
    const height = rowHeight();
    const virtual = total > virtualizeAbove;

    scroll.dataset.virtual = String(virtual);
    box.style.height = `${total * height}px`;

    let first = 0;
    let last = total - 1;
    if (virtual) {
      const top = scroll.scrollTop;
      const view = scroll.clientHeight || 1;
      first = Math.max(0, Math.floor(top / height) - overscan);
      last = Math.min(total - 1, Math.ceil((top + view) / height) + overscan);
    }

    const wanted = new Set();
    for (let i = first; i <= last; i++) {
      const item = items[i];
      if (!item) continue;
      wanted.add(item.id);
      let row = live.get(item.id);
      if (!row) {
        row = makeRow();
        live.set(item.id, row);
        box.append(row);
      }
      paintRow(row, item, i, total);
    }

    for (const [id, row] of live) {
      if (!wanted.has(id)) {
        row.remove();
        live.delete(id);
      }
    }

    if (more) {
      const shown = Math.min(total, last - first + 1);
      more.hidden = !virtual;
      if (virtual) more.textContent = `Showing ${shown} of ${total} files — scroll for the rest.`;
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(draw);
  };

  scroll.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  scroll.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    onAction(button.dataset.act, Number(button.dataset.id));
  });

  return {
    render(next) {
      items = next;
      schedule();
    },
    destroy() {
      scroll.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
