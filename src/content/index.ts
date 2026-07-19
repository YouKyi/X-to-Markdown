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
import type { PaginationResult } from '../thread/paginate.ts';
import type { Completeness } from '../types/model.ts';
import { loadSettings, saveSettings, onSettingsChanged, DEFAULTS } from '../shared/config.ts';
import type { Settings } from '../shared/config.ts';
import { setDebug, debug, warn, seenShapeKeys } from '../shared/log.ts';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages.ts';

// --- capture: registered before anything that can fail ----------------------

const store = new PayloadStore();

listen((message) => store.accept(message));

store.onPayload((_json, meta) => {
  debug('payload', meta.operation, 'status', meta.status, '->', store.tweetCount, 'tweets');
});

// --- settings ---------------------------------------------------------------

let settings: Settings = DEFAULTS;

// Declared up here, ahead of the settings load, because that load pushes the
// reply scope onto the UI as soon as it resolves. Which of the two lands first
// is a race — the UI waits for document.body, the settings for storage — so
// both write, and this one has to be able to see `ui` at all.
let ui: Ui | null = null;

void (async () => {
  try {
    settings = await loadSettings();
    setDebug(settings.debug);
    store.setRetainRaw(settings.debug);
    syncScopeOntoUi();
    debug('content script ready', __VERSION__);
  } catch (err) {
    warn('settings load failed; using defaults', err);
  }
})();

onSettingsChanged((next) => {
  settings = next;
  setDebug(next.debug);
  store.setRetainRaw(next.debug);
  syncScopeOntoUi();
});


/**
 * Push the stored reply scope onto the menu.
 *
 * Called from both the settings load and the UI mount because which of the two
 * finishes first is a race: the UI waits for document.body, the settings for
 * storage. Whichever lands second does the useful write, and the other is a
 * no-op. Wrapped, like every other UI call here — a menu that fails to update
 * must not take down the capture path.
 */
function syncScopeOntoUi(): void {
  try {
    ui?.setIncludeReplies(settings.includeReplies);
  } catch (err) {
    debug('could not sync the reply scope onto the UI', err);
  }
}

// --- UI ---------------------------------------------------------------------

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
 * What the last export actually did, for the debug dump.
 *
 * Kept because the interesting failures are not visible in the payloads alone.
 * The TimelineAddToModule bug looked like `expansionsClicked: 3` against
 * `tweetsCollected: 0` — payloads plus outcome, side by side. Recovering that
 * from a console paste took three round trips through the user; the dump now
 * carries it.
 */
interface RunDiagnostics {
  pagination: PaginationResult | null;
  collection: Completeness;
  outcome: { ok: boolean; message: string; tweets: number; warnings: string[] } | null;
}

let lastRun: RunDiagnostics = { pagination: null, collection: 'unknown', outcome: null };

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
    lastRun = { pagination: null, collection: 'unknown', outcome: null };

    // No point scrolling for replies nobody asked for: the author's spine
    // arrives in the first TweetDetail payload, so this turns an author-thread
    // export into an instant one instead of a minute of auto-scrolling.
    if (withScroll && settings.autoScroll && settings.includeReplies) {
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
      lastRun.pagination = result;
    }
    lastRun.collection = collection;

    ui.progress(`Exporting ${store.tweetCount} tweets…`, false);

    const outcome = await runExport({
      tweets: store.tweets,
      focalId,
      settings,
      version: __VERSION__,
      scrapeDom: () => scrapeDom(document, { metrics: settings.domMetrics }),
      collection,
      collapsedBranches: store.collapsedBranches,
    });

    lastRun.outcome = {
      ok: outcome.ok,
      message: outcome.message,
      tweets: outcome.rendered ?? 0,
      warnings: outcome.warnings ?? [],
    };

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
      onIncludeRepliesChange: (value) => {
        // Applied immediately so the next click acts on it, then persisted.
        // A failed write leaves the toggle working for this page rather than
        // silently reverting under the user.
        settings = { ...settings, includeReplies: value };
        void saveSettings(settings).catch((err) =>
          warn('could not persist the reply scope', err),
        );
      },
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
    syncScopeOntoUi();
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

  // Deliberately NOT resetting the store here.
  //
  // This poll runs every 400ms, while X answers a click with its TweetDetail in
  // roughly 200ms. Clearing on route change therefore destroyed the capture it
  // was meant to make room for: the payload had already arrived, the store was
  // emptied, and the export fell through to the DOM — where it then scraped the
  // *previous* thread's articles, which had not been recycled yet.
  //
  // Isolation between conversations is enforced at export time instead, by
  // conversation id, which is precise and cannot race.
  if (previous && previous !== focalId) debug('route changed', previous, '->', focalId);

  syncUi();
});

// --- debug fixture capture --------------------------------------------------

// Background asks for the retained payloads when the toolbar action is clicked
// in debug mode. This is how fixtures get captured: browse to a thread, click,
// get a JSON file. Re-capturing after an X schema change is then two clicks.
//
// The dump carries the surrounding state as well as the payloads, because the
// payloads alone have repeatedly not been enough to diagnose anything: what was
// wrong with TimelineAddToModule was the *pair* `expansionsClicked: 3` and
// `tweetsCollected: 0`, and reconstructing that from console pastes cost three
// exchanges. Everything below is already in memory at this point; collecting it
// costs nothing and saves a round trip.
//
// Deliberately not included: the rendered Markdown, and anything derived from
// it. A diagnostic file should not be a second copy of the user's content.
//
// None of the fields added around `payloads` can reach a committed fixture:
// tools/prune-fixture.mjs reads `payloads[].url` and `payloads[].json` and
// discards the rest of the wrapper. Keep it that way — this envelope holds the
// user agent and their settings, and the repository is public.
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
    focalId,
    count: payloads.length,

    store: {
      payloadsReceived: store.receivedCount,
      tweets: store.tweetCount,
      cursorBottom: store.cursorBottom,
      rateLimited: store.rateLimited,
      sawLowYield: store.sawLowYield,
      collapsedBranches: store.collapsedBranches,
    },

    lastExport: lastRun,

    // Which payload shapes the parser did not recognise, deduplicated. A schema
    // change shows up here first.
    unrecognisedShapes: seenShapeKeys(),

    settings,

    environment: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      // The like-counter regex broke on a typographic apostrophe in a French
      // UI, so the locale is worth having when a DOM parse looks wrong.
      languages: navigator.languages,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },

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
