// Last-resort DOM scraper.
//
// This produces the same Tweet shape as the GraphQL parser so the renderer has
// one input contract, but it is strictly worse and says so: `source: 'dom'`,
// `partial: true`, and metrics omitted by default.
//
// It is worse in ways that cannot be fixed by trying harder:
//
//   - Long-form posts are TRUNCATED in the DOM, behind a "Show more" control.
//     The full text simply is not there to be read.
//   - t.co links cannot be expanded; the real destination is not in the markup.
//   - Engagement counts exist only in localised, abbreviated aria-labels
//     ("12,3 k"), so they are unreliable by construction.
//
// This is also the least stable code in the project. It is pinned by tests only
// where the logic is real (permalink parsing, text reconstruction); the
// selector walk itself is verified by hand, because any X redesign rewrites it
// and tests over it would be rewritten with it.

import type { Author, Media, Tweet } from '../types/model.ts';
import { EMPTY_METRICS, permalinkFor } from '../types/model.ts';
import { originalResolution } from './media.ts';
import { shape } from '../shared/log.ts';

const ARTICLE = 'article[data-testid="tweet"], article';
const TWEET_TEXT = '[data-testid="tweetText"]';
const PHOTO = '[data-testid="tweetPhoto"] img';

/** `/handle/status/1234` -> its parts. The most reliable identity in the DOM. */
export function parsePermalink(href: string): { handle: string; id: string } | null {
  const match = /^(?:https?:\/\/(?:x|twitter)\.com)?\/([^/]+)\/status\/(\d+)/.exec(href);
  if (!match) return null;
  return { handle: match[1]!, id: match[2]! };
}

/**
 * Reconstruct the text of a tweetText node.
 *
 * Not textContent: X renders emoji as <img alt="🙂">, which textContent drops
 * entirely, and renders line breaks as <br> or nested spans rather than
 * newlines.
 */
export function textOf(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? '';
      continue;
    }
    if (child.nodeType !== 1) continue;

    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      out += el.getAttribute('alt') ?? '';
      continue;
    }
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    out += textOf(el);
  }
  return out;
}

/**
 * Best-effort engagement counts from the action bar's aria-label.
 *
 * Off by default. The label is localised and abbreviated, so "12,3 k" and
 * "12.3K" and "1,2 万" all mean different things in different locales and none
 * of them round-trip to an exact number. A missing metric is recoverable; a
 * wrong one written silently into someone's notes is not.
 */
function scrapeMetrics(article: Element): Tweet['metrics'] {
  const group = article.querySelector('[role="group"][aria-label]');
  const label = group?.getAttribute('aria-label') ?? '';
  if (label === '') return { ...EMPTY_METRICS };

  const read = (keys: string[]): number | null => {
    for (const key of keys) {
      // Matches "17 replies" and "17 réponses" alike, but only exact integers:
      // anything abbreviated is left as unknown rather than guessed at.
      const match = new RegExp(`(\\d[\\d\\s.,]*)\\s*${key}`, 'i').exec(label);
      if (!match) continue;
      const digits = match[1]!.replace(/[\s.,]/g, '');
      const value = Number(digits);
      if (Number.isSafeInteger(value)) return value;
    }
    return null;
  };

  return {
    // X renders the French label with a typographic apostrophe (U+2019), not
    // the ASCII one, so the class matches both.
    likes: read(['likes?', 'j[\u2019\u0027]?aime', 'me gusta', 'gefällt']),
    retweets: read(['reposts?', 'retweets?', 'partages?']),
    replies: read(['repl(?:y|ies)', 'réponses?', 'respuestas?']),
    quotes: null,
    bookmarks: null,
    views: null,
    reliable: false,
  };
}

function scrapeAuthor(article: Element, handle: string): Author {
  const nameBlock = article.querySelector('[data-testid="User-Name"]');
  // The display name is the first text run in the block; everything after it is
  // the @handle and the timestamp.
  const first = nameBlock?.querySelector('span');
  const name = first ? textOf(first).trim() : handle;

  return {
    // The DOM never exposes a user rest_id, which is why thread assembly falls
    // back to comparing handles.
    id: null,
    handle,
    name: name === '' ? handle : name,
    avatarUrl: article.querySelector('img[src*="profile_images"]')?.getAttribute('src') ?? null,
    verified: article.querySelector('[data-testid="icon-verified"]') ? true : null,
  };
}

function scrapeMedia(article: Element): Media[] {
  const out: Media[] = [];
  for (const img of article.querySelectorAll(PHOTO)) {
    const src = img.getAttribute('src');
    if (!src) continue;
    out.push({
      kind: 'photo',
      url: originalResolution(src),
      posterUrl: null,
      alt: img.getAttribute('alt') || null,
      width: null,
      height: null,
      durationMs: null,
      tcoUrl: null,
    });
  }
  if (article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) {
    // The mp4 variants are not in the markup, only a blob: URL bound to the
    // player. Recording that the media exists beats pretending it does not.
    shape('dom-video-unreachable');
  }
  return out;
}

export interface DomScrapeOptions {
  /** Attempt engagement counts. Off by default; see scrapeMetrics. */
  metrics?: boolean;
}

/** Scrape every tweet article currently in the DOM. Never throws. */
export function scrapeDom(root: ParentNode = document, options: DomScrapeOptions = {}): Tweet[] {
  const out: Tweet[] = [];
  const seen = new Set<string>();

  for (const article of root.querySelectorAll(ARTICLE)) {
    try {
      const time = article.querySelector('time[datetime]');
      const href = time?.parentElement?.getAttribute('href') ?? '';
      const identity = parsePermalink(href);
      if (!identity || seen.has(identity.id)) continue;
      seen.add(identity.id);

      // A quoted tweet is nested inside its quoter's article and has its own
      // tweetText, so taking every match would double-count it as body text.
      // The first one belongs to this tweet.
      const textNode = article.querySelector(TWEET_TEXT);
      const text = textNode ? textOf(textNode).trim() : '';

      const author = scrapeAuthor(article, identity.handle);

      out.push({
        id: identity.id,
        // Neither is in the markup. Assembly copes: an uncaptured parent yields
        // an orphan, which is reported rather than hidden.
        conversationId: null,
        inReplyToId: null,
        inReplyToHandle: null,
        author,
        createdAt: time?.getAttribute('datetime') ?? null,
        text,
        // The DOM cannot hold a long-form post: it is truncated behind a
        // "Show more" control, which is the whole reason GraphQL is primary.
        isLongForm: false,
        lang: article.querySelector('[lang]')?.getAttribute('lang') ?? null,
        media: scrapeMedia(article),
        // t.co destinations are not in the markup, so nothing can be expanded.
        links: [],
        quoted: null,
        metrics: options.metrics ? scrapeMetrics(article) : { ...EMPTY_METRICS },
        permalink: permalinkFor(identity.handle, identity.id),
        source: 'dom',
        // Always. A DOM-scraped tweet is missing fields by construction, and
        // the frontmatter should say so.
        partial: true,
      });
    } catch (err) {
      shape('dom-scrape-threw', err);
    }
  }

  return out;
}
