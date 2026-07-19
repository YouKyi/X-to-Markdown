// The only module in the codebase that knows about Markdown or YAML escaping.
// Parsers never emit markup; renderers call in here.

import type { EscapeMode } from '../shared/config.ts';

/**
 * A line the author meant as a list item: `- foo`, `* foo`, `+ foo`, `1. foo`.
 *
 * These are deliberately NOT escaped. Tweets use `- ` as a bullet constantly,
 * and rendering the author's list as a list is the whole point of exporting to
 * Markdown. Escaping it would be literal fidelity at the cost of meaning.
 */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/**
 * `---`, `***`, `___` on their own line.
 *
 * This one MUST stay escaped: an unescaped `---` in tweet text would render as
 * a horizontal rule, and - far worse - a `---` immediately after the frontmatter
 * would be read as a second document delimiter and corrupt the whole file.
 */
const THEMATIC_BREAK = /^(\s*)([-*_])((?:\s*\2){2,}\s*)$/;

/** `# heading` - only with the trailing space. `#hashtag` is not a heading. */
const ATX_HEADING = /^(\s*)(#{1,6})(\s)/;

/** `>` starts a blockquote and `|` can start a GFM table row. */
const LEADING_BLOCK = /^(\s*)([>|])/;

/** Inline emphasis and code characters, escaped only in strict mode. */
const INLINE = /([*_[\]`])/g;

/**
 * Escape one line of tweet text for Markdown.
 *
 * `minimal` (the default) escapes only what would change the document's
 * structure against the author's intent. Inline `*` and `_` are left alone:
 * tweet text is prose, and escaping them aggressively produces visually noisy
 * output for a near-zero collision rate.
 */
export function escapeLine(line: string, mode: EscapeMode = 'minimal'): string {
  let out = line;
  if (mode === 'strict') out = out.replace(INLINE, '\\$1');

  if (THEMATIC_BREAK.test(out)) return out.replace(THEMATIC_BREAK, '$1\\$2$3');
  if (LIST_ITEM.test(out)) return out;

  out = out.replace(ATX_HEADING, '$1\\$2$3');
  out = out.replace(LEADING_BLOCK, '$1\\$2');
  return out;
}

/**
 * Escape a block of tweet text, optionally forcing hard line breaks.
 *
 * Tweets separate lines with a single newline. Under strict CommonMark those
 * collapse into one paragraph, which loses the author's line structure - a real
 * fidelity loss on posts that are written as short lines. Two trailing spaces
 * force a `<br>` in every renderer.
 *
 * Skipped between consecutive list items, where the list markup already puts
 * each item on its own line and the trailing spaces would be pure noise.
 */
export function escapeText(
  text: string,
  mode: EscapeMode = 'minimal',
  hardBreaks = true,
): string[] {
  // Trailing whitespace is normalised away first: tweet text often carries a
  // stray space at end of line, and appending two more would leave three.
  const lines = text.split('\n').map((line) => escapeLine(line.trimEnd(), mode));
  if (!hardBreaks) return lines;

  return lines.map((line, index) => {
    const next = lines[index + 1];
    if (next === undefined || next === '' || line === '') return line;
    if (LIST_ITEM.test(line) && LIST_ITEM.test(next)) return line;
    return `${line}  `;
  });
}

/** Characters that force a YAML scalar to be quoted when they lead the value. */
const YAML_LEADING_SPECIALS = new Set([
  '[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`', '#', '-', '?', ':', ',', "'", '"',
]);

/**
 * Emit a YAML scalar, quoting when required.
 *
 * Newlines are stripped rather than emitted as a block scalar: display names
 * occasionally contain them, and a one-line frontmatter value is always safe
 * whereas a mis-indented block scalar corrupts the whole document.
 */
export function yamlScalar(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ');
  const needsQuote =
    flat === '' ||
    flat !== flat.trim() ||
    flat.includes(': ') ||
    flat.includes(' #') ||
    flat.includes('"') ||
    flat.includes('\\') ||
    flat.endsWith(':') ||
    YAML_LEADING_SPECIALS.has(flat.charAt(0)) ||
    // Bare words that YAML would coerce to a non-string type.
    /^(true|false|null|yes|no|on|off|~)$/i.test(flat) ||
    /^[+-]?(\d|\.\d)/.test(flat);

  if (!needsQuote) return flat;
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape text used as the label of a Markdown link. */
export function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

/** Escape a URL for use inside `(...)` in a Markdown link. */
export function escapeUrl(url: string): string {
  if (/[\s()]/.test(url)) return `<${url.replace(/>/g, '%3E')}>`;
  return url;
}
