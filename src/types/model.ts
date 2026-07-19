// The one contract.
//
// Both parse/tweet.ts (GraphQL) and parse/dom.ts (fallback) produce exactly
// these shapes, and the renderer accepts nothing else. Three invariants are
// load-bearing and worth stating up front:
//
//   1. `null` means "unknown", never "zero". A null metric is omitted at render
//      time; a 0 renders as 0. The DOM fallback produces mostly nulls, and that
//      is the honest answer.
//
//   2. `text` is NOT markdown-escaped. Exactly one module in the codebase knows
//      about Markdown escaping (render/escape.ts). Parsers never emit Markdown.
//
//   3. `partial` and `source` propagate into the frontmatter, so a degraded
//      export documents itself instead of being silently wrong.

export type Source = 'graphql' | 'dom';
export type MediaKind = 'photo' | 'video' | 'gif' | 'unknown';

export interface Author {
  /** User rest_id. Null from the DOM fallback, which cannot see it. */
  id: string | null;
  /** screen_name, WITHOUT a leading '@'. */
  handle: string;
  /** Display name. May be '' when unavailable. */
  name: string;
  avatarUrl: string | null;
  /** null = unknown, which is not the same as false. */
  verified: boolean | null;
}

export interface Media {
  kind: MediaKind;
  /** Photos: original-resolution image. Video/GIF: highest-bitrate mp4. */
  url: string;
  /** media_url_https, used as the thumbnail for video and GIF. */
  posterUrl: string | null;
  /** ext_alt_text. Worth carrying: it is what makes the export useful later. */
  alt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** The legacy media `.url` (a t.co). Stripped from text, kept for provenance. */
  tcoUrl: string | null;
}

export interface LinkEntity {
  /** https://t.co/xxxx */
  tco: string;
  /** The real destination. */
  expanded: string;
  /** X's truncated display form. */
  display: string;
}

export interface Metrics {
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  views: number | null;
  /** False when any value was derived from locale-dependent DOM aria-labels. */
  reliable: boolean;
}

export interface Tweet {
  /** rest_id. The primary key everywhere; a Snowflake, so ID order is time order. */
  id: string;
  conversationId: string | null;
  inReplyToId: string | null;
  inReplyToHandle: string | null;
  author: Author;
  /** ISO 8601 UTC, normalised from X's "Wed Mar 21 20:50:14 +0000 2006". */
  createdAt: string | null;
  /** Long-form-preferred, t.co-expanded, trailing media t.co stripped. Unescaped. */
  text: string;
  /** True when `text` came from note_tweet rather than legacy.full_text. */
  isLongForm: boolean;
  lang: string | null;
  media: Media[];
  links: LinkEntity[];
  /** Recursive; capped at QUOTE_DEPTH_MAX and cycle-guarded by the parser. */
  quoted: Tweet | null;
  metrics: Metrics;
  permalink: string;
  source: Source;
  /** True when any expected field was missing. Surfaced in the frontmatter. */
  partial: boolean;
  /** Populated only in debug mode. */
  raw?: unknown;
}

export interface ThreadNode {
  tweet: Tweet;
  /** 0 = root of the reply tree. */
  depth: number;
  children: ThreadNode[];
  /** >0 means the renderer emits a truncation marker here. */
  truncatedChildren: number;
  /** On the author's own spine from the root. */
  isSelfThread: boolean;
  /** Parent id was known but the parent tweet was never captured. */
  orphan: boolean;
  /**
   * Replies X says exist here that were never captured.
   *
   * Derived from the tweet's own reply_count minus what we hold. Usually means
   * a branch is still collapsed behind a "show replies" control; it can also be
   * replies that are deleted, hidden, or from muted accounts, which is why this
   * is reported as a count rather than treated as a failure.
   */
  uncapturedReplies: number;
}

export interface ThreadStats {
  /** Tweets in the store for this conversation. */
  captured: number;
  rendered: number;
  truncated: number;
  orphans: number;
  /** Sum of uncapturedReplies across the tree. */
  uncaptured: number;
  source: Source | 'mixed';
}

/**
 * Whether collection reached the end of the conversation.
 *
 * `unknown` is a real answer, not a placeholder: without a collection pass we
 * genuinely cannot tell whether X sent everything, and saying so beats implying
 * completeness the export cannot vouch for.
 */
export type Completeness = 'complete' | 'partial' | 'unknown';

/**
 * What the reader asked for, as opposed to what was available.
 *
 * `author-thread` keeps the author's own spine — one tweet when the post is not
 * threaded — and no replies. It must stay distinct from an export that wanted
 * replies and did not get them: one is a choice, the other is a gap, and a
 * document conflating them tells the reader something false.
 */
export type Scope = 'conversation' | 'author-thread';

export interface ThreadDoc {
  /** The tweet whose /status/ URL we are on. */
  focal: Tweet;
  root: ThreadNode;
  /** The author spine, root-first, including the root. */
  selfThread: Tweet[];
  /** ISO 8601 UTC. */
  capturedAt: string;
  stats: ThreadStats;
  collection: Completeness;
  scope: Scope;
  /** Surfaced both in the frontmatter and in the progress toast. */
  warnings: string[];
}

export const EMPTY_METRICS: Metrics = {
  likes: null,
  retweets: null,
  replies: null,
  quotes: null,
  bookmarks: null,
  views: null,
  reliable: false,
};

export function permalinkFor(handle: string, id: string): string {
  return `https://x.com/${handle || 'i'}/status/${id}`;
}
