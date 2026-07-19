// One raw GraphQL tweet result -> one normalised Tweet.
//
// This is where every schema-drift fix lands. Two rules hold throughout:
//   - nothing throws; a malformed tweet returns a `partial` result or null,
//     because one bad reply must not cost you the other four hundred;
//   - every dual-path accessor names both schema eras in a comment.

import type { Author, Tweet } from '../types/model.ts';
import { permalinkFor } from '../types/model.ts';
import { bool, get, num, str, strOf, toIso, unwrapTweet } from './accessors.ts';
import { parseMedia } from './media.ts';
import { parseText } from './text.ts';
import { shape } from '../shared/log.ts';

/** Quote-of-a-quote-of-a-quote is already unusual; deeper is not worth carrying. */
const QUOTE_DEPTH_MAX = 3;

export interface ParseTweetOptions {
  /** Populate Tweet.raw. Debug mode only. */
  keepRaw?: boolean;
}

function parseAuthor(tweetResult: unknown, missing: string[]): Author {
  const user = get(tweetResult, 'core.user_results.result');

  // X began migrating user fields out of `.legacy` into `.core` during 2025.
  // Both eras are still observed in the wild, so both are checked everywhere.
  const handle = strOf(user, 'core.screen_name', 'legacy.screen_name');
  const name = strOf(user, 'core.name', 'legacy.name');
  const avatar = strOf(
    user,
    'avatar.image_url',
    'legacy.profile_image_url_https',
    'core.profile_image_url_https',
  );

  if (handle === null) {
    missing.push('author.handle');
    shape('missing-author-handle', user);
  }

  return {
    id: str(user, 'rest_id'),
    handle: handle ?? '',
    name: name ?? handle ?? '',
    avatarUrl: avatar,
    // is_blue_verified is the current field; legacy.verified is the old one.
    verified: bool(user, 'is_blue_verified') ?? bool(user, 'legacy.verified'),
  };
}

/**
 * Parse one `tweet_results.result` object.
 * Returns null only when there is no usable id — anything else degrades to a
 * `partial` tweet rather than being dropped.
 */
export function parseTweet(
  rawResult: unknown,
  options: ParseTweetOptions = {},
  depth = 0,
  seen: Set<string> = new Set(),
): Tweet | null {
  try {
    const result = unwrapTweet(rawResult);
    if (!result || typeof result !== 'object') return null;

    const typename = str(result, '__typename');
    if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
      shape(`tombstone:${typename}`, result);
      return null;
    }

    const id = str(result, 'rest_id') ?? str(result, 'legacy.id_str');
    if (!id) {
      shape('missing-rest-id', result);
      return null;
    }

    const legacy = get(result, 'legacy');
    const missing: string[] = [];
    if (!legacy) {
      missing.push('legacy');
      shape('missing-legacy', result);
    }

    const author = parseAuthor(result, missing);
    const { text, isLongForm, links } = parseText(result);
    const createdAt = toIso(str(legacy, 'created_at'));
    if (createdAt === null) missing.push('createdAt');

    // Cycle guard: A quotes B quotes A is possible, and unbounded recursion here
    // would hang the export rather than merely mis-render it.
    let quoted: Tweet | null = null;
    if (depth < QUOTE_DEPTH_MAX && !seen.has(id)) {
      const quotedRaw = get(result, 'quoted_status_result.result');
      if (quotedRaw) {
        quoted = parseTweet(quotedRaw, options, depth + 1, new Set([...seen, id]));
      }
    }

    const tweet: Tweet = {
      id,
      conversationId: str(legacy, 'conversation_id_str'),
      inReplyToId: str(legacy, 'in_reply_to_status_id_str'),
      inReplyToHandle: str(legacy, 'in_reply_to_screen_name'),
      author,
      createdAt,
      text,
      isLongForm,
      lang: str(legacy, 'lang'),
      media: parseMedia(legacy),
      links,
      quoted,
      metrics: {
        likes: num(legacy, 'favorite_count'),
        retweets: num(legacy, 'retweet_count'),
        replies: num(legacy, 'reply_count'),
        quotes: num(legacy, 'quote_count'),
        bookmarks: num(legacy, 'bookmark_count'),
        views: num(result, 'views.count'),
        reliable: true,
      },
      permalink: permalinkFor(author.handle, id),
      source: 'graphql',
      partial: missing.length > 0,
    };

    if (options.keepRaw) tweet.raw = rawResult;
    return tweet;
  } catch (err) {
    shape('parse-tweet-threw', err);
    return null;
  }
}
