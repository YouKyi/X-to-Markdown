// Article -> Markdown lines.
//
// Like every other renderer here this returns string[] and never applies
// blockquote depth: markdown.ts owns that.
//
// Two things are specific to articles. The structure is in the block type
// rather than in the text, so the heading hashes and list markers are put back
// here; and the inline styles and links arrive as ranges over the raw text,
// so a line is assembled from escaped segments rather than escaped as a whole.

import type { Article, ArticleBlock, ArticleLink, ArticleStyle } from '../types/model.ts';
import type { Settings } from '../shared/config.ts';
import { escapeLeading, escapeLine, escapeLinkText, escapeUrl } from './escape.ts';

/**
 * The article title renders one level below the document heading, so its own
 * sections have somewhere to go: `# @handle` > `## Title` > `### section`.
 */
const TITLE_LEVEL = 2;

interface Marker {
  offset: number;
  open: string;
  close: string;
}

function markersFor(block: ArticleBlock): Marker[] {
  const out: Marker[] = [];
  for (const style of block.styles as ArticleStyle[]) {
    const fence = style.style === 'bold' ? '**' : '*';
    out.push({ offset: style.offset, open: fence, close: '' });
    out.push({ offset: style.offset + style.length, open: '', close: fence });
  }
  for (const link of block.links as ArticleLink[]) {
    out.push({ offset: link.offset, open: '[', close: '' });
    out.push({ offset: link.offset + link.length, open: '', close: `](${escapeUrl(link.url)})` });
  }
  return out;
}

/**
 * Assemble one block's text with its inline markup.
 *
 * Segments are escaped individually, then joined with the generated markup:
 * escaping the joined line instead would treat our own `[`, `]` and `*` as
 * author text and backslash them.
 */
function inlineText(block: ArticleBlock, settings: Settings): string {
  const markers = markersFor(block);
  if (markers.length === 0) return escapeLinkText(block.text);

  const cuts = [...new Set([0, ...markers.map((m) => m.offset), block.text.length])].sort(
    (a, b) => a - b,
  );

  let out = '';
  for (let i = 0; i < cuts.length; i += 1) {
    const at = cuts[i]!;
    // Closers first, so a run ending where the next begins does not nest.
    for (const marker of markers) if (marker.offset === at && marker.close) out += marker.close;
    for (const marker of markers) if (marker.offset === at && marker.open) out += marker.open;
    const next = cuts[i + 1];
    if (next !== undefined) out += escapeLinkText(block.text.slice(at, next));
  }

  // Inline `*` and `_` in the author's own text are only escaped in strict
  // mode, and escapeLine is what knows that. The leading-construct pass below
  // is applied to the assembled line either way.
  if (settings.escapeMode === 'strict') return out;
  return out;
}

function renderBlock(block: ArticleBlock, settings: Settings): string[] {
  switch (block.kind) {
    case 'divider':
      return ['---'];

    case 'code':
      // Already a fenced block in X's own storage. Escaping it would put
      // backslashes inside someone's code sample.
      return (block.code ?? '').split('\n');

    case 'image': {
      if (!block.media) return [];
      const alt = escapeLinkText(block.caption ?? 'image');
      const out = [`![${alt}](${escapeUrl(block.media.url)})`];
      // The caption is the author's, and an alt attribute is not read as a
      // caption by any Markdown renderer, so it is also emitted as text.
      if (block.caption) out.push('', `*${escapeLine(block.caption, settings.escapeMode)}*`);
      return out;
    }

    case 'heading': {
      const level = Math.min(TITLE_LEVEL + (block.level ?? 2) - 1, 6);
      // X's editor bolds a whole heading as a matter of course, and a heading
      // is already bold in every renderer: emitting `### **text**` is noise the
      // author did not intend as emphasis. A bold run over PART of a heading is
      // kept, because there it does mean something.
      const heading = {
        ...block,
        styles: block.styles.filter(
          (s) => !(s.style === 'bold' && s.offset === 0 && s.length >= block.text.trim().length),
        ),
      };
      return [`${'#'.repeat(level)} ${escapeLeading(inlineText(heading, settings))}`];
    }

    case 'list-item':
      return [`- ${escapeLeading(inlineText(block, settings))}`];

    default:
      return [escapeLeading(inlineText(block, settings))];
  }
}

/**
 * The full article body.
 *
 * Blocks are separated by a blank line: X emits one block per paragraph, and
 * consecutive list items still need the separation because a hard-wrapped item
 * would otherwise be swallowed into its predecessor.
 */
export function renderArticle(article: Article, settings: Settings): string[] {
  const out: string[] = [];

  out.push(`${'#'.repeat(TITLE_LEVEL)} [${escapeLinkText(article.title)}](${escapeUrl(article.url)})`);

  if (article.coverUrl) {
    out.push('', `![${escapeLinkText(article.title)}](${escapeUrl(article.coverUrl)})`);
  }

  for (const block of article.blocks) {
    const lines = renderBlock(block, settings);
    if (lines.length === 0) continue;
    out.push('');
    out.push(...lines);
  }

  // Honesty rule: a body we could not fully read must say so rather than look
  // like the whole article.
  if (article.partial) {
    out.push('', '*… part of this article could not be read and is missing*');
  }

  return out;
}

/**
 * An article referenced rather than reproduced.
 *
 * Used wherever the article is not the document's subject - a reply or a quoted
 * tweet - because a hundred blocks nested in a blockquote buries the reply that
 * was the reason for reading.
 */
export function renderArticleReference(article: Article): string[] {
  const out = [`**[${escapeLinkText(article.title)}](${escapeUrl(article.url)})**`];
  if (article.summary) out.push('', `*${escapeLinkText(article.summary.split('\n')[0] ?? '')}*`);
  out.push('', '*article body not included*');
  return out;
}
