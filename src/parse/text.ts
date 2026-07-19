// Picks the text to render and applies the entity work in the right order.

import type { LinkEntity } from '../types/model.ts';
import { arr, get, str } from './accessors.ts';
import { parseLinks, expandLinks, stripMediaUrls, decodeEntities } from './entities.ts';
import { mediaTcoUrls } from './media.ts';

export interface ParsedText {
  text: string;
  isLongForm: boolean;
  links: LinkEntity[];
}

/**
 * `legacy.display_text_range` marks the substring that is the actual post,
 * excluding the leading @mentions of a reply and the trailing media t.co.
 * Indices are in code points, not UTF-16 units, so slicing needs the spread.
 */
function applyDisplayRange(text: string, legacy: unknown): string {
  const range = arr(legacy, 'display_text_range');
  if (range.length !== 2) return text;
  const [start, end] = range;
  if (typeof start !== 'number' || typeof end !== 'number') return text;
  const points = [...text];
  if (start < 0 || end > points.length || start > end) return text;
  return points.slice(start, end).join('');
}

export function parseText(tweetResult: unknown): ParsedText {
  const legacy = get(tweetResult, 'legacy');

  // Long-form ("note") posts carry the full text; legacy.full_text is truncated
  // with a trailing t.co. Always prefer the note when present — this is the
  // whole reason to intercept GraphQL rather than scrape the DOM.
  const noteResult = get(tweetResult, 'note_tweet.note_tweet_results.result');
  const noteText = str(noteResult, 'text');

  if (noteText !== null) {
    // The note has its own entity set; legacy.entities does not apply to it.
    const links = parseLinks(get(noteResult, 'entity_set'));
    return {
      text: decodeEntities(expandLinks(noteText, links)).trim(),
      isLongForm: true,
      links,
    };
  }

  const raw = str(legacy, 'full_text') ?? '';
  const links = parseLinks(get(legacy, 'entities'));
  const ranged = applyDisplayRange(raw, legacy);
  const expanded = expandLinks(ranged, links);
  const stripped = stripMediaUrls(expanded, mediaTcoUrls(legacy));

  return { text: decodeEntities(stripped), isLongForm: false, links };
}
