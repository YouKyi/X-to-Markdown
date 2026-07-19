// Hand-rolled YAML frontmatter emitter.
//
// A YAML dependency would be a runtime dependency shipped inside the XPI, for
// the sake of emitting perhaps twenty scalars, one map and two lists. The rules
// we need fit in this file; the ones we do not need (anchors, block scalars,
// flow collections, multi-document streams) are ones we deliberately never emit.

import type { ThreadDoc } from '../types/model.ts';
import type { Settings } from '../shared/config.ts';
import { yamlScalar } from './escape.ts';

/** ISO date -> YYYY-MM-DD. Returns '' for null/unparseable input. */
export function isoDay(iso: string | null): string {
  if (!iso) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match?.[1] ?? '';
}

function line(key: string, value: string): string {
  return `${key}: ${value}`;
}

export function renderFrontmatter(doc: ThreadDoc, settings: Settings, version: string): string[] {
  const { focal, stats } = doc;
  const out: string[] = ['---'];

  out.push(line('url', yamlScalar(focal.permalink)));
  // Snowflakes exceed the safe integer range in both JS and YAML, so ids are
  // always quoted strings. An unquoted 1948573926184756002 would round-trip wrong.
  out.push(line('tweet_id', yamlScalar(focal.id)));
  if (focal.conversationId) out.push(line('conversation_id', yamlScalar(focal.conversationId)));
  out.push(line('author', yamlScalar(focal.author.name)));
  out.push(line('handle', yamlScalar(`@${focal.author.handle}`)));
  out.push(line('author_url', yamlScalar(`https://x.com/${focal.author.handle}`)));
  // A bare YYYY-MM-DD is a Date property in Obsidian and therefore sortable and
  // queryable; a full ISO timestamp with a zone is only ever text. Emit both, so
  // nothing is lost and the common case is usable.
  if (focal.createdAt) {
    out.push(line('date', isoDay(focal.createdAt)));
    out.push(line('posted_at', yamlScalar(focal.createdAt)));
  }
  out.push(line('captured', yamlScalar(doc.capturedAt)));

  // Flat, not a nested map. Obsidian's property system handles text, list,
  // number, checkbox and date — a nested mapping is displayed as a raw JSON
  // blob and cannot be sorted or queried, which defeats the point of putting
  // metrics in the frontmatter at all.
  const metrics: [string, number | null][] = [
    ['likes', focal.metrics.likes],
    ['retweets', focal.metrics.retweets],
    ['replies', focal.metrics.replies],
    ['quotes', focal.metrics.quotes],
    ['bookmarks', focal.metrics.bookmarks],
    ['views', focal.metrics.views],
  ];
  // null means "unknown" and is omitted; 0 means zero and is emitted.
  for (const [key, value] of metrics) {
    if (value !== null) out.push(line(key, String(value)));
  }
  out.push(line('metrics_reliable', String(focal.metrics.reliable)));

  out.push(line('thread_length', String(doc.selfThread.length)));

  // Scope first, because it decides how to read everything under it. On an
  // author-thread export the reply counts are omitted rather than written as
  // zero: `replies_captured: 0` on a post with 138 replies states something
  // false about the capture, when the truth is that none were asked for.
  out.push(line('scope', doc.scope));
  if (doc.scope === 'conversation') {
    out.push(line('replies_captured', String(Math.max(0, stats.rendered - doc.selfThread.length))));
    if (stats.truncated > 0) out.push(line('truncated', String(stats.truncated)));
    // Replies X says exist that were never loaded — the signal that a branch is
    // still folded behind a "show replies" control somewhere in the thread.
    if (stats.uncaptured > 0) out.push(line('replies_not_captured', String(stats.uncaptured)));
  }
  out.push(line('source', stats.source));
  // Whether the whole conversation was reached. The one field that tells you
  // if this archive can be trusted as the complete thread.
  out.push(line('collection', doc.collection));
  // Provenance: makes it possible to re-parse or migrate old exports later.
  out.push(line('exporter', yamlScalar(`x-thread-md/${version}`)));

  if (settings.tags.length > 0) {
    out.push('tags:');
    for (const tag of settings.tags) out.push(`  - ${yamlScalar(tag)}`);
  }

  if (doc.warnings.length > 0) {
    out.push('warnings:');
    for (const warning of doc.warnings) out.push(`  - ${yamlScalar(warning)}`);
  }

  out.push('---');
  return out;
}
