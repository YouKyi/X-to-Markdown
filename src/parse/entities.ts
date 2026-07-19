// t.co expansion and trailing-media stripping.

import type { LinkEntity } from '../types/model.ts';
import { arr, str } from './accessors.ts';

/**
 * Collect the url entities of one entity set.
 *
 * Long-form posts matter here: `note_tweet` carries its OWN `entity_set`, and
 * the indices and urls in `legacy.entities` do not apply to note text. Using the
 * wrong set produces missing or wrong expansions on exactly the long threads
 * this extension exists to export, so the caller always passes the entity set
 * that belongs to the text it is rendering.
 */
export function parseLinks(entitySet: unknown): LinkEntity[] {
  const out: LinkEntity[] = [];
  for (const item of arr(entitySet, 'urls')) {
    const tco = str(item, 'url');
    const expanded = str(item, 'expanded_url');
    if (!tco || !expanded) continue;
    out.push({ tco, expanded, display: str(item, 'display_url') ?? expanded });
  }
  return out;
}

/** Replace every t.co with its real destination. */
export function expandLinks(text: string, links: LinkEntity[]): string {
  let out = text;
  for (const link of links) {
    out = out.split(link.tco).join(link.expanded);
  }
  return out;
}

/**
 * Remove the trailing t.co that stands in for attached media.
 *
 * X appends one to `full_text` for the media attachment; it is a link to the
 * tweet itself, not content, and leaving it in puts a bare t.co at the end of
 * every export that has an image.
 */
export function stripMediaUrls(text: string, mediaTco: Set<string>): string {
  let out = text;
  for (const url of mediaTco) {
    out = out.split(url).join('');
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Decode the HTML entities X escapes in tweet text.
 * Only the five it actually emits — this is not a general HTML decoder, and it
 * must not become one: text goes into Markdown, never into innerHTML.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
