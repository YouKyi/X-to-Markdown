// X Articles: the Draft.js content state a tweet carries instead of body text.
//
// The fixture is synthetic on purpose. Its structure mirrors a real capture
// field for field - the entity table in particular - but none of the prose is
// anyone's: an article is somebody's writing, and this repository is public.
//
// The cases pinned here are the ones a reasoned implementation gets wrong. Each
// assertion says which.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../src/parse/dispatch.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import type { Settings } from '../src/shared/config.ts';
import type { Article, Tweet } from '../src/types/model.ts';
import { loadFixture, tweet } from './helpers.ts';
import { setDebug, resetShapes, seenShapeKeys } from '../src/shared/log.ts';

const AT = '2026-07-19T14:03:11Z';
const FOCAL = '1900000000000000501';
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...over });

async function parseFixture(): Promise<Tweet> {
  const { tweets } = dispatch(await loadFixture('tweetdetail-article.json'));
  const focal = tweets.find((t) => t.id === FOCAL);
  assert.ok(focal, 'focal tweet missing from the fixture');
  return focal;
}

async function article(): Promise<Article> {
  const focal = await parseFixture();
  assert.ok(focal.article, 'no article parsed off the tweet');
  return focal.article;
}

function render(tweets: Tweet[], focalId: string, over: Partial<Settings> = {}): string {
  const doc = assemble(tweets, focalId, { ...DEFAULT_CAPS, capturedAt: AT });
  return renderMarkdown(doc, settings(over), '0.1.0');
}

describe('parse - article', () => {
  it('reads the article a tweet carries, whose body is not in full_text', async () => {
    const focal = await parseFixture();
    // The whole bug: the tweet text is one t.co and nothing else.
    assert.equal(focal.text, 'https://x.com/i/article/1899000000000000042');
    assert.equal(focal.article?.title, 'Notes on running a small mail server');
    assert.equal(focal.article?.id, '1899000000000000042');
    assert.equal(focal.article?.url, 'https://x.com/i/article/1899000000000000042');
  });

  it('resolves entities by their key, not by their position in entityMap', async () => {
    // In the fixture, as in a real capture, entityMap is a list of {key, value}
    // whose order has nothing to do with the keys: entity key 0 sits at index 1.
    // Indexing by position would put the divider's payload on the link.
    const parsed = await article();
    const paragraph = parsed.blocks.find((b) => b.links.length > 0);
    assert.ok(paragraph, 'no block carried a link');
    assert.equal(paragraph.links[0]?.url, 'https://example.com/operator-handbook');
  });

  it('joins an image to media_entities through mediaId, and keeps its caption', async () => {
    const parsed = await article();
    const images = parsed.blocks.filter((b) => b.kind === 'image');
    assert.equal(images.length, 2);
    // Entity key 1 (index 3) is the captioned one; key 3 (index 0) is not.
    assert.equal(images[0]?.media?.url, 'https://pbs.twimg.com/media/INLINE901.jpg');
    assert.equal(images[0]?.caption, 'The rack, before the second PSU.');
    assert.equal(images[1]?.media?.url, 'https://pbs.twimg.com/media/INLINE902.jpg');
    assert.equal(images[1]?.caption, null);
    assert.equal(images[0]?.media?.width, 1200);
  });

  it('trims the leading space X includes in a link range', async () => {
    const parsed = await article();
    const block = parsed.blocks.find((b) => b.links.length > 0)!;
    const link = block.links[0]!;
    const anchor = block.text.slice(link.offset, link.offset + link.length);
    assert.equal(anchor, 'the operator handbook');
    assert.equal(anchor, anchor.trim(), 'anchor still carries surrounding space');
  });

  it('links @mentions, which arrive in block.data rather than as entities', async () => {
    // Measured on a real capture: fromIndex points AT the '@', toIndex is
    // exclusive, and `text` is the handle without the sigil. Reading these as
    // an entity range - which is what the rest of the inline work uses - finds
    // nothing, and the mention silently renders as plain text.
    const parsed = await article();
    const block = parsed.blocks.find((b) => b.text.startsWith('Thanks to'));
    assert.ok(block, 'mention block missing from the fixture');
    const mention = block.links[0];
    assert.ok(mention, 'mention was not turned into a link');
    assert.equal(mention.url, 'https://x.com/robin');
    assert.equal(block.text.slice(mention.offset, mention.offset + mention.length), '@robin');
  });

  it('keeps a MARKDOWN entity verbatim, fences included', async () => {
    const parsed = await article();
    const code = parsed.blocks.find((b) => b.kind === 'code');
    assert.equal(code?.code, '```sh\npostconf -n | grep smtpd_tls\n```');
    assert.equal(code?.text, '', 'code carries no escapable text');
  });

  it('reads a DIVIDER as a block rather than dropping it', async () => {
    const parsed = await article();
    assert.equal(parsed.blocks.filter((b) => b.kind === 'divider').length, 1);
  });

  it('carries the cover and X own summary', async () => {
    const parsed = await article();
    assert.equal(parsed.coverUrl, 'https://pbs.twimg.com/media/COVER900.jpg');
    assert.match(parsed.summary ?? '', /DNS is most of the job/);
  });

  it('marks the article partial on an unknown block type and says which', async () => {
    setDebug(true);
    resetShapes();
    const parsed = await article();
    const shapes = seenShapeKeys();
    setDebug(false);
    // The fixture holds a `code-block`, which X does not send today. Meeting one
    // must degrade the article rather than the tweet, and must be reported.
    assert.equal(parsed.partial, true);
    assert.ok(
      shapes.includes('article-block:code-block'),
      `expected article-block:code-block, got ${shapes.join(', ')}`,
    );
  });

  it('propagates a partial article into the tweet', async () => {
    const focal = await parseFixture();
    assert.equal(focal.partial, true);
  });
});

describe('render - article', () => {
  it('renders the body, not the bare link the tweet holds', async () => {
    const focal = await parseFixture();
    const out = render([focal], FOCAL);

    assert.ok(
      !out.includes('\nhttps://x.com/i/article/1899000000000000042\n'),
      'the article URL was emitted as body text next to the article it introduces',
    );
    assert.ok(
      out.includes('## [Notes on running a small mail server](https://x.com/i/article/1899000000000000042)'),
      'article title missing',
    );
    assert.ok(out.includes('![Notes on running a small mail server](https://pbs.twimg.com/media/COVER900.jpg)'));
  });

  it('puts the structure back that the block types carry', async () => {
    const focal = await parseFixture();
    const out = render([focal], FOCAL);

    // header-two sits one level below the article title, which sits one below
    // the document heading.
    // X bolds the whole heading; a heading is already bold, so the run is
    // dropped rather than rendered as `### **...**`.
    assert.ok(out.includes('### DNS is most of the job'), 'heading level or bold noise wrong');
    assert.ok(out.includes('- SPF, DKIM and DMARC, in that order'), 'list marker missing');
    assert.ok(out.includes('\n---\n'), 'divider missing');
    assert.ok(out.includes('```sh\npostconf -n | grep smtpd_tls\n```'), 'code block altered');
    assert.ok(
      out.includes('![The rack, before the second PSU.](https://pbs.twimg.com/media/INLINE901.jpg)'),
      'image or caption missing',
    );
  });

  it('applies inline styles and links as markup', async () => {
    const focal = await parseFixture();
    const out = render([focal], FOCAL);
    assert.ok(out.includes('[the operator handbook](https://example.com/operator-handbook)'));
    assert.ok(out.includes('[@robin](https://x.com/robin)'), 'mention not rendered as a link');
    assert.ok(!out.includes('[ the operator handbook]'), 'link text starts with a space');
    assert.ok(out.includes('**year**'), 'bold run missing');
    assert.ok(out.includes('*in, the*'), 'italic run missing');
  });

  it('escapes a paragraph that would otherwise open a heading or a quote', async () => {
    const focal = await parseFixture();
    const out = render([focal], FOCAL);
    assert.ok(out.includes('\\# not a heading, and > not a quote'), 'leading # not escaped');
  });

  it('says so when part of the body could not be read', async () => {
    const focal = await parseFixture();
    const out = render([focal], FOCAL);
    assert.match(out, /part of this article could not be read/);
  });

  it('reduces an article to a reference when it is quoted rather than the subject', async () => {
    const focal = await parseFixture();
    const quoter = tweet('1900000000000000600', {
      text: 'worth reading',
      quoted: focal,
    });
    const out = render([quoter], '1900000000000000600');

    assert.ok(
      out.includes('**[Notes on running a small mail server](https://x.com/i/article/1899000000000000042)**'),
      'quoted article lost its title',
    );
    assert.match(out, /article body not included/);
    assert.ok(!out.includes('### DNS is most of the job'), 'quoted article rendered in full');
  });

  it('reduces an article to a reference in a reply', async () => {
    const root = tweet('1900000000000000501', { text: 'root' });
    const focal = await parseFixture();
    const reply: Tweet = {
      ...focal,
      id: '1900000000000000700',
      inReplyToId: '1900000000000000501',
      conversationId: '1900000000000000501',
      author: { ...focal.author, handle: 'alice' },
    };
    const out = render([root, reply], '1900000000000000501');
    assert.match(out, /article body not included/);
    assert.ok(!out.includes('### DNS is most of the job'), 'reply article rendered in full');
  });
});
