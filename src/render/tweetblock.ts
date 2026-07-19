// Renders the body of a single tweet: text, media, quoted tweet, meta line.
//
// Every function here returns string[], never a joined string. Depth/quoting is
// applied by exactly one function in markdown.ts, and it can only stay correct
// if nothing below it pre-formats.

import type { Media, Tweet } from '../types/model.ts';
import type { Settings } from '../shared/config.ts';
import { escapeText, escapeLinkText, escapeUrl } from './escape.ts';

/** Quoted tweets are already nested by the parser; this bounds the rendering. */
const QUOTE_RENDER_DEPTH_MAX = 3;

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function renderMedia(media: Media[], settings: Settings): string[] {
  const out: string[] = [];
  for (const item of media) {
    if (item.kind === 'photo') {
      out.push(`![${escapeLinkText(item.alt ?? 'image')}](${escapeUrl(item.url)})`);
      continue;
    }

    // An mp4 inside ![]() renders as a broken image, so video and GIF get a
    // plain link plus an optional poster image.
    const label = item.kind === 'gif' ? 'GIF' : 'video';
    const duration = item.durationMs ? ` · ${formatDuration(item.durationMs)}` : '';
    out.push(`[▶ ${label}${duration}](${escapeUrl(item.url)})`);
    if (settings.includeVideoPosters && item.posterUrl) {
      out.push(`![${escapeLinkText(item.alt ?? `${label} poster`)}](${escapeUrl(item.posterUrl)})`);
    }
  }
  return out;
}

/**
 * Meta line.
 *
 * `full`         -> `[permalink](url) · ♥ 12,345 · ↺ 678 · 💬 90 · 2006-03-21T20:50:14Z`
 * `metrics-only` -> `♥ 12,345 · ↺ 678`
 *
 * Replies and quoted tweets use `metrics-only` because their attribution line
 * already carries the permalink and the timestamp; repeating both would put the
 * same two facts twice in every quoted block.
 *
 * Unknown metrics are omitted rather than rendered as zero. Returns '' when
 * there is nothing to say, so the caller can skip the line entirely.
 */
export type MetaStyle = 'full' | 'metrics-only';

export function renderMeta(tweet: Tweet, style: MetaStyle = 'full'): string {
  const parts: string[] = [];
  if (style === 'full') parts.push(`[permalink](${escapeUrl(tweet.permalink)})`);
  const { likes, retweets, replies } = tweet.metrics;
  if (likes !== null) parts.push(`♥ ${formatCount(likes)}`);
  if (retweets !== null) parts.push(`↺ ${formatCount(retweets)}`);
  if (replies !== null) parts.push(`💬 ${formatCount(replies)}`);
  if (style === 'full' && tweet.createdAt) parts.push(tweet.createdAt);
  return parts.join(' · ');
}

export function attribution(tweet: Tweet, prefix = ''): string {
  const handle = tweet.author.handle;
  const name = `**[@${escapeLinkText(handle)}](https://x.com/${handle})**`;
  const when = tweet.createdAt ?? 'unknown date';
  return `${prefix}${name} · [${when}](${escapeUrl(tweet.permalink)})`;
}

/**
 * The body of one tweet, unquoted and undented.
 *
 * `renderQuote` is passed in rather than imported to keep the recursion in one
 * place (markdown.ts owns the quoting primitive).
 */
export function renderTweetBody(
  tweet: Tweet,
  settings: Settings,
  quote: (lines: string[], depth: number) => string[],
  style: MetaStyle = 'full',
  quoteDepth = 0,
): string[] {
  const out: string[] = [];

  const text = escapeText(tweet.text, settings.escapeMode, settings.hardLineBreaks);
  if (tweet.text.trim() !== '') out.push(...text);

  const media = renderMedia(tweet.media, settings);
  if (media.length > 0) {
    if (out.length > 0) out.push('');
    out.push(...media);
  }

  if (tweet.quoted && quoteDepth < QUOTE_RENDER_DEPTH_MAX) {
    const inner: string[] = [];
    const head = settings.obsidianCallouts
      ? `[!quote] ${attribution(tweet.quoted)}`
      : attribution(tweet.quoted, '↩ ');
    inner.push(head, '');
    // A quoted tweet's attribution already carries its permalink and date.
    inner.push(...renderTweetBody(tweet.quoted, settings, quote, 'metrics-only', quoteDepth + 1));
    if (out.length > 0) out.push('');
    out.push(...quote(inner, 1));
  }

  const meta = renderMeta(tweet, style);
  if (meta !== '') {
    if (out.length > 0) out.push('');
    out.push(meta);
  }

  return out;
}
