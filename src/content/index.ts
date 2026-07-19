// ISOLATED-world entry point. Wires bridge -> store -> UI -> export.
//
// Ordering here is deliberate and load-bearing. This script runs at
// document_start, so:
//
//   - The bridge listener registers FIRST. Capture is the one thing that cannot
//     be retried: if a payload arrives before we are listening, it is gone.
//   - Everything touching the DOM waits for document.body, which does not exist
//     yet at document_start.
//   - Every UI call is wrapped. A broken button must degrade to "no button",
//     never to a dead content script — an uncaught throw at module scope aborts
//     the rest of the file, taking the capture path down with it.

import { listen } from './bridge.ts';
import { PayloadStore } from './store.ts';
import { watchRoute } from './route.ts';
import { Ui } from './ui.ts';
import { runExport } from './export.ts';
import { scrapeDom } from '../parse/dom.ts';
import { drivePagination, describeStop, completenessOf } from '../thread/paginate.ts';
import { loadSettings, onSettingsChanged, DEFAULTS } from '../shared/config.ts';
import type { Settings } from '../shared/config.ts';
import { setDebug, debug, warn } from '../shared/log.ts';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages.ts';

// --- capture: registered before anything that can fail ----------------------

const store = new PayloadStore();

listen((message) => store.accept(message));

store.onPayload((_json, meta) => {
  debug('payload', meta.operation, 'status', meta.status, '->', store.tweetCount, 'tweets');
});

// --- settings ---------------------------------------------------------------

let settings: Settings = DEFAULTS;

void (async () => {
  try {
    settings = await loadSettings();
    setDebug(settings.debug);
    store.setRetainRaw(settings.debug);
    debug('content script ready', __VERSION__);
  } catch (err) {
    warn('settings load failed; using defaults', err);
  }
})();

onSettingsChanged((next) => {
  settings = next;
  setDebug(next.debug);
  store.setRetainRaw(next.debug);
});

// --- UI ---------------------------------------------------------------------

let ui: Ui | null = null;
let focalId: string | null = null;
let bodyReady = false;
let running = false;

/**
 * Resolve once document.body exists.
 *
 * Not DOMContentLoaded: body appears far earlier than that, and on a page as
 * heavy as x.com waiting for the full parse would leave the button missing for
 * seconds. A childList observer on documentElement catches it as it lands.
 */
function whenBodyReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

let aborter: AbortController | null = null;

/**
 * Marks "we reloaded on purpose, re-run the export once the page is back".
 *
 * sessionStorage rather than a variable: the whole point is to survive the
 * reload, and rather than storage.local because the intent is scoped to this
 * tab and should not outlive it.
 */
const RETRY_KEY = 'x-thread-md:retry-after-reload';

/** `withScroll` false means Alt was held: export what is already captured. */
async function doExport(withScroll: boolean): Promise<void> {
  if (running || !ui || !focalId) return;

  // Catch the orphaned case at the click rather than failing silently deeper in
  // the download path, where the error would be a bare "Extension context
  // invalidated" with no hint of what to do about it.
  if (!contextAlive()) {
    ui.error('The extension was reloaded. Refresh this page to use it again.');
    retire();
    return;
  }

  running = true;
  ui.setBusy(true);
  aborter = new AbortController();

  try {
    if (store.rateLimited) {
      ui.error('X rate-limited the page (HTTP 429). Wait a minute and reload.');
      return;
    }

    let stopNote: string | null = null;
    let collection: 'complete' | 'partial' | 'unknown' = 'unknown';

    if (withScroll && settings.autoScroll) {
      const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
      ui.progress(`Collecting replies… ${store.tweetCount} tweets`, true);

      const result = await drivePagination(
        store,
        {
          maxRounds: settings.maxRounds,
          maxWallClockMs: settings.maxWallClockMs,
          maxTweets: settings.maxTweets,
          expandCollapsed: settings.expandCollapsed,
          onProgress: ({ round, tweets, elapsedMs }) =>
            ui?.progress(
              `Collecting replies… ${tweets} tweets · round ${round}/${settings.maxRounds} · ${seconds(elapsedMs)}`,
              true,
            ),
        },
        aborter.signal,
      );

      stopNote = describeStop(result);
      collection = completenessOf(result);
    }

    ui.progress(`Exporting ${store.tweetCount} tweets…`, false);

    const outcome = await runExport({
      tweets: store.tweets,
      focalId,
      settings,
      version: __VERSION__,
      scrapeDom: () => scrapeDom(document, { metrics: settings.domMetrics }),
      collection,
    });

    if (!outcome.ok) {
      // A reload is the only thing that helps when the payload was missed, so
      // offer it as an action rather than as advice in a message the user then
      // has to act on themselves.
      if (outcome.needsReload) ui.offerReload(outcome.message);
      else ui.error(outcome.message);
      return;
    }

    let message = outcome.message;
    // Say how the collection ended before claiming success: a run that hit a
    // cap produced an incomplete document, and a bare "done" would hide that.
    if (stopNote) message = `${stopNote} ${message}`;
    // A schema drift warning matters more than the success count, so it goes
    // last where it is read.
    if (store.sawLowYield) message += ' Some entries did not parse — X may have changed its schema.';
    ui.done(message);
  } catch (err) {
    warn('export threw', err);
    ui.error(err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
    aborter = null;
    ui.setBusy(false);
  }
}

/** Bring the UI in line with the current route. Never throws. */
function syncUi(): void {
  try {
    if (!bodyReady) return;

    if (!focalId) {
      ui?.unmount();
      ui = null;
      return;
    }

    if (ui) return;
    ui = new Ui({
      onExport: (plain) => void doExport(plain),
      onCancel: () => {
        // The toast's action button is "Reload" after a missed capture and
        // "Cancel" the rest of the time.
        if (ui?.reloadOffered) {
          try {
            sessionStorage.setItem(RETRY_KEY, focalId ?? '');
          } catch {
            // Private browsing can refuse sessionStorage. Reload anyway; the
            // user just has to click export again afterwards.
          }
          location.reload();
          return;
        }
        if (aborter) aborter.abort();
        else ui?.hide();
      },
    });
    ui.mount();
    // Unconditional in dev builds: diagnosing "the button is missing" should not
    // itself require turning on a setting.
    if (__DEV__) console.debug('[x-thread-md] UI mounted for', focalId);
  } catch (err) {
    // A missing button is an inconvenience. A dead content script means no
    // capture at all, which is unrecoverable without a reload.
    warn('UI failed to mount; capture continues without it', err);
    ui = null;
  }
}

/**
 * False once this content script has been orphaned.
 *
 * Reloading the extension (or updating it) invalidates the context of scripts
 * already injected into open tabs. They keep running, but every browser.* call
 * fails and the UI they own is inert. Accessing runtime.id is the cheapest way
 * to notice; it throws rather than returning undefined in some Firefox
 * versions, hence the try.
 */
function contextAlive(): boolean {
  try {
    return typeof browser.runtime.id === 'string';
  } catch {
    return false;
  }
}

let stopWatching: (() => void) | null = null;
let livenessTimer: ReturnType<typeof setInterval> | null = null;

/** Tear down an orphaned instance so it stops leaving a dead button on screen. */
function retire(): void {
  debug('extension context invalidated; retiring this content script');
  stopWatching?.();
  stopWatching = null;
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = null;
  try {
    ui?.unmount();
  } catch {
    /* nothing left to do about it */
  }
  ui = null;
}

// The route watcher only fires on navigation, so orphaning would go unnoticed
// on a tab left sitting on one thread — which is exactly the case where a dead
// button accumulates.
livenessTimer = setInterval(() => {
  if (!contextAlive()) retire();
}, 2000);

void whenBodyReady().then(() => {
  bodyReady = true;
  syncUi();

  // Came back from a reload we asked for: re-run the export automatically. The
  // delay lets X issue its TweetDetail request, which the interceptor now
  // catches because it is installed before the page's own scripts.
  let pending: string | null = null;
  try {
    pending = sessionStorage.getItem(RETRY_KEY);
    if (pending !== null) sessionStorage.removeItem(RETRY_KEY);
  } catch {
    /* storage unavailable; nothing to resume */
  }
  if (pending !== null && pending === focalId) {
    debug('resuming export after a requested reload');
    setTimeout(() => void doExport(true), 2500);
  }
});

stopWatching = watchRoute((route) => {
  if (!contextAlive()) {
    retire();
    return;
  }

  const previous = focalId;
  focalId = route.focalId;

  // Navigating between two /status/ pages without a reload: drop the previous
  // conversation so its tweets cannot leak into the next export. The payload
  // for the new one is already in flight, captured by the MAIN-world hook.
  if (previous && previous !== focalId) {
    debug('route changed', previous, '->', focalId);
    store.reset();
  }

  syncUi();
});

// --- debug fixture capture --------------------------------------------------

// Background asks for the retained payloads when the toolbar action is clicked
// in debug mode. This is how fixtures get captured: browse to a thread, click,
// get a JSON file. Re-capturing after an X schema change is then two clicks.
browser.runtime.onMessage.addListener((message) => {
  const request = message as { kind?: string };
  if (request.kind !== 'dump-payloads') return;

  const payloads = store.rawPayloads();
  if (payloads.length === 0) {
    ui?.error('No payloads retained. Turn on Debug in the options, then reload the page.');
    return;
  }

  const dump = {
    exporter: `x-thread-md/${__VERSION__}`,
    capturedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    count: payloads.length,
    payloads,
  };

  const download: RuntimeRequest = {
    kind: 'download',
    filename: `x-thread-md-fixtures-${payloads[payloads.length - 1]?.receivedAt ?? 0}.json`,
    text: JSON.stringify(dump, null, 2),
    saveAs: true,
  };

  return browser.runtime.sendMessage<RuntimeRequest, RuntimeResponse>(download);
});
