import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import type { AssembleOptions } from '../src/thread/assemble.ts';
import type { ThreadNode, Tweet } from '../src/types/model.ts';
import { chain, tweet, metrics } from './helpers.ts';

const AT = '2026-07-19T12:00:00Z';
const opts = (over: Partial<AssembleOptions> = {}): AssembleOptions => ({
  ...DEFAULT_CAPS,
  capturedAt: AT,
  ...over,
});

/** Flatten the tree to ids, depth-first, for order assertions. */
function flatten(node: ThreadNode, out: string[] = []): string[] {
  out.push(node.tweet.id);
  for (const child of node.children) flatten(child, out);
  return out;
}

function find(node: ThreadNode, id: string): ThreadNode | null {
  if (node.tweet.id === id) return node;
  for (const child of node.children) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

describe('assemble - self-thread spine', () => {
  it('follows a linear same-author chain', () => {
    const tweets = chain(['robin', 'robin', 'robin']);
    const doc = assemble(tweets, tweets[2]!.id, opts());
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      tweets.map((t) => t.id),
    );
    assert.equal(doc.root.tweet.id, tweets[0]!.id);
  });

  it('stops at the first different author', () => {
    const tweets = chain(['robin', 'robin', 'alice', 'robin']);
    const doc = assemble(tweets, tweets[3]!.id, opts());
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      [tweets[0]!.id, tweets[1]!.id],
    );
    // alice's reply and robin's reply-to-alice are ordinary tree nodes
    assert.equal(find(doc.root, tweets[2]!.id)?.isSelfThread, false);
  });

  it('follows the lowest-ID child on a branched self-thread', () => {
    const root = tweet('1000000000000000000', { author: 'robin' });
    const branchB = tweet('1000000000000000002', {
      author: 'robin',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    const branchA = tweet('1000000000000000001', {
      author: 'robin',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    const doc = assemble([root, branchB, branchA], root.id, opts());
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      [root.id, branchA.id],
      'spine takes the lower id; the other branch stays an ordinary reply',
    );
    assert.equal(find(doc.root, branchB.id)?.isSelfThread, false);
  });

  it('matches authors by handle when user ids are absent (DOM fallback)', () => {
    const a = tweet('1000000000000000000', {
      author: { id: null, handle: 'Robin', name: 'Robin', avatarUrl: null, verified: null },
      source: 'dom',
    });
    const b = tweet('1000000000000000001', {
      author: { id: null, handle: 'robin', name: 'Robin', avatarUrl: null, verified: null },
      source: 'dom',
      conversationId: a.id,
      inReplyToId: a.id,
    });
    const doc = assemble([a, b], a.id, opts());
    assert.equal(doc.selfThread.length, 2, 'handle comparison is case-insensitive');
  });
});

describe('assemble - sibling ordering', () => {
  it('orders by Snowflake id, not insertion order', () => {
    const root = tweet('1900000000000000000');
    const ids = ['1900000000000000009', '1900000000000000003', '1900000000000000007'];
    const replies = ids.map((id) =>
      tweet(id, { author: 'alice', conversationId: root.id, inReplyToId: root.id }),
    );
    const doc = assemble([root, ...replies], root.id, opts());
    assert.deepEqual(
      doc.root.children.map((c) => c.tweet.id),
      ['1900000000000000003', '1900000000000000007', '1900000000000000009'],
    );
  });

  it('orders ids beyond Number.MAX_SAFE_INTEGER correctly', () => {
    // These two differ only in the last digit and both exceed 2^53.
    const root = tweet('1948573926184756000');
    const later = tweet('1948573926184756002', {
      author: 'alice',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    const earlier = tweet('1948573926184756001', {
      author: 'alice',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    assert.equal(
      Number(later.id),
      Number(earlier.id),
      'precondition: both ids collapse to the same value as Number, so only BigInt can order them',
    );
    const doc = assemble([root, later, earlier], root.id, opts());
    assert.deepEqual(
      doc.root.children.map((c) => c.tweet.id),
      [earlier.id, later.id],
    );
  });

  it('falls back to createdAt for non-numeric ids', () => {
    const root = tweet('root');
    const second = tweet('bbb', {
      author: 'alice',
      conversationId: 'root',
      inReplyToId: 'root',
      createdAt: '2026-02-02T00:00:00Z',
    });
    const first = tweet('aaa', {
      author: 'alice',
      conversationId: 'root',
      inReplyToId: 'root',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const doc = assemble([root, second, first], 'root', opts());
    assert.deepEqual(
      doc.root.children.map((c) => c.tweet.id),
      ['aaa', 'bbb'],
    );
  });
});

describe('assemble - roots and orphans', () => {
  it('walks up to the highest captured ancestor', () => {
    const tweets = chain(['robin', 'alice', 'bob']);
    const doc = assemble(tweets, tweets[2]!.id, opts());
    assert.equal(doc.root.tweet.id, tweets[0]!.id);
    assert.equal(doc.root.orphan, false);
    assert.deepEqual(flatten(doc.root), tweets.map((t) => t.id));
  });

  it('flags an orphan root when the parent was never captured', () => {
    const tweets = chain(['robin', 'alice']);
    const orphaned = { ...tweets[0]!, inReplyToId: '1234567890000000000' };
    const doc = assemble([orphaned, tweets[1]!], tweets[1]!.id, opts());
    assert.equal(doc.root.orphan, true);
    assert.ok(doc.warnings.some((w) => w.includes('root was not captured')));
  });

  it('buckets replies whose parent was never captured rather than dropping them', () => {
    const root = tweet('1900000000000000000');
    const stray = tweet('1900000000000000050', {
      author: 'carol',
      conversationId: root.id,
      inReplyToId: '1900000000000000049', // never captured
    });
    const doc = assemble([root, stray], root.id, opts());
    const node = find(doc.root, stray.id);
    assert.ok(node, 'stray reply is still in the tree');
    assert.equal(node.orphan, true);
    assert.equal(doc.stats.orphans, 1);
    assert.ok(doc.warnings.some((w) => w.includes('no captured parent')));
  });

  it('warns when conversationId disagrees with the walked root', () => {
    const declared = tweet('1900000000000000000');
    const focal = tweet('1900000000000000005', {
      author: 'alice',
      conversationId: declared.id,
      inReplyToId: null, // no chain to walk, so the walk lands on focal itself
    });
    const doc = assemble([declared, focal], focal.id, opts());
    assert.equal(doc.root.tweet.id, declared.id, 'declared root wins');
    assert.ok(doc.warnings.some((w) => w.includes('differs from the walked root')));
  });

  it('terminates on an artificial cycle', () => {
    const a = tweet('1900000000000000001', { inReplyToId: '1900000000000000002' });
    const b = tweet('1900000000000000002', {
      author: 'alice',
      inReplyToId: '1900000000000000001',
      conversationId: '1900000000000000001',
    });
    const doc = assemble([a, b], a.id, opts());
    assert.ok(doc.stats.rendered >= 1);
    assert.ok(doc.warnings.some((w) => w.includes('cycle')));
  });
});

describe('assemble - caps', () => {
  function fan(count: number, parentId: string): Tweet[] {
    return Array.from({ length: count }, (_, i) =>
      tweet((BigInt('1900000000000000100') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: parentId,
        inReplyToId: parentId,
      }),
    );
  }

  it('maxChildrenPerNode truncates and records the remainder', () => {
    const root = tweet('1900000000000000000');
    const doc = assemble([root, ...fan(10, root.id)], root.id, opts({ maxChildrenPerNode: 4 }));
    assert.equal(doc.root.children.length, 4);
    assert.equal(doc.root.truncatedChildren, 6);
    assert.equal(doc.stats.truncated, 6);
    assert.ok(doc.warnings.some((w) => w.includes('collection limits')));
  });

  it('maxDepth truncates at the boundary node', () => {
    const tweets = chain(['robin', 'alice', 'bob', 'carol', 'dave']);
    const doc = assemble(tweets, tweets[4]!.id, opts({ maxDepth: 2 }));
    const deepest = find(doc.root, tweets[2]!.id);
    assert.ok(deepest);
    assert.equal(deepest.depth, 2);
    assert.equal(deepest.children.length, 0);
    assert.equal(deepest.truncatedChildren, 1);
  });

  it('maxTweets caps the global budget', () => {
    const root = tweet('1900000000000000000');
    const doc = assemble([root, ...fan(20, root.id)], root.id, opts({ maxTweets: 5 }));
    assert.equal(doc.stats.rendered, 5);
    assert.equal(doc.stats.truncated, 16);
  });
});

describe('assemble - stats and warnings', () => {
  it('reports mixed sources', () => {
    const a = tweet('1900000000000000000');
    const b = tweet('1900000000000000001', {
      author: 'alice',
      conversationId: a.id,
      inReplyToId: a.id,
      source: 'dom',
    });
    const doc = assemble([a, b], a.id, opts());
    assert.equal(doc.stats.source, 'mixed');
    assert.ok(doc.warnings.some((w) => w.includes('GraphQL and DOM')));
  });

  it('reports partial tweets', () => {
    const a = tweet('1900000000000000000', { partial: true });
    const doc = assemble([a], a.id, opts());
    assert.ok(doc.warnings.some((w) => w.includes('missing expected fields')));
  });

  it('uses the injected capture timestamp', () => {
    const a = tweet('1900000000000000000');
    assert.equal(assemble([a], a.id, opts()).capturedAt, AT);
  });

  it('throws when the focal tweet is absent', () => {
    assert.throws(() => assemble([], 'nope', opts()), /focal tweet/);
  });
});

describe('assemble - uncaptured replies', () => {
  it('counts replies X declares but we never captured', () => {
    // The "Voir les réponses" case: X says this reply has one of its own, and
    // the branch is still folded behind a control we did not open.
    const root = tweet('1900000000000000000', { metrics: { ...metrics(), replies: 1 } });
    const reply = tweet('1900000000000000001', {
      author: 'alice',
      conversationId: root.id,
      inReplyToId: root.id,
      metrics: { ...metrics(), replies: 1 },
    });
    const doc = assemble([root, reply], root.id, opts());

    assert.equal(find(doc.root, reply.id)?.uncapturedReplies, 1);
    assert.equal(doc.root.uncapturedReplies, 0, 'the root has its one reply');
    assert.equal(doc.stats.uncaptured, 1);
  });

  it('counts tweets held back by a cap as held, not as missing', () => {
    const root = tweet('1900000000000000000', { metrics: { ...metrics(), replies: 3 } });
    const replies = Array.from({ length: 3 }, (_, i) =>
      tweet((BigInt('1900000000000000010') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: root.id,
        inReplyToId: root.id,
      }),
    );
    const doc = assemble([root, ...replies], root.id, opts({ maxChildrenPerNode: 1 }));
    // Two were dropped by the cap - we had them, so they are not "uncaptured".
    assert.equal(doc.root.truncatedChildren, 2);
    assert.equal(doc.root.uncapturedReplies, 0);
  });

  it('stays silent when the DOM fallback has no reply counts', () => {
    const a = tweet('1900000000000000000', { source: 'dom', metrics: { ...metrics(), replies: null } });
    assert.equal(assemble([a], a.id, opts()).stats.uncaptured, 0);
  });

  it('never goes negative when X reports fewer replies than we hold', () => {
    // Happens when a reply arrives between the count being computed and served.
    const root = tweet('1900000000000000000', { metrics: { ...metrics(), replies: 0 } });
    const reply = tweet('1900000000000000001', {
      author: 'alice',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    assert.equal(assemble([root, reply], root.id, opts()).stats.uncaptured, 0);
  });
});

describe('assemble - truncation drops whole subtrees', () => {
  it('does not resurface a capped reply\'s children as orphans', () => {
    // The defect this pins: marking only the capped tweet left its descendants
    // unvisited, so the orphan pass lifted each of them to depth 1. One capped
    // reply manufactured a cascade of fake top-level replies.
    const root = tweet('1900000000000000000');
    const kept = tweet('1900000000000000001', {
      author: 'alice',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    const capped = tweet('1900000000000000002', {
      author: 'bob',
      conversationId: root.id,
      inReplyToId: root.id,
    });
    const grandchild = tweet('1900000000000000003', {
      author: 'carol',
      conversationId: root.id,
      inReplyToId: capped.id,
    });
    const greatGrandchild = tweet('1900000000000000004', {
      author: 'dave',
      conversationId: root.id,
      inReplyToId: grandchild.id,
    });

    const doc = assemble([root, kept, capped, grandchild, greatGrandchild], root.id, {
      ...opts(),
      maxChildrenPerNode: 1,
    });

    assert.equal(doc.stats.orphans, 0, 'a capped branch must not become orphans');
    assert.deepEqual(
      doc.root.children.map((c) => c.tweet.id),
      [kept.id],
    );
    assert.equal(doc.root.truncatedChildren, 1, 'one branch was cut');
    assert.equal(doc.stats.truncated, 3, 'and it took its three tweets with it');
    assert.ok(!doc.warnings.some((w) => w.includes('no captured parent')));
  });

  it('does the same at the depth cap', () => {
    const tweets = chain(['robin', 'alice', 'bob', 'carol', 'dave']);
    const doc = assemble(tweets, tweets[0]!.id, { ...opts(), maxDepth: 1 });
    assert.equal(doc.stats.orphans, 0);
    assert.equal(doc.stats.truncated, 3, 'the whole tail below the cap');
  });

  it('still buckets genuinely parentless replies', () => {
    // Distinct from truncation: nothing dropped these, they simply arrived
    // without their parent.
    const root = tweet('1900000000000000000');
    const stray = tweet('1900000000000000050', {
      author: 'carol',
      conversationId: root.id,
      inReplyToId: '1900000000000000049',
    });
    assert.equal(assemble([root, stray], root.id, opts()).stats.orphans, 1);
  });
});

describe('assemble - author-thread scope', () => {
  const root = tweet('1900000000000000000', {
    author: 'robin',
    conversationId: '1900000000000000000',
    text: 'first',
    metrics: metrics({ replies: 40 }),
  });
  const own = tweet('1900000000000000001', {
    author: 'robin',
    conversationId: root.id,
    inReplyToId: root.id,
    text: 'second',
    metrics: metrics({ replies: 12 }),
  });
  const stranger = tweet('1900000000000000002', {
    author: 'alice',
    conversationId: root.id,
    inReplyToId: root.id,
    text: 'a reply',
    metrics: metrics({ replies: 0 }),
  });
  const deeper = tweet('1900000000000000003', {
    author: 'bob',
    conversationId: root.id,
    inReplyToId: stranger.id,
    text: 'a reply to a reply',
    metrics: metrics({ replies: 0 }),
  });
  const all = [root, own, stranger, deeper];
  const caps = { ...DEFAULT_CAPS, includeReplies: false };

  it('keeps the author spine and nothing else', () => {
    const doc = assemble(all, root.id, caps);
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      [root.id, own.id],
    );
    assert.equal(doc.stats.rendered, 2);
    assert.equal(doc.scope, 'author-thread');
  });

  it('does not sweep other people back in as orphans', () => {
    // Everyone else is unvisited by construction here, so the orphan pass would
    // otherwise re-add the whole conversation at depth 1 - the exact content
    // the scope exists to exclude.
    const doc = assemble(all, root.id, caps);
    assert.equal(doc.stats.orphans, 0);
    assert.deepEqual(doc.root.children.map((c) => c.tweet.id), [own.id]);
  });

  it('reports no uncaptured replies', () => {
    // X says this root has 40 replies. Saying "38 not captured" on a document
    // that was never meant to carry any reads as failure rather than choice.
    const doc = assemble(all, root.id, caps);
    assert.equal(doc.stats.uncaptured, 0);
    assert.ok(!doc.warnings.some((w) => w.includes('not captured')), doc.warnings.join(' | '));
  });

  it('is not demoted to partial by a collapsed branch', () => {
    const doc = assemble(all, root.id, {
      ...caps,
      collection: 'complete',
      collapsedBranches: 3,
    });
    assert.equal(doc.collection, 'complete');
  });

  it('handles a lone unthreaded tweet', () => {
    const doc = assemble([root, stranger], root.id, caps);
    assert.deepEqual(doc.selfThread.map((t) => t.id), [root.id]);
    assert.equal(doc.stats.rendered, 1);
  });

  it('still exports the whole conversation by default', () => {
    const doc = assemble(all, root.id, DEFAULT_CAPS);
    assert.equal(doc.scope, 'conversation');
    assert.equal(doc.stats.rendered, 4);
  });
});
