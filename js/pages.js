/**
 * pages.js — the entire script budget for a content page.
 *
 * Guides are documents, not applications: they need the colour-scheme toggle to keep
 * working across a navigation and nothing else. So this imports `initRoom` from the
 * app's own ui.js rather than reimplementing it — the toggle then reads the same
 * `safelight.room` localStorage key as the converter, and your room follows you from
 * a guide to the tool and back.
 *
 * It deliberately does NOT import config.js, decode.js or the 1.4 MB libheif bundle.
 * A guide that pulled the decoder down to render a paragraph would be a page that
 * makes network calls to say it doesn't make network calls.
 */
import { initRoom } from './ui.js';

const toggle = document.getElementById('room-toggle');
if (toggle) initRoom(toggle);

/** The test harness waits on this, exactly as it does for the app. */
window.__ready = true;
