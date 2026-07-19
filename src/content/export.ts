// Export orchestration: store -> assemble -> render -> clipboard / download.
//
// The degradation ladder is the point of this module. Every step down produces
// output and says why, because a partial export you know about is useful and a
// silently incomplete one is worse than an error.

import type { Completeness, Tweet } from '../types/model.ts';
import type { Settings } from '../shared/config.ts';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages.ts';
import { assemble } from '../thread/assemble.ts';
import { renderMarkdown } from '../render/markdown.ts';
import { buildFilename } from '../render/filename.ts';
import { debug, warn } from '../shared/log.ts';

export interface ExportOutcome {
  ok: boolean;
  message: string;
  copied: boolean;
  downloaded: boolean;
  /** Only a page reload can help: the payload was missed and cannot be replayed. */
  needsReload?: boolean;
  markdown?: string;
  /** As written to the frontmatter. Surfaced for the debug dump. */
  warnings?: string[];
  /** Tweets in the rendered document. */
  rendered?: number;
}

/**
 * Write to the clipboard.
 *
 * This is why the manifest asks for `clipboardWrite`: after auto-scrolling for
 * a minute the original click's transient activation has long expired, and a
 * gesture-dependent writeText() would reject in exactly the case that matters
 * most.
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    warn('clipboard write failed', err);
    return false;
  }
}

async function download(filename: string, text: string): Promise<boolean> {
  try {
    // downloads.download() is not available to content scripts; the background
    // event page owns it, and it is the only place that can make a blob URL.
    const response = await browser.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({
      kind: 'download',
      filename,
      text,
      saveAs: false,
    });
    if (response.ok) return true;
    warn('download failed', response.error);
    return false;
  } catch (err) {
    warn('download message failed', err);
    return false;
  }
}

function summarise(outcome: { copied: boolean; downloaded: boolean }, tweets: number): string {
  const parts: string[] = [];
  if (outcome.copied) parts.push('copied');
  if (outcome.downloaded) parts.push('downloaded');
  const what = parts.length > 0 ? parts.join(' and ') : 'rendered';
  return `${tweets} tweet${tweets === 1 ? '' : 's'} ${what}.`;
}

export interface ExportInput {
  tweets: Tweet[];
  focalId: string;
  settings: Settings;
  version: string;
  /** Injected so the caller controls the timestamp and tests stay deterministic. */
  capturedAt?: string;
  /** Step 3 of the degradation ladder. Injected so this stays DOM-free. */
  scrapeDom?: () => Tweet[];
  /** Reported by the collection pass; recorded in the frontmatter. */
  collection?: Completeness;
  /** "Show more" branches the parser saw and the collection pass did not open. */
  collapsedBranches?: number;
}

/**
 * Keep only the conversation the user is looking at.
 *
 * The store is append-only across SPA navigation, so after browsing two threads
 * it holds both. Filtering here rather than clearing on navigation is what makes
 * that safe: it cannot race with an arriving payload, and it is exact.
 *
 * Tweets with no conversation id — everything the DOM fallback produces — are
 * kept only when nothing else identifies them, since dropping them would leave
 * that path with nothing at all.
 */
function sameConversation(tweets: Tweet[], focalId: string): Tweet[] {
  const focal = tweets.find((t) => t.id === focalId);
  const conversation = focal ? (focal.conversationId ?? focal.id) : null;
  if (!conversation) return tweets;

  const kept = tweets.filter(
    (t) => t.id === focalId || t.conversationId === conversation || t.conversationId === null,
  );
  return kept.length > 0 ? kept : tweets;
}

export async function runExport(input: ExportInput): Promise<ExportOutcome> {
  const { focalId, settings, version } = input;
  let tweets = sameConversation(input.tweets, focalId);
  let degraded: string | null = null;

  // Step 3 of the ladder: interception produced nothing, so read what is on
  // screen. Strictly worse — no long-form text, no expanded links, no reliable
  // metrics — but a flagged partial document beats an error.
  if (tweets.length === 0) {
    tweets = input.scrapeDom?.() ?? [];
    if (tweets.length > 0) {
      degraded =
        'Read from the page instead of the network: long posts are truncated and links are not expanded.';
    }
  }

  // Step 4: nothing anywhere. The caller offers a reload, which is the only
  // thing that actually helps — the payload was missed and cannot be replayed.
  if (tweets.length === 0) {
    return {
      ok: false,
      copied: false,
      downloaded: false,
      needsReload: true,
      message: 'Nothing captured for this page. Reload it and try again.',
    };
  }

  const hasFocal = tweets.some((t) => t.id === focalId);

  // A DOM scrape that does not contain the tweet whose URL we are on is not a
  // partial capture of this conversation — it is the previous page's articles,
  // still rendered because X had not recycled them yet. Exporting "the rest"
  // there produced a document attributing one thread's replies to another
  // thread's author, which is worse than no document.
  if (degraded && !hasFocal) {
    return {
      ok: false,
      copied: false,
      downloaded: false,
      needsReload: true,
      message: 'The page has not settled on this post yet. Reload it and try again.',
    };
  }

  // Step 2 of the ladder: the conversation was captured but the focal tweet was
  // not. Export what exists rather than failing, and say so.
  const anchor = hasFocal ? focalId : pickAnchor(tweets);
  if (!anchor) {
    return {
      ok: false,
      copied: false,
      downloaded: false,
      message: 'Captured data has no usable root tweet.',
    };
  }

  const doc = assemble(tweets, anchor, {
    maxDepth: settings.maxDepth,
    maxChildrenPerNode: settings.maxChildrenPerNode,
    maxTweets: settings.maxTweets,
    ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    // The DOM fallback only ever sees what is on screen, so it can never claim
    // to have the whole conversation whatever the collection pass reported.
    collection: degraded ? 'partial' : (input.collection ?? 'unknown'),
  });

  // Stated separately from the metrics-derived uncaptured count, because this
  // one is observed rather than inferred: X marked those branches as having more
  // behind them. Not a number — see PayloadStore#collapsedBranches for why the
  // count over-reports once a branch has been expanded.
  if ((input.collapsedBranches ?? 0) > 0) {
    doc.warnings.push(
      'Some reply branches were collapsed behind a "show more" control and were not expanded.',
    );
  }

  if (!hasFocal) {
    doc.warnings.unshift('The focal tweet was not captured; exported the rest of the conversation.');
  }
  if (degraded) doc.warnings.unshift(degraded);

  const markdown = renderMarkdown(doc, settings, version);
  const filename = buildFilename(settings.filenameTemplate, doc.focal, doc.capturedAt);
  debug('rendered', markdown.length, 'chars ->', filename);

  const wantsClipboard = settings.action === 'clipboard' || settings.action === 'both';
  const wantsDownload = settings.action === 'download' || settings.action === 'both';

  const copied = wantsClipboard ? await copy(markdown) : false;
  const downloaded = wantsDownload ? await download(filename, markdown) : false;

  if (wantsClipboard && !copied && !downloaded) {
    return {
      ok: false,
      copied,
      downloaded,
      markdown,
      warnings: doc.warnings,
      rendered: doc.stats.rendered,
      message: 'Clipboard write was refused.',
    };
  }

  let message = summarise({ copied, downloaded }, doc.stats.rendered);
  if (doc.stats.truncated > 0) message += ` ${doc.stats.truncated} not included (limits).`;
  if (!hasFocal) message += ' Focal tweet missing.';
  // Degradation is stated first: it changes what the document is, not just how
  // much of it there is.
  if (degraded) message = `Degraded export. ${message}`;

  return {
    ok: true,
    copied,
    downloaded,
    markdown,
    warnings: doc.warnings,
    rendered: doc.stats.rendered,
    message,
  };
}

/** Lowest id in the largest conversation — the best guess at a root. */
function pickAnchor(tweets: Tweet[]): string | null {
  const counts = new Map<string, Tweet[]>();
  for (const tweet of tweets) {
    const key = tweet.conversationId ?? tweet.id;
    const bucket = counts.get(key);
    if (bucket) bucket.push(tweet);
    else counts.set(key, [tweet]);
  }

  let best: Tweet[] = [];
  for (const bucket of counts.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  if (best.length === 0) return null;

  return best.reduce((lowest, tweet) => {
    try {
      return BigInt(tweet.id) < BigInt(lowest.id) ? tweet : lowest;
    } catch {
      return tweet.id < lowest.id ? tweet : lowest;
    }
  }).id;
}
