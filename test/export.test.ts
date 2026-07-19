import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { focalIdFrom } from '../src/content/route.ts';
import { runExport } from '../src/content/export.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import type { Settings } from '../src/shared/config.ts';
import { tweet, metrics } from './helpers.ts';

const AT = '2026-07-19T14:03:11Z';

/** Captures what the content script would hand to the background page. */
interface Sent {
  kind?: string;
  filename?: string;
  text?: string;
}
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  (globalThis as Record<string, unknown>)['browser'] = {
    runtime: {
      sendMessage: async (message: Sent) => {
        sent.push(message);
        return { ok: true, kind: 'download', downloadId: 1 };
      },
    },
  };
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  action: 'download', // clipboard is unavailable outside a secure browser context
  ...over,
});

describe('focalIdFrom', () => {
  it('extracts the tweet id from a status URL', () => {
    assert.equal(focalIdFrom('/writer/status/2041501452388954281'), '2041501452388954281');
    assert.equal(focalIdFrom('/robin/status/20/photo/1'), '20');
    assert.equal(focalIdFrom('/i/status/20'), '20');
  });

  it('returns null anywhere else on the site', () => {
    for (const path of ['/home', '/writer', '/i/bookmarks', '/', '/search?q=x', '/robin/status/']) {
      assert.equal(focalIdFrom(path), null, path);
    }
  });
});

describe('runExport', () => {
  const root = tweet('1900000000000000000', {
    createdAt: '2026-03-01T10:00:00Z',
    text: 'root',
    metrics: metrics({ likes: 1 }),
  });
  const reply = tweet('1900000000000000001', {
    author: 'alice',
    conversationId: root.id,
    inReplyToId: root.id,
    createdAt: '2026-03-01T10:01:00Z',
    text: 'reply',
    metrics: metrics({ likes: 2 }),
  });

  it('renders and downloads', async () => {
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.downloaded, true);
    assert.match(outcome.message, /^2 tweets downloaded\./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, 'download');
    assert.equal(sent[0]?.filename, '2026-03-01-robin-1900000000000000000.md');
    assert.ok(sent[0]?.text?.startsWith('---\n'));
  });

  it('fails cleanly with nothing captured', async () => {
    const outcome = await runExport({
      tweets: [],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Nothing captured/);
    assert.equal(sent.length, 0);
  });

  it('exports the conversation and warns when the focal tweet is missing', async () => {
    // Step 2 of the degradation ladder: some of the conversation was captured
    // but not the tweet the URL points at.
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: '9999999999999999999',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /Focal tweet missing/);
    assert.match(outcome.markdown!, /^warnings:\n {2}- The focal tweet was not captured/m);
  });

  it('reports truncation caused by the caps', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      tweet((BigInt('1900000000000000010') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: root.id,
        inReplyToId: root.id,
        metrics: metrics({ likes: 0 }),
      }),
    );

    const outcome = await runExport({
      tweets: [root, ...many],
      focalId: root.id,
      settings: settings({ maxChildrenPerNode: 3 }),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /5 not included \(limits\)/);
  });

  it('honours the clipboard-only action by not downloading', async () => {
    const outcome = await runExport({
      tweets: [root],
      focalId: root.id,
      settings: settings({ action: 'clipboard' }),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(sent.length, 0);
    // No clipboard in this environment, so the copy fails and that is reported
    // rather than being silently swallowed.
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Clipboard/);
  });
});

describe('conversation isolation', () => {
  // The bug this pins produced a real, badly wrong document: replies from one
  // thread rendered under another thread's author. The store is append-only
  // across SPA navigation, so after browsing two threads it holds both.
  const threadA = [
    tweet('1900000000000000000', { text: 'thread A root', metrics: metrics({ likes: 1 }) }),
    tweet('1900000000000000001', {
      author: 'alice',
      conversationId: '1900000000000000000',
      inReplyToId: '1900000000000000000',
      text: 'reply in A',
      metrics: metrics({ likes: 1 }),
    }),
  ];
  const threadB = [
    tweet('1900000000000000100', {
      author: 'bob',
      conversationId: '1900000000000000100',
      text: 'thread B root',
      metrics: metrics({ likes: 1 }),
    }),
    tweet('1900000000000000101', {
      author: 'carol',
      conversationId: '1900000000000000100',
      inReplyToId: '1900000000000000100',
      text: 'reply in B',
      metrics: metrics({ likes: 1 }),
    }),
  ];

  it('exports only the conversation the user is looking at', async () => {
    const outcome = await runExport({
      tweets: [...threadA, ...threadB],
      focalId: '1900000000000000100',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.markdown!, /thread B root/);
    assert.match(outcome.markdown!, /reply in B/);
    assert.ok(!outcome.markdown!.includes('thread A root'), 'thread A leaked in');
    assert.ok(!outcome.markdown!.includes('reply in A'), "thread A's reply leaked in");
    assert.match(outcome.message, /^2 tweets/);
  });

  it('does not report the other conversation as orphaned replies', async () => {
    // Before the fix these arrived in the orphan bucket and rendered as
    // top-level replies carrying "parent tweet was not captured".
    const outcome = await runExport({
      tweets: [...threadA, ...threadB],
      focalId: '1900000000000000100',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });
    assert.ok(!outcome.markdown!.includes('parent tweet was not captured'));
  });
});

describe('a stale DOM scrape is refused', () => {
  it('will not export someone else\'s replies under this post', async () => {
    // X had not recycled the previous thread's articles yet, so the scrape
    // returned them without the tweet actually being viewed. Exporting "the
    // rest of the conversation" there is worse than exporting nothing.
    const strangers = [
      tweet('1900000000000000200', { author: 'alice', source: 'dom', partial: true }),
      tweet('1900000000000000201', { author: 'bob', source: 'dom', partial: true }),
    ];

    const outcome = await runExport({
      tweets: [],
      focalId: '1900000000000000999',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
      scrapeDom: () => strangers,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.needsReload, true);
    assert.match(outcome.message, /has not settled/);
  });

  it('still accepts a DOM scrape that does contain the focal tweet', async () => {
    const scraped = [
      tweet('20', { source: 'dom', partial: true, metrics: { ...metrics(), reliable: false } }),
    ];
    const outcome = await runExport({
      tweets: [],
      focalId: '20',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
      scrapeDom: () => scraped,
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /^Degraded export\./);
  });
});

describe('store growth is bounded', () => {
  it('evicts the oldest tweets past the cap', async () => {
    // Not clearing on navigation means a long session accumulates every
    // conversation visited. Isolation is by conversation id at export; this is
    // only about memory.
    const { PayloadStore } = await import('../src/content/store.ts');
    const store = new PayloadStore();

    // BigInt, not Number: these ids are past MAX_SAFE_INTEGER, and plain
    // arithmetic collapses them into collisions — the very hazard assemble.ts
    // sorts around, and one this test fell into on the first attempt.
    const payload = (start: bigint, count: number) => ({
      __xtmd: 1 as const,
      kind: 'graphql' as const,
      url: 'https://x.com/i/api/graphql/abc/TweetDetail',
      status: 200,
      transport: 'fetch' as const,
      body: JSON.stringify({
        data: {
          threaded_conversation_with_injections_v2: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: Array.from({ length: count }, (_, i) => ({
                  entryId: `tweet-${start + BigInt(i)}`,
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: (start + BigInt(i)).toString(),
                          core: { user_results: { result: { rest_id: '1', legacy: { screen_name: 'a', name: 'A' } } } },
                          legacy: {
                            created_at: 'Mon Jun 02 09:00:00 +0000 2025',
                            full_text: 'x',
                            favorite_count: 0, retweet_count: 0, reply_count: 0, quote_count: 0,
                          },
                        },
                      },
                    },
                  },
                })),
              },
            ],
          },
        },
      }),
    });

    for (let batch = 0n; batch < 12n; batch++) {
      store.accept(payload(1900000000000000000n + batch * 500n, 500));
    }

    assert.ok(store.tweetCount <= 5000, `store held ${store.tweetCount}`);
    assert.ok(store.tweetCount >= 4500, 'evicted far more than necessary');
  });
});

describe('runExport — collapsed branches', () => {
  const root = tweet('1900000000000000000', {
    createdAt: '2026-03-01T10:00:00Z',
    text: 'root',
    metrics: metrics({ likes: 1 }),
  });
  const reply = tweet('1900000000000000001', {
    author: 'alice',
    conversationId: root.id,
    inReplyToId: root.id,
    createdAt: '2026-03-01T10:01:00Z',
    text: 'reply',
    metrics: metrics({ likes: 2 }),
  });

  it('warns when the parser saw a branch the collection pass never opened', async () => {
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
      collapsedBranches: 2,
    });

    assert.equal(outcome.ok, true);
    // Observed, not inferred: X marked those branches as having more behind
    // them. Kept distinct from the metrics-derived uncaptured estimate, which
    // is unavailable whenever metrics are null and cannot separate a collapsed
    // branch from replies that were deleted or hidden.
    assert.ok(
      outcome.warnings?.some((w) => w.includes('collapsed')),
      `no collapsed-branch warning in ${JSON.stringify(outcome.warnings)}`,
    );
    assert.ok(sent[0]?.text?.includes('collapsed'), 'the warning reaches the frontmatter');
  });

  it('says nothing when no branch was collapsed', async () => {
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.ok(!outcome.warnings?.some((w) => w.includes('collapsed')));
  });
});

describe('runExport — a collapsed branch means the capture is not complete', () => {
  const root = tweet('1900000000000000000', {
    createdAt: '2026-03-01T10:00:00Z',
    text: 'root',
    metrics: metrics({ likes: 1 }),
  });
  const reply = tweet('1900000000000000001', {
    author: 'alice',
    conversationId: root.id,
    inReplyToId: root.id,
    createdAt: '2026-03-01T10:01:00Z',
    text: 'reply',
    metrics: metrics({ likes: 2 }),
  });

  it('demotes a "complete" collection pass to partial', async () => {
    // The pagination driver reports quiescence when it stops finding new
    // material, which says the scroll loop ended tidily and nothing about
    // whether the conversation is whole. A real export carried
    // `collection: complete` two lines above `replies_not_captured: 105`.
    await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
      collection: 'complete',
      collapsedBranches: 4,
    });

    assert.match(sent[0]?.text ?? '', /^collection: partial$/m);
  });

  it('leaves a genuinely complete pass alone', async () => {
    await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
      collection: 'complete',
    });

    assert.match(sent[0]?.text ?? '', /^collection: complete$/m);
  });
});
