// ThreadDoc -> Markdown.
//
// This module owns the blockquote-depth invariant, which is the single most
// likely place for a rendering bug: a blank line *inside* a blockquote must
// still carry its `>` markers, or the quote silently terminates and every
// following line escapes to the top level. That is why exactly one function
// applies depth and nothing else in the codebase concatenates quoted strings.

import type { ThreadDoc, ThreadNode } from '../types/model.ts';
import type { Settings } from '../shared/config.ts';
import { renderFrontmatter, isoDay } from './frontmatter.ts';
import { renderTweetBody, attribution } from './tweetblock.ts';

/** The one place blockquote depth is applied. */
export function quote(lines: string[], depth: number): string[] {
  if (depth <= 0) return [...lines];
  const marker = '> '.repeat(depth);
  return lines.map((line) => (line === '' ? marker.trimEnd() : marker + line));
}

function truncationNote(count: number): string {
  return `*… ${count} more repl${count === 1 ? 'y' : 'ies'} dropped by a collection limit*`;
}

/**
 * Marker for a branch X says exists but that was never loaded.
 *
 * Worded as a report rather than a failure: the gap also covers replies that
 * are deleted, hidden or from muted accounts, which no amount of scrolling
 * would ever reach.
 */
function uncapturedNote(count: number): string {
  return `*… X reports ${count} more repl${count === 1 ? 'y' : 'ies'} here, not captured*`;
}

function renderReply(node: ThreadNode, settings: Settings): string[] {
  const inner: string[] = [attribution(node.tweet), ''];
  // The attribution line above already carries the permalink and the timestamp.
  inner.push(...renderTweetBody(node.tweet, settings, quote, 'metrics-only'));

  if (node.orphan) inner.push('', '*parent tweet was not captured*');

  const out = quote(inner, node.depth);

  for (const child of node.children) {
    out.push(...quote([''], node.depth));
    out.push(...renderReply(child, settings));
  }

  if (node.truncatedChildren > 0) {
    out.push(...quote([''], node.depth));
    out.push(...quote([truncationNote(node.truncatedChildren)], node.depth + 1));
  }

  if (node.uncapturedReplies > 0) {
    out.push(...quote([''], node.depth));
    out.push(...quote([uncapturedNote(node.uncapturedReplies)], node.depth + 1));
  }

  return out;
}

export function renderMarkdown(doc: ThreadDoc, settings: Settings, version: string): string {
  const lines: string[] = [];

  lines.push(...renderFrontmatter(doc, settings, version));
  lines.push('');

  const day = isoDay(doc.focal.createdAt) || isoDay(doc.capturedAt);
  lines.push(`# @${doc.root.tweet.author.handle}${day ? ` - ${day}` : ''}`);
  lines.push('');

  // The self-thread renders as top-level sections separated by `---`, never as
  // blockquotes: it is the document's main content, not a reply to it.
  doc.selfThread.forEach((tweet, index) => {
    if (index > 0) lines.push('---', '');
    lines.push(...renderTweetBody(tweet, settings, quote));
    lines.push('');
  });

  // Everything hanging off the spine is a reply. Collect the children of every
  // spine node that is not itself on the spine.
  //
  // Spine nodes are rendered above as top-level sections, so they never pass
  // through renderReply - their own truncation counts have to be gathered here
  // or a capped export would look complete.
  const replies: ThreadNode[] = [];
  let spineTruncated = 0;
  let spineUncaptured = 0;
  const collect = (node: ThreadNode): void => {
    spineTruncated += node.truncatedChildren;
    spineUncaptured += node.uncapturedReplies;
    for (const child of node.children) {
      if (child.isSelfThread) collect(child);
      else replies.push(child);
    }
  };
  collect(doc.root);

  if (replies.length > 0 || spineTruncated > 0 || spineUncaptured > 0) {
    lines.push('## Replies');
    lines.push('');
    replies.forEach((node, index) => {
      if (index > 0) lines.push('');
      // Replies to spine tweets deeper than the root would otherwise render at
      // their absolute depth; rebase so the shallowest reply sits at depth 1.
      lines.push(...renderReply(rebase(node, 1), settings));
    });
    // Notes about the thread as a whole render at the top level, not as
    // blockquotes: they are the document talking about itself, not part of any
    // reply. Quoting them would also require a bare blank line to separate them
    // from the preceding reply, which is exactly what breaks a blockquote.
    if (spineTruncated > 0) {
      if (replies.length > 0) lines.push('');
      lines.push(truncationNote(spineTruncated));
    }
    if (spineUncaptured > 0) {
      if (replies.length > 0 || spineTruncated > 0) lines.push('');
      lines.push(uncapturedNote(spineUncaptured));
    }
    lines.push('');
  }

  // Trailing newline, LF only.
  return lines.join('\n').replace(/\n{3,}$/, '\n') + (lines[lines.length - 1] === '' ? '' : '\n');
}

/** Return a copy of the subtree with depths shifted so `node` sits at `depth`. */
function rebase(node: ThreadNode, depth: number): ThreadNode {
  if (node.depth === depth) return node;
  const shift = depth - node.depth;
  const walk = (n: ThreadNode): ThreadNode => ({
    ...n,
    depth: n.depth + shift,
    children: n.children.map(walk),
  });
  return walk(node);
}
