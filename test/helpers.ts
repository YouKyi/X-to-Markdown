// Test helpers: a Tweet factory for synthetic thread tests, and a fixture loader.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Author, Metrics, Tweet } from '../src/types/model.ts';
import { EMPTY_METRICS, permalinkFor } from '../src/types/model.ts';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadFixture(name: string): Promise<unknown> {
  const path = resolve(here, 'fixtures', name);
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadGolden(name: string): Promise<string> {
  return readFile(resolve(here, 'golden', name), 'utf8');
}

/**
 * Assert that no blockquote is broken by a bare blank line.
 *
 * A blank line inside a blockquote terminates it, so every blank line *within*
 * a reply must carry its `>` markers. The one legitimate exception is the
 * separator between two independent top-level replies: there a bare blank line
 * is exactly right, because CommonMark then starts a fresh blockquote rather
 * than merging two unrelated replies into one.
 */
export function assertBlockquotesIntact(markdown: string): void {
  const lines = markdown.split('\n');
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i] !== '') continue;
    const previous = lines[i - 1]!;
    const next = lines[i + 1]!;
    if (!previous.startsWith('>') || !next.startsWith('>')) continue;

    // Permitted only when what follows opens a new depth-1 reply.
    const startsNewReply = /^> \*\*\[@/.test(next);
    if (!startsNewReply) {
      throw new Error(
        `bare blank line inside a blockquote at line ${i + 1}:\n` +
          `  ${i}: ${previous}\n  ${i + 2}: ${next}`,
      );
    }
  }
}

export function author(handle: string, overrides: Partial<Author> = {}): Author {
  return {
    id: `u-${handle}`,
    handle,
    name: handle.charAt(0).toUpperCase() + handle.slice(1),
    avatarUrl: null,
    verified: null,
    ...overrides,
  };
}

export function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return { ...EMPTY_METRICS, reliable: true, ...overrides };
}

export interface TweetOverrides extends Partial<Omit<Tweet, 'author'>> {
  author?: Author | string;
}

/**
 * Build a Tweet with sensible defaults.
 *
 * Real Snowflake-scale ids by default: ID ordering is load-bearing in
 * assemble.ts and small sequential integers would not exercise the BigInt path.
 */
export function tweet(id: string, overrides: TweetOverrides = {}): Tweet {
  const resolved =
    typeof overrides.author === 'string'
      ? author(overrides.author)
      : (overrides.author ?? author('robin'));

  const base: Tweet = {
    id,
    conversationId: id,
    inReplyToId: null,
    inReplyToHandle: null,
    author: resolved,
    createdAt: '2026-01-01T00:00:00Z',
    text: `tweet ${id}`,
    isLongForm: false,
    lang: 'en',
    media: [],
    links: [],
    quoted: null,
    metrics: metrics(),
    permalink: permalinkFor(resolved.handle, id),
    source: 'graphql',
    partial: false,
  };

  const { author: _ignored, ...rest } = overrides;
  return { ...base, ...rest };
}

/**
 * Build a linear reply chain: each tweet replies to the previous one.
 * `handles[i]` is the author of the i-th tweet.
 */
export function chain(handles: string[], startId = 1000000000000000000n): Tweet[] {
  const tweets: Tweet[] = [];
  let previous: Tweet | null = null;
  handles.forEach((handle, index) => {
    const id = (startId + BigInt(index)).toString();
    const t = tweet(id, {
      author: handle,
      conversationId: startId.toString(),
      inReplyToId: previous ? previous.id : null,
      inReplyToHandle: previous ? previous.author.handle : null,
    });
    tweets.push(t);
    previous = t;
  });
  return tweets;
}
