// instructions[] -> entries[] -> raw tweet result objects.
//
// The timeline envelope is the least stable part of X's schema: entry id
// prefixes come and go, and modules get re-shaped. So known shapes are handled
// explicitly and anything unrecognised falls through to a bounded deep scan
// rather than being dropped — an unfamiliar entry should cost you a debug line,
// not a missing reply.

import { arr, get, str } from './accessors.ts';
import { debug, shape } from '../shared/log.ts';

export interface WalkResult {
  /** Raw `tweet_results.result` objects, in entry order. */
  results: unknown[];
  /** Last `cursor-bottom` value seen, for pagination exhaustion detection. */
  cursorBottom: string | null;
  /** Entries that looked like they should contain a tweet but yielded none. */
  eligible: number;
  /** Entries that yielded at least one tweet. */
  parsed: number;
  /** Reply branches X collapsed behind a "show more" control. See below. */
  collapsedBranches: number;
}

/**
 * Instruction types that legitimately carry no tweets.
 *
 * Listed so that a genuinely unfamiliar instruction still stands out in the
 * debug log; without this every payload would report these two as unrecognised
 * and drown the signal.
 */
const CONTENTLESS_INSTRUCTIONS = new Set([
  'TimelineClearCache',
  'TimelineTerminateTimeline',
  'TimelineShowAlert',
  'TimelineShowCover',
  'TimelinePinEntry',
]);

/**
 * Promoted content injected into the conversation.
 *
 * X serves ads inline among the replies (the web app requests them explicitly
 * with includePromotedContent=true). They are not replies to anything, so they
 * arrive with no usable parent and end up in the orphan bucket, rendered as
 * though someone had answered the thread — and their own reply counts, often in
 * the hundreds, land in the "not captured" total and swamp it.
 *
 * The shape is not what you would guess, so it is worth stating exactly. An ad
 * does not arrive as a `promoted-*` entry. It arrives as an ITEM inside an
 * ordinary `conversationthread-*` entry, with `promoted-tweet` in the middle of
 * the item's id rather than at the start:
 *
 *   entry  conversationthread-2058319900804833482
 *   item   conversationthread-2058319900804833482-promoted-tweet-2058…-3d98bc06
 *          itemContent: { promotedMetadata, tweet_results, … }
 *
 * So `promotedMetadata` is checked on the item, and the id is matched anywhere
 * rather than as a prefix.
 */
function isPromoted(entryId: string, node: unknown): boolean {
  if (entryId.includes('promoted-tweet') || entryId.startsWith('promoted')) return true;
  if (get(node, 'promotedMetadata')) return true;
  if (get(node, 'item.itemContent.promotedMetadata')) return true;
  if (get(node, 'content.itemContent.promotedMetadata')) return true;
  if (get(node, 'itemContent.promotedMetadata')) return true;
  if (get(node, 'content.itemContent.tweet_results.result.promoted_metadata')) return true;
  return false;
}

/** Depth limit for the fallback scan. Entry objects are shallow in practice. */
const SCAN_DEPTH = 8;

/** Find `tweet_results.result` objects anywhere under a node. */
function scan(node: unknown, out: unknown[], depth = 0): void {
  if (depth > SCAN_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) scan(item, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    // quoted_status_result is handled by the tweet parser recursively; picking
    // it up here would hoist quoted tweets into the conversation as siblings.
    if (key === 'quoted_status_result') continue;
    if (key === 'tweet_results') {
      const result = get(value, 'result');
      if (result) out.push(result);
      continue;
    }
    scan(value, out, depth + 1);
  }
}

/**
 * A branch of the conversation that X collapsed behind a "show more" control.
 *
 * These arrive as cursor *items* inside an ordinary `conversationthread-*`
 * entry, not as `cursor-*` entries — the entry-level check further down never
 * sees them:
 *
 *   entry  conversationthread-1234
 *     items[0..1]  item.itemContent.tweet_results   (the replies we do capture)
 *     items[2]     item.itemContent = {
 *                    __typename: 'TimelineTimelineCursor',
 *                    cursorType: 'ShowMore',
 *                    value: '…',
 *                  }
 *
 * Carrying no tweet, they were skipped in silence, and the branch simply ended
 * early in the export with nothing saying so. `real-tweetdetail.json` holds
 * three of them.
 *
 * `assemble.ts` does derive an uncaptured-reply estimate from
 * `metrics.replies - held`, which usually covers this. But that is an estimate:
 * it is unavailable whenever metrics are null (the whole DOM path), and it
 * cannot separate a collapsed branch from replies that were deleted, hidden or
 * posted by muted accounts. This is the direct signal, and it was in the payload
 * all along.
 */
function isShowMoreCursor(item: unknown): boolean {
  const content = get(item, 'item.itemContent');
  if (!content) return false;
  if (str(content, '__typename') !== 'TimelineTimelineCursor') return false;
  // 'Bottom' and 'Top' cursors are pagination, handled at entry level. Anything
  // else at item level is a collapsed branch: 'ShowMore', and the
  // 'ShowMoreThreads' variant X uses on some conversations.
  const cursorType = str(content, 'cursorType') ?? '';
  return cursorType.startsWith('ShowMore');
}

interface EntryHarvest {
  added: number;
  /** Ads deliberately left behind, so the caller does not "rescue" them. */
  skippedPromoted: number;
  /** "Show more" cursors seen among the items. */
  collapsed: number;
}

function fromEntry(entry: unknown, out: unknown[]): EntryHarvest {
  const before = out.length;
  let skippedPromoted = 0;
  let collapsed = 0;

  // Single tweet: entryId "tweet-<id>"
  const single = get(entry, 'content.itemContent.tweet_results.result');
  if (single) out.push(single);

  // Conversation module: entryId "conversationthread-<id>". Ads live here too,
  // one level below the entry, which is why each item is checked individually.
  for (const item of arr(entry, 'content.items')) {
    if (isShowMoreCursor(item)) {
      // debug(), not shape(): this is a shape we understand and count, not one
      // we failed to recognise. Reporting it as unrecognised would raise a
      // schema-drift alarm on every ordinary conversation.
      debug('collapsed branch cursor in', str(entry, 'entryId') ?? 'unknown entry');
      collapsed += 1;
      continue;
    }
    if (isPromoted(str(item, 'entryId') ?? '', item)) {
      shape('promoted-conversation-item');
      skippedPromoted += 1;
      continue;
    }
    const result = get(item, 'item.itemContent.tweet_results.result');
    if (result) out.push(result);
  }

  return { added: out.length - before, skippedPromoted, collapsed };
}

/**
 * Tweets appended to an existing conversation module.
 *
 * This is what a "show more replies" click returns, and it does NOT arrive as
 * entries: the instruction is TimelineAddToModule and the tweets sit under
 * `moduleItems`. Reading only `entries` meant those payloads parsed to nothing,
 * so clicking the control worked, X answered, and the replies were dropped on
 * the floor — the export looked as though the branch simply did not exist.
 */
function fromModuleItems(instruction: unknown, out: unknown[]): number {
  let added = 0;
  for (const item of arr(instruction, 'moduleItems')) {
    if (isPromoted(str(item, 'entryId') ?? '', item)) {
      shape('promoted-module-item');
      continue;
    }
    const result = get(item, 'item.itemContent.tweet_results.result');
    if (result) {
      out.push(result);
      added += 1;
    }
  }
  return added;
}

export function walkInstructions(payload: unknown): WalkResult {
  const results: unknown[] = [];
  let cursorBottom: string | null = null;
  let eligible = 0;
  let parsed = 0;
  let collapsedBranches = 0;

  // TweetDetail puts the conversation here. Other operations use different
  // roots, so the caller (dispatch.ts) hands us whichever it found.
  const instructions = Array.isArray(payload) ? payload : arr(payload, 'instructions');

  for (const instruction of instructions) {
    const type = str(instruction, 'type');

    // A "show more replies" click answers with TimelineAddToModule rather than
    // entries; handled first because it carries no `entries` at all.
    const fromModule = fromModuleItems(instruction, results);
    if (fromModule > 0) {
      eligible += fromModule;
      parsed += fromModule;
      continue;
    }

    // TimelineReplaceEntry swaps a single entry, typically a cursor.
    const replacement = get(instruction, 'entry');

    const entries = replacement ? [replacement] : arr(instruction, 'entries');
    if (entries.length === 0) {
      if (type !== null && !CONTENTLESS_INSTRUCTIONS.has(type)) {
        shape(`instruction-without-entries:${type}`);
      }
      continue;
    }

    for (const entry of entries) {
      const entryId = str(entry, 'entryId') ?? '';

      if (entryId.startsWith('cursor-')) {
        if (entryId.startsWith('cursor-bottom')) {
          cursorBottom = str(entry, 'content.value') ?? str(entry, 'content.itemContent.value');
        }
        continue;
      }

      if (isPromoted(entryId, entry)) {
        // Not a miss: an ad is not part of the conversation.
        shape('promoted-entry');
        continue;
      }

      const harvest = fromEntry(entry, results);
      collapsedBranches += harvest.collapsed;

      // An entry that held nothing but ads is not a miss and must not fall
      // through to the deep scan below — that scan looks for tweet_results
      // anywhere under the entry and would put straight back the very tweet
      // that was just deliberately dropped.
      //
      // Same for one holding nothing but a "show more" cursor: it is a branch we
      // did not expand, already counted, and not a parse failure. Letting either
      // reach the yield ratio would drag it down and fire the schema-drift alarm
      // on a perfectly well-understood payload.
      if (harvest.added === 0 && (harvest.skippedPromoted > 0 || harvest.collapsed > 0)) continue;

      eligible += 1;

      if (harvest.added > 0) {
        parsed += 1;
        continue;
      }

      // Unrecognised: log the shape once, then scan rather than drop.
      const prefix = entryId.split('-')[0] ?? 'unknown';
      const found: unknown[] = [];
      scan(entry, found);
      if (found.length > 0) {
        shape(`unknown-entry-shape:${prefix}`, entryId);
        results.push(...found);
        parsed += 1;
      } else {
        // Promoted content, "who to follow" modules and similar carry no tweet.
        shape(`empty-entry:${prefix}`, entryId);
        eligible -= 1;
      }
    }
  }

  return { results, cursorBottom, eligible, parsed, collapsedBranches };
}
