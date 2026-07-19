// Drives x.com into fetching the rest of a conversation.
//
// The architectural property that makes this simple: X's timeline is
// virtualised, so scrolling destroys DOM nodes - but we collect from the
// network into an append-only store. Scrolling away never loses data, so the
// driver can scroll freely and never needs to scrape as it goes.
//
// Virtualisation also dictates the loop's shape. Controls further down the
// thread are not in the DOM until scrolled near, and tweets X already sent
// produce no new payloads, so "nothing is loading" means nothing at all until
// the bottom of the page has actually been reached.

import type { PayloadStore } from '../content/store.ts';
import { debug } from '../shared/log.ts';

export type StopReason =
  | 'quiescence'
  | 'cursor'
  | 'cap'
  | 'cancelled'
  | 'rate-limited';

export interface PaginationResult {
  rounds: number;
  tweetsCollected: number;
  stoppedBy: StopReason;
  elapsedMs: number;
  expansionsClicked: number;
}

export interface PaginationOptions {
  maxRounds: number;
  maxWallClockMs: number;
  maxTweets: number;
  /** Click "show more replies" controls, not just scroll. */
  expandCollapsed: boolean;
  onProgress?: (progress: { round: number; tweets: number; elapsedMs: number }) => void;
}

/** Rounds at the bottom with nothing new before we call it done. */
const QUIET_ROUNDS = 3;

/** How long to wait for a payload once there is no more page to traverse. */
const ROUND_TIMEOUT_MS = 1200;

/**
 * How long to wait mid-page.
 *
 * Traversing already-rendered content produces no payloads, so waiting the full
 * timeout every round would spend a minute scrolling a long thread. Short waits
 * here; patience only at the bottom, where fetches actually happen.
 */
const TRAVERSE_WAIT_MS = 150;

/** Distance from the bottom that still counts as being at the bottom. */
const BOTTOM_SLACK_PX = 400;

/** Expansion clicks per round. A conversation never needs more at once. */
const MAX_CLICKS_PER_ROUND = 5;

/** Longest plausible label for a "show more" control. */
const MAX_LABEL_LENGTH = 60;

/**
 * Words that must never appear on something we click.
 *
 * This is the important safety property of this module. X renders "show more
 * replies" cells and "who to follow" modules with the same container shape, and
 * the latter contain Follow buttons - an auto-click that lands on one takes a
 * real action on the user's account. Matching English label text would also
 * simply not work on a non-English UI, so the guards below are structural
 * first, with this list as a backstop rather than the mechanism.
 */
const FORBIDDEN = new RegExp(
  [
    'follow', 'abonn', 'suivre', 'folgen', 'seguir',
    'block', 'bloqu', 'sperren',
    'mute', 'masqu', 'silenciar', 'stumm',
    'delete', 'supprim', 'löschen', 'eliminar',
    'report', 'signal', 'melden', 'denunciar',
    'subscribe', 'premium', 'upgrade', 'abonnement',
    'buy', 'achet', 'pay', 'kauf', 'comprar',
    'repost', 'retweet', 'like', "j'aime", 'aimer',
    'send', 'envoy', 'post', 'reply', 'répondre', 'repondre',
  ].join('|'),
  'i',
);

/**
 * Candidate "show more replies" controls.
 *
 * A control qualifies only if its containing cell looks like a bare expansion
 * row: no article (so it is not a tweet), no image (so it is not a user module
 * - this is what excludes "who to follow"), and a short label that trips none
 * of the words above.
 */
export function expansionControls(
  clicked: WeakSet<Element>,
  root: ParentNode = document,
): Element[] {
  const out: Element[] = [];

  for (const cell of root.querySelectorAll('[data-testid="cellInnerDiv"]')) {
    if (cell.querySelector('article')) continue;
    if (cell.querySelector('img')) continue;
    if (cell.querySelector('[data-testid$="follow"], [data-testid="UserCell"]')) continue;

    const controls = cell.querySelectorAll('[role="button"], button');
    // A genuine expansion row holds exactly one control. More than that is some
    // other module we have not recognised, and we leave it alone.
    if (controls.length !== 1) continue;

    const control = controls[0]!;
    if (clicked.has(control)) continue;

    const label = (control.textContent ?? '').trim();
    if (label === '' || label.length > MAX_LABEL_LENGTH) continue;
    if (FORBIDDEN.test(label)) {
      debug('skipping control with a forbidden label:', label);
      continue;
    }

    out.push(control);
    if (out.length >= MAX_CLICKS_PER_ROUND) break;
  }

  return out;
}

/**
 * Everything the driver touches outside the store.
 *
 * Injected so the loop - which is where the interesting decisions live - can be
 * tested without a browser.
 */
export interface PaginationEnv {
  scrollDown(): void;
  scrollTo(y: number): void;
  scrollY(): number;
  scrollHeight(): number;
  atBottom(): boolean;
  /** Click eligible expansion controls; returns how many actually fired. */
  clickExpansions(clicked: WeakSet<Element>): number;
}

export const browserEnv: PaginationEnv = {
  scrollDown() {
    // Incremental rather than a jump to the bottom: a virtualised list
    // frequently fails to trigger its next fetch on a single large jump.
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'auto' });
  },
  scrollTo(y) {
    window.scrollTo({ top: y, behavior: 'auto' });
  },
  scrollY: () => window.scrollY,
  scrollHeight: () => document.documentElement.scrollHeight,
  atBottom: () =>
    window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - BOTTOM_SLACK_PX,
  clickExpansions(clicked) {
    let fired = 0;
    for (const control of expansionControls(clicked)) {
      clicked.add(control);
      try {
        (control as HTMLElement).click();
        fired += 1;
      } catch {
        /* a control that refuses to be clicked is not worth retrying */
      }
    }
    return fired;
  },
};

export async function drivePagination(
  store: PayloadStore,
  options: PaginationOptions,
  signal: AbortSignal,
  env: PaginationEnv = browserEnv,
  now: () => number = () => Date.now(),
): Promise<PaginationResult> {
  const started = now();
  const startedAtY = env.scrollY();
  const clicked = new WeakSet<Element>();

  let rounds = 0;
  let quiet = 0;
  let expansionsClicked = 0;
  let lastCursor = store.cursorBottom;
  let cursorRepeats = 0;
  let stoppedBy: StopReason = 'quiescence';

  const before = store.tweetCount;

  while (true) {
    if (signal.aborted) {
      stoppedBy = 'cancelled';
      break;
    }
    if (store.rateLimited) {
      // Continuing to scroll into a 429 is both useless and the thing most
      // likely to get an account flagged.
      stoppedBy = 'rate-limited';
      break;
    }
    if (rounds >= options.maxRounds) {
      stoppedBy = 'cap';
      break;
    }
    if (now() - started >= options.maxWallClockMs) {
      stoppedBy = 'cap';
      break;
    }
    if (store.tweetCount >= options.maxTweets) {
      stoppedBy = 'cap';
      break;
    }

    rounds += 1;
    const tweetsBefore = store.tweetCount;
    const heightBefore = env.scrollHeight();

    // Expansion controls only exist in the DOM once scrolled near, so this runs
    // every round rather than once at the start.
    const expanded = options.expandCollapsed ? env.clickExpansions(clicked) : 0;
    expansionsClicked += expanded;

    env.scrollDown();

    const atBottom = env.atBottom();

    // Event-driven rather than a fixed sleep: on a fast connection a round
    // finishes in tens of milliseconds instead of the full timeout.
    await store.waitForChange(atBottom ? ROUND_TIMEOUT_MS : TRAVERSE_WAIT_MS, signal);

    options.onProgress?.({
      round: rounds,
      tweets: store.tweetCount,
      elapsedMs: now() - started,
    });

    // Cursor exhaustion: X keeps handing back the same bottom cursor once there
    // is nothing left to page through. Only meaningful at the bottom, where a
    // fetch would have happened.
    const cursor = store.cursorBottom;
    if (atBottom && cursor !== null && cursor === lastCursor) {
      cursorRepeats += 1;
      if (cursorRepeats >= 2 && store.tweetCount === tweetsBefore) {
        stoppedBy = 'cursor';
        break;
      }
    } else if (cursor !== lastCursor) {
      cursorRepeats = 0;
      lastCursor = cursor;
    }

    const grew =
      store.tweetCount > tweetsBefore || env.scrollHeight() > heightBefore || expanded > 0;

    // The correction that matters: quiet rounds only count once there is no
    // page left to traverse. X sends the whole conversation up front on a
    // modest thread, so mid-page rounds legitimately produce nothing new - and
    // counting those as quiescence stopped the run two viewports in, before
    // ever reaching the folded "show replies" controls further down.
    quiet = grew || !atBottom ? 0 : quiet + 1;
    if (quiet >= QUIET_ROUNDS) {
      stoppedBy = 'quiescence';
      break;
    }
  }

  // Put the reader back where they were. Scrolling their page out from under
  // them and leaving it there is rude.
  env.scrollTo(startedAtY);

  const result: PaginationResult = {
    rounds,
    tweetsCollected: store.tweetCount - before,
    stoppedBy,
    elapsedMs: now() - started,
    expansionsClicked,
  };
  debug('pagination', result);
  return result;
}

/**
 * Did collection reach the end of the conversation?
 *
 * Quiescence and cursor exhaustion both mean there was nothing left to fetch.
 * Everything else stopped early, and the document is missing tweets that exist.
 */
export function completenessOf(result: PaginationResult): 'complete' | 'partial' {
  return result.stoppedBy === 'quiescence' || result.stoppedBy === 'cursor'
    ? 'complete'
    : 'partial';
}

/**
 * How the run ended, in the user's terms. Never a bare "Done." - a run that
 * stopped at a cap produced an incomplete document and should say so.
 */
export function describeStop(result: PaginationResult): string | null {
  switch (result.stoppedBy) {
    case 'quiescence':
    case 'cursor':
      return null;
    case 'cap':
      return 'Stopped at a collection limit. The thread may be incomplete.';
    case 'cancelled':
      return 'Cancelled. Exporting what was collected so far.';
    case 'rate-limited':
      return 'X rate-limited the page. Exporting what was collected so far.';
  }
}
