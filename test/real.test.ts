// Tests against captured payloads.
//
// The synthetic fixtures prove the parser is internally consistent. These
// fixtures prove our reading of X's schema matches what X actually sends -
// a different and more important claim. When X changes something, this is the
// file that breaks first.
//
// They were captured from live sessions and then anonymised: handles, display
// names, ids, text and media keys are synthetic, while the JSON structure is
// preserved to the byte. The structure is the whole point, and it costs nothing
// to keep a stranger's post out of a public repository.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../src/parse/dispatch.ts';
import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import { setDebug, resetShapes, seenShapeKeys } from '../src/shared/log.ts';
import { loadFixture, assertBlockquotesIntact } from './helpers.ts';

const FOCAL = '2441501452388954281';
const CAPTURED = '2026-07-19T12:07:31.217Z';

async function parse() {
  return dispatch(await loadFixture('real-tweetdetail.json'));
}

describe('real capture - parsing', () => {
  it('parses every eligible entry', async () => {
    const result = await parse();
    assert.equal(result.tweets.length, 25);
    assert.equal(result.yieldRatio, 1, 'a drop here means X changed the timeline envelope');
    assert.ok(result.cursorBottom, 'a bottom cursor must be present for pagination');
  });

  it('recognises every shape it encounters', async () => {
    setDebug(true);
    resetShapes();
    await parse();
    const unknown = seenShapeKeys().filter((k) => !k.startsWith('empty-entry:'));
    setDebug(false);
    assert.deepEqual(unknown, [], `unrecognised GraphQL shapes: ${unknown.join(', ')}`);
  });

  it('recovers the full long-form post, not the truncated full_text', async () => {
    const { tweets } = await parse();
    const focal = tweets.find((t) => t.id === FOCAL)!;
    assert.equal(focal.isLongForm, true);
    assert.ok(focal.text.length > 4000, `note_tweet text was ${focal.text.length} chars`);
    // The truncated legacy.full_text would end in an ellipsis plus a t.co.
    assert.ok(!focal.text.includes('t.co/'), 'no t.co survived expansion');
    assert.equal(focal.text.trimEnd(), focal.text, 'text is trimmed, not cut mid-token');
  });

  it('reads author, metrics and media off the focal tweet', async () => {
    const { tweets } = await parse();
    const focal = tweets.find((t) => t.id === FOCAL)!;
    assert.equal(focal.author.handle, 'ada');
    assert.equal(focal.author.verified, true);
    assert.equal(focal.createdAt, '2026-04-07T13:00:50Z');
    assert.equal(focal.metrics.likes, 207);
    assert.equal(focal.metrics.views, 29080);
    assert.equal(focal.metrics.reliable, true);
    assert.equal(focal.media.length, 1);
    assert.equal(focal.media[0]?.kind, 'photo');
    assert.match(focal.media[0]!.url, /\?format=jpg&name=orig$/);
  });

  it('marks no tweet partial', async () => {
    const { tweets } = await parse();
    const partial = tweets.filter((t) => t.partial).map((t) => t.id);
    assert.deepEqual(partial, [], 'a partial tweet means a field moved in the schema');
  });

  it('gives every tweet an author handle and a permalink', async () => {
    const { tweets } = await parse();
    for (const tweet of tweets) {
      assert.notEqual(tweet.author.handle, '', `tweet ${tweet.id} has no handle`);
      assert.match(tweet.permalink, /^https:\/\/x\.com\/[^/]+\/status\/\d+$/);
    }
  });
});

describe('real capture - assembly', () => {
  it('builds a clean thread with no warnings', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    assert.deepEqual(doc.warnings, []);
    assert.equal(doc.stats.rendered, 25);
    assert.equal(doc.stats.truncated, 0);
    assert.equal(doc.stats.orphans, 0);
  });

  it('detects the two-tweet self-thread', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      [FOCAL, '2441508925661478939'],
    );
    // The author also replies to other people's replies; those are ordinary
    // nested replies, not part of the spine.
    assert.ok(tweets.filter((t) => t.author.handle === 'ada').length > 2);
  });

  it('nests the author replies under the replies they answer', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    const top = doc.root.children.filter((c) => !c.isSelfThread);
    const withNested = top.filter((c) => c.children.length > 0);
    assert.ok(withNested.length >= 5, 'expected several reply chains two deep');
    for (const node of withNested) {
      assert.equal(node.depth, 1);
      assert.equal(node.children[0]?.depth, 2);
    }
  });
});

describe('real capture - rendering', () => {
  it('produces a document whose blockquotes never break', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    assertBlockquotesIntact(renderMarkdown(doc, DEFAULTS, '0.1.0'));
  });

  it('renders depth-2 replies', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    const markdown = renderMarkdown(doc, DEFAULTS, '0.1.0');
    assert.match(markdown, /^> > \*\*\[@ada\]/m);
  });

  it('emits exactly one H1 and one Replies heading', async () => {
    const { tweets } = await parse();
    const doc = assemble(tweets, FOCAL, { ...DEFAULT_CAPS, capturedAt: CAPTURED });
    const markdown = renderMarkdown(doc, DEFAULTS, '0.1.0');
    assert.equal((markdown.match(/^# /gm) ?? []).length, 1);
    assert.equal((markdown.match(/^## Replies$/gm) ?? []).length, 1);
  });
});

describe('real capture - a busy thread with ads', () => {
  async function parseBig() {
    return dispatch(await loadFixture('real-big-thread.json'));
  }

  /**
   * Ad ids read out of the fixture rather than hard-coded.
   *
   * Deriving them keeps the test true across a re-anonymisation or a fresh
   * capture, and it cannot drift out of step with the file the way a list of
   * handles would.
   */
  async function promotedIdsInFixture(): Promise<string[]> {
    const ids: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const record = node as Record<string, unknown>;
      const entryId = typeof record['entryId'] === 'string' ? record['entryId'] : '';
      if (entryId.includes('promoted-tweet')) {
        const item = record['item'] as Record<string, never> | undefined;
        const rest = (item as never as { itemContent?: { tweet_results?: { result?: { rest_id?: string } } } })
          ?.itemContent?.tweet_results?.result?.rest_id;
        if (rest) ids.push(rest);
      }
      Object.values(record).forEach(walk);
    };
    walk(await loadFixture('real-big-thread.json'));
    return ids;
  }

  it('keeps the fixture honest: it really does contain ads to filter', async () => {
    // A fixture that lost its promoted markers would pass the test below for
    // entirely the wrong reason. This is the guard against that.
    const raw = JSON.stringify(await loadFixture('real-big-thread.json'));
    assert.ok(raw.includes('promotedMetadata'), 'fixture no longer exercises ad filtering');
    assert.ok(raw.includes('promoted-tweet'), 'fixture lost the promoted item ids');
    assert.ok((await promotedIdsInFixture()).length >= 3, 'expected several ads to filter');
  });

  it('drops every promoted tweet', async () => {
    // Ads arrive as items inside ordinary conversationthread entries, with
    // `promoted-tweet` in the middle of the item id - not as promoted-* entries,
    // which is what an earlier guess assumed and why they leaked for a while.
    const promoted = new Set(await promotedIdsInFixture());
    const { tweets } = await parseBig();
    const leaked = tweets.filter((t) => promoted.has(t.id));
    assert.deepEqual(leaked.map((t) => t.id), []);
  });

  it('parses the rest cleanly', async () => {
    const result = await parseBig();
    assert.ok(result.tweets.length > 30);
    assert.equal(result.yieldRatio, 1);
    assert.deepEqual(result.tweets.filter((t) => t.partial), []);
    for (const tweet of result.tweets) {
      assert.notEqual(tweet.author.handle, '', `tweet ${tweet.id} has no handle`);
    }
  });
});
