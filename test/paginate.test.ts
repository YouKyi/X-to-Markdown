// Safety tests for the auto-click filter.
//
// This is the only place in the extension that clicks something on the user's
// behalf, and a misfire takes a real, sometimes irreversible action on their
// account. "It only clicks show-more controls" is a claim about behaviour, so
// it gets tested against real DOM rather than asserted in a comment.
//
// linkedom is a devDependency used only here. Nothing third-party ships.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { expansionControls, describeStop, completenessOf } from '../src/thread/paginate.ts';
import type { PaginationResult } from '../src/thread/paginate.ts';

function dom(body: string): ParentNode {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  return document as unknown as ParentNode;
}

const labelsOf = (root: ParentNode): string[] =>
  expansionControls(new WeakSet(), root).map((el) => (el.textContent ?? '').trim());

/** A bare expansion row: no tweet, no avatar, one control. */
const showMore = (label: string) =>
  `<div data-testid="cellInnerDiv"><div role="button" tabindex="0"><span>${label}</span></div></div>`;

describe('expansionControls — what it accepts', () => {
  it('finds a show-more row whatever language it is in', () => {
    const root = dom(
      [
        showMore('Show more replies'),
        showMore('Afficher plus de réponses'),
        showMore('さらに返信を表示'),
        showMore('Mehr Antworten anzeigen'),
      ].join(''),
    );
    // Four rows, four hits: the filter is structural, so a non-English UI is
    // not a second-class case.
    assert.equal(labelsOf(root).length, 4);
  });

  it('caps clicks per round', () => {
    const root = dom(showMore('Show more replies').repeat(20));
    assert.equal(expansionControls(new WeakSet(), root).length, 5);
  });

  it('skips controls already clicked', () => {
    const root = dom(showMore('Show more replies'));
    const clicked = new WeakSet<Element>();
    const [first] = expansionControls(clicked, root);
    assert.ok(first);
    clicked.add(first);
    assert.deepEqual(expansionControls(clicked, root), []);
  });
});

describe('expansionControls — what it refuses', () => {
  it('never returns a Follow button from a who-to-follow module', () => {
    // The collision that motivates this whole filter: same cell container, but
    // it carries an avatar and more than one control.
    const root = dom(`
      <div data-testid="cellInnerDiv">
        <div data-testid="UserCell">
          <img src="avatar.jpg" alt="" />
          <a href="/someone"><span>Someone</span></a>
          <div role="button" data-testid="1234-follow"><span>Follow</span></div>
        </div>
      </div>
    `);
    assert.deepEqual(labelsOf(root), []);
  });

  it('refuses a lone Follow button even with no avatar and no testid', () => {
    // Belt to the structural braces: if a future X layout strips the avatar and
    // the testid, the label list still catches it.
    for (const label of ['Follow', 'Suivre', "S'abonner", 'Folgen', 'Seguir']) {
      assert.deepEqual(labelsOf(dom(showMore(label))), [], label);
    }
  });

  it('refuses destructive and transactional labels', () => {
    for (const label of [
      'Block @someone',
      'Bloquer',
      'Mute this conversation',
      'Delete',
      'Supprimer',
      'Report post',
      'Signaler',
      'Subscribe',
      'Upgrade to Premium',
      'Repost',
      'Reply',
      'Répondre',
    ]) {
      assert.deepEqual(labelsOf(dom(showMore(label))), [], label);
    }
  });

  it('refuses a row containing a tweet', () => {
    const root = dom(`
      <div data-testid="cellInnerDiv">
        <article data-testid="tweet"><div role="button"><span>Show more</span></div></article>
      </div>
    `);
    assert.deepEqual(labelsOf(root), []);
  });

  it('refuses a row containing an image', () => {
    const root = dom(`
      <div data-testid="cellInnerDiv">
        <img src="x.jpg" alt="" />
        <div role="button"><span>Show more replies</span></div>
      </div>
    `);
    assert.deepEqual(labelsOf(root), []);
  });

  it('refuses a row holding more than one control', () => {
    const root = dom(`
      <div data-testid="cellInnerDiv">
        <div role="button"><span>Show more replies</span></div>
        <div role="button"><span>Dismiss</span></div>
      </div>
    `);
    assert.deepEqual(labelsOf(root), []);
  });

  it('refuses an empty or implausibly long label', () => {
    assert.deepEqual(labelsOf(dom(showMore(''))), []);
    assert.deepEqual(labelsOf(dom(showMore('x'.repeat(120)))), []);
  });

  it('refuses controls outside a cell', () => {
    assert.deepEqual(labelsOf(dom('<div role="button"><span>Show more replies</span></div>')), []);
  });
});

describe('describeStop', () => {
  const result = (stoppedBy: PaginationResult['stoppedBy']): PaginationResult => ({
    rounds: 3,
    tweetsCollected: 10,
    stoppedBy,
    elapsedMs: 1000,
    expansionsClicked: 0,
  });

  it('says nothing when collection ran to completion', () => {
    assert.equal(describeStop(result('quiescence')), null);
    assert.equal(describeStop(result('cursor')), null);
  });

  it('is explicit when the result is incomplete', () => {
    // A bare "done" after hitting a cap would hide a truncated document.
    assert.match(describeStop(result('cap'))!, /incomplete/);
    assert.match(describeStop(result('cancelled'))!, /Cancelled/);
    assert.match(describeStop(result('rate-limited'))!, /rate-limited/);
  });
});

// --- the loop ---------------------------------------------------------------

import { drivePagination } from '../src/thread/paginate.ts';
import type { PaginationEnv } from '../src/thread/paginate.ts';
import type { PayloadStore } from '../src/content/store.ts';

/** A store stand-in exposing only what the driver reads. */
function fakeStore(options: { tweets?: number; cursor?: string | null } = {}) {
  return {
    tweetCount: options.tweets ?? 10,
    cursorBottom: options.cursor ?? 'CURSOR',
    rateLimited: false,
    async waitForChange() {
      return false;
    },
  } as unknown as PayloadStore;
}

/**
 * A page `pageHeights` viewports tall that never loads anything new — the exact
 * situation on a thread X delivered in one payload.
 */
function fakeEnv(viewports: number, onRound?: (y: number) => void): PaginationEnv & { y: number } {
  const viewport = 800;
  const height = viewport * viewports;
  const env = {
    y: 0,
    scrollDown() {
      env.y = Math.min(env.y + viewport * 0.8, height - viewport);
      onRound?.(env.y);
    },
    scrollTo(y: number) {
      env.y = y;
    },
    scrollY: () => env.y,
    scrollHeight: () => height,
    atBottom: () => env.y + viewport >= height - 400,
    clickExpansions: () => 0,
  };
  return env;
}

describe('drivePagination — quiescence', () => {
  it('traverses the whole page before calling it quiet', async () => {
    // The bug this pins: X sends the conversation up front, so mid-page rounds
    // produce nothing new. Counting those as quiescence stopped the run two
    // viewports in, never reaching the folded controls further down.
    const env = fakeEnv(20);
    const result = await drivePagination(
      fakeStore(),
      { maxRounds: 150, maxWallClockMs: 60_000, maxTweets: 500, expandCollapsed: false },
      new AbortController().signal,
      env,
      () => 0,
    );

    // Either terminal reason is a complete run; what matters is that it did not
    // stop before traversing the page.
    assert.equal(completenessOf(result), 'complete');
    // 20 viewports at 0.8 each, plus the quiet rounds at the bottom.
    assert.ok(result.rounds > 20, `stopped after only ${result.rounds} rounds`);
  });

  it('stops promptly once the bottom is reached', async () => {
    const env = fakeEnv(1);
    const result = await drivePagination(
      fakeStore(),
      { maxRounds: 150, maxWallClockMs: 60_000, maxTweets: 500, expandCollapsed: false },
      new AbortController().signal,
      env,
      () => 0,
    );
    assert.equal(completenessOf(result), 'complete');
    assert.ok(result.rounds <= 5, `took ${result.rounds} rounds on a one-screen page`);
  });

  it('restores the reader to where they started', async () => {
    const env = fakeEnv(10);
    env.y = 1234;
    await drivePagination(
      fakeStore(),
      { maxRounds: 150, maxWallClockMs: 60_000, maxTweets: 500, expandCollapsed: false },
      new AbortController().signal,
      env,
      () => 0,
    );
    assert.equal(env.y, 1234);
  });
});

describe('drivePagination — stopping', () => {
  const opts = { maxRounds: 150, maxWallClockMs: 60_000, maxTweets: 500, expandCollapsed: false };

  it('honours the round cap', async () => {
    const result = await drivePagination(
      fakeStore(),
      { ...opts, maxRounds: 3 },
      new AbortController().signal,
      fakeEnv(100),
      () => 0,
    );
    assert.equal(result.stoppedBy, 'cap');
    assert.equal(result.rounds, 3);
  });

  it('honours the time budget', async () => {
    let clock = 0;
    const result = await drivePagination(
      fakeStore(),
      { ...opts, maxWallClockMs: 500 },
      new AbortController().signal,
      fakeEnv(100),
      () => (clock += 200),
    );
    assert.equal(result.stoppedBy, 'cap');
  });

  it('stops when the tweet budget is reached', async () => {
    const result = await drivePagination(
      fakeStore({ tweets: 500 }),
      opts,
      new AbortController().signal,
      fakeEnv(100),
      () => 0,
    );
    assert.equal(result.stoppedBy, 'cap');
    assert.equal(result.rounds, 0);
  });

  it('stops immediately on cancellation', async () => {
    const aborter = new AbortController();
    aborter.abort();
    const result = await drivePagination(
      fakeStore(),
      opts,
      aborter.signal,
      fakeEnv(100),
      () => 0,
    );
    assert.equal(result.stoppedBy, 'cancelled');
  });

  it('stops on a rate limit rather than scrolling into it', async () => {
    const store = { ...fakeStore(), rateLimited: true } as unknown as PayloadStore;
    const result = await drivePagination(store, opts, new AbortController().signal, fakeEnv(100), () => 0);
    assert.equal(result.stoppedBy, 'rate-limited');
  });
});

describe('drivePagination — expansion clicking', () => {
  const opts = { maxRounds: 150, maxWallClockMs: 60_000, maxTweets: 500, expandCollapsed: true };

  it('clicks every round, because controls appear as you scroll', async () => {
    // Controls deep in the thread are not in the DOM until scrolled near, so a
    // single pass at the start would miss all of them.
    let rounds = 0;
    const env = { ...fakeEnv(10), clickExpansions: () => (rounds++ < 3 ? 1 : 0) };
    const result = await drivePagination(
      fakeStore(),
      opts,
      new AbortController().signal,
      env,
      () => 0,
    );
    assert.equal(result.expansionsClicked, 3);
    assert.ok(rounds > 3, 'kept looking after the first controls were gone');
  });

  it('does not click when the setting is off', async () => {
    let calls = 0;
    const env = { ...fakeEnv(3), clickExpansions: () => (calls++, 1) };
    const result = await drivePagination(
      fakeStore(),
      { ...opts, expandCollapsed: false },
      new AbortController().signal,
      env,
      () => 0,
    );
    assert.equal(calls, 0);
    assert.equal(result.expansionsClicked, 0);
  });
});
