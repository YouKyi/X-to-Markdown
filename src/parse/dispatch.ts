// Shape-sniff a GraphQL response body and turn it into Tweet[].
//
// Deliberately NOT dispatching on the operation name in the URL: X has renamed
// GraphQL operations in flight before, and the query id in the path rotates
// every few weeks. Matching on the structure of the parsed body is strictly more
// robust and costs one property lookup. The operation name survives only as a
// debug label.

import type { Tweet } from '../types/model.ts';
import { arr, get } from './accessors.ts';
import { walkInstructions } from './instructions.ts';
import { parseTweet } from './tweet.ts';
import type { ParseTweetOptions } from './tweet.ts';
import { shape } from '../shared/log.ts';

export interface DispatchResult {
  tweets: Tweet[];
  cursorBottom: string | null;
  /** Entries that should have produced a tweet. */
  eligible: number;
  /** Entries that did. */
  parsed: number;
  /** parsed / eligible, or 1 when there was nothing to parse. */
  yieldRatio: number;
  /** Reply branches left collapsed behind a "show more" control. */
  collapsedBranches: number;
}

/** Roots that are known to hold a timeline of instructions. */
const TIMELINE_ROOTS = [
  'data.threaded_conversation_with_injections_v2',
  'data.user.result.timeline.timeline',
  'data.user.result.timeline_v2.timeline',
  'data.user.result.timeline',
  'data.bookmark_timeline_v2.timeline',
  'data.search_by_raw_query.search_timeline.timeline',
  'data.home.home_timeline_urt',
];

const EMPTY: DispatchResult = {
  tweets: [],
  cursorBottom: null,
  eligible: 0,
  parsed: 0,
  yieldRatio: 1,
  collapsedBranches: 0,
};

/** Depth limit for the root search. Known roots sit at depth 2-4. */
const ROOT_SEARCH_DEPTH = 6;

/**
 * An `instructions` array belonging to a timeline, wherever it lives.
 *
 * `TIMELINE_ROOTS` above is a list of paths observed in captures, which means it
 * is only ever as current as the last capture. X serves conversation data from
 * roots not on that list — `ModeratedTimeline`, which carries the replies an
 * author has hidden, puts them under
 * `data.tweet.result.timeline_response.timeline.instructions` — and a payload
 * whose root is unlisted is not partially parsed, it is dropped whole.
 *
 * So when no known path matches, the array is looked for by shape instead. The
 * test is deliberately narrow: an array of objects whose `type` starts with
 * `Timeline`. That is X's own naming convention for instruction types and it is
 * not a shape that occurs incidentally elsewhere in these payloads.
 *
 * Picking up a timeline that is not the current conversation is survivable: the
 * export filters by conversation id before assembling, so a stray timeline's
 * tweets are dropped there. Missing a conversation entirely is not.
 */
function looksLikeInstructions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => {
    const type = get(item, 'type');
    return typeof type === 'string' && type.startsWith('Timeline');
  });
}

function findInstructions(node: unknown, depth = 0): unknown[] | null {
  if (depth > ROOT_SEARCH_DEPTH || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findInstructions(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'instructions' && looksLikeInstructions(value)) return value as unknown[];
    const found = findInstructions(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function dispatch(payload: unknown, options: ParseTweetOptions = {}): DispatchResult {
  if (!payload || typeof payload !== 'object') return EMPTY;

  let raw: unknown[] = [];
  let cursorBottom: string | null = null;
  let eligible = 0;
  let parsed = 0;
  let collapsedBranches = 0;

  let root: unknown;
  for (const path of TIMELINE_ROOTS) {
    const candidate = get(payload, path);
    if (candidate && arr(candidate, 'instructions').length > 0) {
      root = candidate;
      break;
    }
  }

  // No listed root matched. Before giving up, look for the instructions array by
  // shape — see findInstructions.
  let instructions: unknown[] | null = null;
  if (!root) {
    instructions = findInstructions(payload);
    if (instructions) shape('timeline-root-found-by-shape');
  }

  if (root || instructions) {
    const walked = walkInstructions(root ?? instructions);
    raw = walked.results;
    cursorBottom = walked.cursorBottom;
    eligible = walked.eligible;
    parsed = walked.parsed;
    collapsedBranches = walked.collapsedBranches;
  } else {
    // Single-tweet responses (TweetResultByRestId and friends) have no timeline.
    const single =
      get(payload, 'data.tweetResult.result') ??
      get(payload, 'data.tweet_results.result') ??
      get(payload, 'data.tweetResults.result');
    if (single) {
      raw = [single];
      eligible = 1;
      parsed = 1;
    } else {
      // Not a tweet-bearing payload at all: profile lookups, settings, typeahead.
      // Silent by design — most GraphQL traffic on x.com is not a conversation.
      return EMPTY;
    }
  }

  const tweets: Tweet[] = [];
  for (const result of raw) {
    const tweet = parseTweet(result, options);
    if (tweet) tweets.push(tweet);
  }

  // Shape-drift signal. A sudden drop here is how you learn X changed its schema
  // on the day it happens, rather than three weeks later on noticing an export
  // was quietly missing half its replies.
  const yieldRatio = eligible === 0 ? 1 : parsed / eligible;
  if (yieldRatio < 0.8) shape('low-yield-ratio', { eligible, parsed, yieldRatio });

  return { tweets, cursorBottom, eligible, parsed, yieldRatio, collapsedBranches };
}
