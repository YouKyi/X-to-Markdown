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
};

export function dispatch(payload: unknown, options: ParseTweetOptions = {}): DispatchResult {
  if (!payload || typeof payload !== 'object') return EMPTY;

  let raw: unknown[] = [];
  let cursorBottom: string | null = null;
  let eligible = 0;
  let parsed = 0;

  let root: unknown;
  for (const path of TIMELINE_ROOTS) {
    const candidate = get(payload, path);
    if (candidate && arr(candidate, 'instructions').length > 0) {
      root = candidate;
      break;
    }
  }

  if (root) {
    const walked = walkInstructions(root);
    raw = walked.results;
    cursorBottom = walked.cursorBottom;
    eligible = walked.eligible;
    parsed = walked.parsed;
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

  return { tweets, cursorBottom, eligible, parsed, yieldRatio };
}
