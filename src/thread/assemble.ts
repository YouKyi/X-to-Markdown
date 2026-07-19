// Tweet[] + focal id -> ThreadDoc.
//
// Pure function: no DOM, no browser APIs, no clock except the injected one.
// That is deliberate - this is where the interesting logic lives, and it should
// be verifiable with `node --test` alone.

import type { Completeness, Source, Tweet, ThreadDoc, ThreadNode } from '../types/model.ts';

export interface AssembleCaps {
  maxDepth: number;
  maxChildrenPerNode: number;
  maxTweets: number;
}

export interface AssembleOptions extends AssembleCaps {
  /** Injected so golden tests are deterministic. */
  capturedAt?: string;
  /** Reported by the collection pass; defaults to unknown. */
  collection?: Completeness;
  /**
   * "Show more" branches the parser saw and the collection pass did not open.
   *
   * Demotes `collection` to partial, for the same reason a cap that bit does:
   * X said outright that there was more behind those controls, so the document
   * is demonstrably missing replies however tidily the scroll loop ended.
   */
  collapsedBranches?: number;
  /**
   * Include other people's replies. Off means the author's thread alone.
   *
   * Implemented by restricting the child index to the root author before the
   * tree walk, rather than by pruning afterwards: the spine is then simply what
   * the walk produces, and the stats describe the document that was actually
   * asked for instead of one that was built and then cut down.
   */
  includeReplies?: boolean;
}

export const DEFAULT_CAPS: AssembleCaps = {
  maxDepth: 10,
  maxChildrenPerNode: 50,
  maxTweets: 500,
};

/** Guard against a malformed inReplyToId chain hanging the export. */
const MAX_ANCESTOR_HOPS = 100;

/**
 * Sibling order.
 *
 * Tweet IDs are Snowflakes, so numeric ID order *is* chronological - and it is
 * more reliable than createdAt, which has second granularity and therefore
 * produces ties. Determinism matters here because golden tests compare bytes.
 */
function compareIds(a: Tweet, b: Tweet): number {
  try {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  } catch {
    // Non-numeric ids (synthetic fixtures, DOM oddities): fall back to time,
    // then to plain string order.
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
}

function sameAuthor(a: Tweet, b: Tweet): boolean {
  if (a.author.id && b.author.id) return a.author.id === b.author.id;
  // The DOM fallback has no user ids, so handles are the fallback key.
  return (
    a.author.handle !== '' &&
    a.author.handle.toLowerCase() === b.author.handle.toLowerCase()
  );
}

function makeNode(tweet: Tweet, depth: number): ThreadNode {
  return {
    tweet,
    depth,
    children: [],
    truncatedChildren: 0,
    isSelfThread: false,
    orphan: false,
    uncapturedReplies: 0,
  };
}

/**
 * Walk up from the focal tweet to the highest captured ancestor.
 *
 * X often does not return ancestors above the focal conversation, so stopping
 * at an uncaptured parent is the normal case, not an error - the resulting root
 * is flagged `orphan` and a warning is emitted.
 */
function findRoot(
  focal: Tweet,
  byId: Map<string, Tweet>,
  warnings: string[],
): { root: Tweet; orphan: boolean } {
  const seen = new Set<string>([focal.id]);
  let current = focal;
  let hops = 0;

  while (current.inReplyToId && hops < MAX_ANCESTOR_HOPS) {
    if (seen.has(current.inReplyToId)) {
      warnings.push('Reply chain contains a cycle; stopped walking upward.');
      break;
    }
    const parent = byId.get(current.inReplyToId);
    if (!parent) break;
    seen.add(parent.id);
    current = parent;
    hops += 1;
  }

  if (hops >= MAX_ANCESTOR_HOPS) {
    warnings.push('Reply chain exceeded the ancestor walk limit; root may be wrong.');
  }

  // Cross-check against conversationId. If X told us the conversation root and
  // we captured it, prefer it; if the two disagree, say so rather than choosing
  // silently.
  const conversationId = focal.conversationId;
  if (conversationId && conversationId !== current.id) {
    const declared = byId.get(conversationId);
    if (declared) {
      warnings.push(
        `Conversation root (${conversationId}) differs from the walked root (${current.id}); used the declared root.`,
      );
      return { root: declared, orphan: declared.inReplyToId !== null };
    }
    warnings.push(`Conversation root ${conversationId} was never captured.`);
  }

  return { root: current, orphan: current.inReplyToId !== null };
}

export function assemble(
  tweets: Tweet[],
  focalId: string,
  options: AssembleOptions = DEFAULT_CAPS,
): ThreadDoc {
  const warnings: string[] = [];
  const caps: AssembleCaps = {
    maxDepth: Math.max(1, options.maxDepth),
    maxChildrenPerNode: Math.max(1, options.maxChildrenPerNode),
    maxTweets: Math.max(1, options.maxTweets),
  };

  const byId = new Map<string, Tweet>();
  for (const tweet of tweets) byId.set(tweet.id, tweet);

  const focal = byId.get(focalId);
  if (!focal) throw new Error(`focal tweet ${focalId} is not in the supplied set`);

  const childrenOf = new Map<string, Tweet[]>();
  for (const tweet of tweets) {
    if (!tweet.inReplyToId) continue;
    const bucket = childrenOf.get(tweet.inReplyToId);
    if (bucket) bucket.push(tweet);
    else childrenOf.set(tweet.inReplyToId, [tweet]);
  }
  for (const bucket of childrenOf.values()) bucket.sort(compareIds);

  const { root: rootTweet, orphan: rootOrphan } = findRoot(focal, byId, warnings);
  if (rootOrphan) {
    warnings.push('The conversation root was not captured; the thread starts mid-chain.');
  }

  // Author-thread scope: drop everyone else from the child index before the walk
  // below ever sees them. What remains is the author answering themselves, which
  // is exactly the spine - including the degenerate one-tweet case, where the
  // author replied to nobody and there is nothing to follow.
  const includeReplies = options.includeReplies !== false;
  if (!includeReplies) {
    for (const [parentId, bucket] of childrenOf) {
      const own = bucket.filter((child) => sameAuthor(child, rootTweet));
      if (own.length > 0) childrenOf.set(parentId, own);
      else childrenOf.delete(parentId);
    }
  }

  // --- Tree construction, breadth-first ---------------------------------------
  //
  // BFS rather than DFS so that hitting the global tweet budget truncates the
  // *deepest* material rather than starving whole branches of the conversation.

  const root = makeNode(rootTweet, 0);
  root.orphan = rootOrphan;

  const visited = new Set<string>([rootTweet.id]);
  const nodes = new Map<string, ThreadNode>([[rootTweet.id, root]]);
  let rendered = 1;
  let truncated = 0;

  /**
   * Drop a tweet and everything hanging off it.
   *
   * Marking only the tweet itself would leave its descendants unvisited, and
   * the orphan pass below would then resurface each of them at depth 1 as a
   * top-level reply - one capped reply manufacturing a whole cascade of
   * orphans. On a busy thread that turned a readable tree into a flat list.
   */
  const dropSubtree = (tweet: Tweet): number => {
    let dropped = 0;
    const stack = [tweet];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      dropped += 1;
      stack.push(...(childrenOf.get(current.id) ?? []));
    }
    return dropped;
  };

  const queue: ThreadNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const candidates = childrenOf.get(node.tweet.id) ?? [];
    if (candidates.length === 0) continue;

    if (node.depth + 1 > caps.maxDepth) {
      let dropped = 0;
      for (const child of candidates) dropped += dropSubtree(child);
      node.truncatedChildren += candidates.length;
      truncated += dropped;
      continue;
    }

    let taken = 0;
    for (const child of candidates) {
      if (visited.has(child.id)) continue; // cycle guard

      if (taken >= caps.maxChildrenPerNode || rendered >= caps.maxTweets) {
        node.truncatedChildren += 1;
        truncated += dropSubtree(child);
        continue;
      }

      visited.add(child.id);
      const childNode = makeNode(child, node.depth + 1);
      node.children.push(childNode);
      nodes.set(child.id, childNode);
      rendered += 1;
      taken += 1;
      queue.push(childNode);
    }
  }

  // --- Orphan bucket -----------------------------------------------------------
  //
  // Tweets captured but never reached by the walk (their parent was never
  // captured - common with "show more replies" fragments). Dropping them
  // silently would be the worst outcome: replies lost with no indication.

  // Skipped entirely in author-thread scope: there, every other participant's
  // reply is unvisited by construction, so this pass would sweep the whole
  // conversation back in as orphans - the exact content the scope excludes.
  let orphans = 0;
  for (const tweet of includeReplies ? tweets : []) {
    if (visited.has(tweet.id)) continue;
    if (rendered >= caps.maxTweets) {
      root.truncatedChildren += 1;
      truncated += 1;
      continue;
    }
    const node = makeNode(tweet, 1);
    node.orphan = true;
    visited.add(tweet.id);
    root.children.push(node);
    nodes.set(tweet.id, node);
    rendered += 1;
    orphans += 1;
  }
  if (orphans > 0) {
    root.children.sort((a, b) => compareIds(a.tweet, b.tweet));
    warnings.push(`${orphans} repl${orphans === 1 ? 'y' : 'ies'} had no captured parent.`);
  }

  // --- Self-thread spine -------------------------------------------------------
  //
  // Walk down from the root while the author is unchanged. On a branched
  // self-thread the spine follows the lowest-ID child; the author's other
  // branches render as ordinary nested replies. X's own UI behaves the same way,
  // and it keeps the spine a list rather than a tree.

  const selfThread: Tweet[] = [];
  let spine: ThreadNode | undefined = root;
  while (spine) {
    spine.isSelfThread = true;
    selfThread.push(spine.tweet);
    const next: ThreadNode | undefined = spine.children.find(
      (child) => !child.orphan && sameAuthor(child.tweet, root.tweet),
    );
    spine = next;
  }

  // --- Uncaptured replies ------------------------------------------------------
  //
  // X tells us how many replies each tweet has. Comparing that against what we
  // actually hold is the only way to notice a branch still folded behind a
  // "show replies" control - otherwise the export just quietly stops there and
  // reads as if the conversation ended.
  //
  // Not treated as a failure: the count also includes replies that are deleted,
  // hidden, or from muted accounts, which no amount of scrolling would reach.

  // Not computed in author-thread scope. There the reader asked for no replies,
  // so the gap between what X reports and what the document holds is not a gap
  // at all - reporting it would put "105 replies not captured" on a document
  // that was never meant to carry any, which reads as failure rather than
  // choice.
  let uncaptured = 0;
  for (const node of includeReplies ? nodes.values() : []) {
    const declared = node.tweet.metrics.replies;
    if (declared === null) continue;
    const held = node.children.length + node.truncatedChildren;
    const gap = declared - held;
    if (gap <= 0) continue;
    node.uncapturedReplies = gap;
    uncaptured += gap;
  }

  // --- Stats -------------------------------------------------------------------

  let source: Source | 'mixed' = focal.source;
  for (const tweet of tweets) {
    if (tweet.source !== source) {
      source = 'mixed';
      break;
    }
  }
  if (source === 'mixed') warnings.push('Tweets came from both GraphQL and DOM scraping.');
  if (truncated > 0) warnings.push(`${truncated} tweets were not included because of collection limits.`);
  if (tweets.some((t) => t.partial)) warnings.push('Some tweets were missing expected fields.');

  return {
    focal,
    root,
    selfThread,
    // Milliseconds are noise in a provenance field, and dropping them keeps
    // every timestamp in the document in the same shape.
    capturedAt: options.capturedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    // Caps that bit override whatever the collection pass reported: the
    // document is demonstrably missing tweets regardless of how collection went.
    //
    // A collapsed branch overrides it for the same reason, and the case is if
    // anything stronger: the pagination driver reports `quiescence` when it
    // stops finding new material, which says the scroll loop ended tidily and
    // nothing at all about whether the conversation is whole. An export of this
    // thread carried `collection: complete` two lines above
    // `replies_not_captured: 105`. Whoever greps their vault for complete
    // captures a year from now would get a document missing three quarters of
    // its replies, and nothing in it would admit that.
    //
    // Deliberately not demoting on `uncaptured` alone: that number also counts
    // replies that were deleted, hidden, or written by muted accounts, which no
    // amount of scrolling would ever reach. Missing those is not an incomplete
    // capture. Missing a branch X offered to expand is.
    //
    // Neither demotion applies in author-thread scope: a branch left folded and
    // a cap on replies both concern material the reader excluded on purpose.
    // Completeness there is about the author's own spine, which is short and
    // arrives whole.
    collection:
      includeReplies && (truncated > 0 || (options.collapsedBranches ?? 0) > 0)
        ? 'partial'
        : (options.collection ?? 'unknown'),
    scope: includeReplies ? 'conversation' : 'author-thread',
    stats: { captured: tweets.length, rendered, truncated, orphans, uncaptured, source },
    warnings,
  };
}
