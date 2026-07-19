// Round-trips the hand-rolled YAML emitter through a real YAML parser.
//
// The emitter is the one piece of the codebase that fails silently: a
// mis-quoted scalar does not throw, it produces a document that a note app
// reads back wrong, or refuses to index, or truncates at the wrong delimiter.
// Reasoning about YAML quoting rules is not verification, so this asserts
// against the `yaml` package — a devDependency only, never shipped in the XPI.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import { renderMarkdown } from '../src/render/markdown.ts';
import { yamlScalar } from '../src/render/escape.ts';
import { dispatch } from '../src/parse/dispatch.ts';
import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import type { Author } from '../src/types/model.ts';
import { tweet, metrics, loadFixture } from './helpers.ts';

const AT = '2026-07-19T14:03:11Z';

/** Pull the frontmatter block out of a rendered document and parse it. */
function frontmatterOf(markdown: string): Record<string, unknown> {
  assert.ok(markdown.startsWith('---\n'), 'document must open with a frontmatter fence');
  const end = markdown.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'frontmatter must be closed');
  const parsed: unknown = parse(markdown.slice(4, end + 1));
  assert.ok(parsed && typeof parsed === 'object', 'frontmatter must parse to a mapping');
  return parsed as Record<string, unknown>;
}

function renderWith(author: Partial<Author>, text = 'body'): string {
  const t = tweet('2041501452388954281', {
    author: {
      id: 'u-1',
      handle: 'writer',
      name: 'Major',
      avatarUrl: null,
      verified: true,
      ...author,
    },
    createdAt: '2026-04-07T13:00:50Z',
    text,
    metrics: metrics({ likes: 207 }),
  });
  const doc = assemble([t], t.id, { ...DEFAULT_CAPS, capturedAt: AT });
  return renderMarkdown(doc, DEFAULTS, '0.1.0');
}

describe('yamlScalar round-trips through a real parser', () => {
  const hostile = [
    'Alex | Rivera Field Notes 🇨🇭', // a pipe in a display name: the case that prompted this file
    '| leading pipe',
    '> leading angle',
    '- leading dash',
    '#hashtag',
    '@handle',
    'key: value',
    'trailing colon:',
    'quote " inside',
    "apostrophe ' inside",
    'back\\slash',
    'tab\there',
    'multi\nline',
    '  padded  ',
    '',
    'true',
    'False',
    'null',
    '~',
    '0755',
    '1.2.3',
    '2026-04-07',
    'yes',
    'off',
    '[bracketed]',
    '{braced}',
    '*anchor',
    '&anchor',
    '!!str coerced',
    '%directive',
    '`backtick`',
    'ends with space ',
    '日本語のテキスト',
    '🇨🇭🇫🇷',
    'a'.repeat(300),
  ];

  for (const value of hostile) {
    it(`survives ${JSON.stringify(value.slice(0, 40))}`, () => {
      const document = `field: ${yamlScalar(value)}\n`;
      const parsed = parse(document) as { field: unknown };
      // Newlines and tabs are deliberately flattened to spaces rather than
      // emitted as block scalars; everything else must come back verbatim.
      const expected = value.replace(/[\r\n\t]+/g, ' ');
      assert.equal(parsed.field, expected);
    });
  }
});

describe('rendered frontmatter is valid YAML', () => {
  it('parses when the display name contains a pipe', () => {
    const markdown = renderWith({ name: 'Alex | Rivera Field Notes 🇨🇭' });
    const fm = frontmatterOf(markdown);
    assert.equal(fm['author'], 'Alex | Rivera Field Notes 🇨🇭');
    assert.equal(fm['handle'], '@writer');
  });

  it('keeps Snowflake ids as strings, not lossy numbers', () => {
    const fm = frontmatterOf(renderWith({}));
    assert.equal(typeof fm['tweet_id'], 'string');
    assert.equal(fm['tweet_id'], '2041501452388954281');
    // The whole reason ids are quoted: as a number this loses its last digits.
    assert.notEqual(String(Number('2041501452388954281')), '2041501452388954281');
  });

  it('parses URLs unquoted', () => {
    const fm = frontmatterOf(renderWith({}));
    assert.equal(fm['url'], 'https://x.com/writer/status/2041501452388954281');
    assert.equal(fm['author_url'], 'https://x.com/writer');
  });

  it('emits metrics flat, so Obsidian can type them as numbers', () => {
    const fm = frontmatterOf(renderWith({}));
    // A nested mapping renders as an unqueryable raw JSON blob in Obsidian's
    // property system, which defeats the point of the frontmatter.
    assert.equal(fm['metrics'], undefined);
    assert.equal(fm['likes'], 207);
    assert.equal(typeof fm['likes'], 'number');
    assert.deepEqual(fm['tags'], ['tweet', 'x-export']);
    assert.equal(fm['metrics_reliable'], true);
  });

  it('emits a bare YYYY-MM-DD date alongside the full timestamp', () => {
    const fm = frontmatterOf(renderWith({}));
    // Unquoted and in this exact shape, because Obsidian's property system
    // infers a Date type from it and only then is the field sortable. That
    // inference is Obsidian's, not YAML's — the 1.2 core schema resolves this
    // to a plain string, which is all this test can honestly assert.
    assert.equal(fm['date'], '2026-04-07');
    assert.match(renderWith({}), /^date: 2026-04-07$/m, 'must stay unquoted');
    // Full precision is kept alongside it, as text.
    assert.equal(fm['posted_at'], '2026-04-07T13:00:50Z');
  });

  it('survives a display name that is only YAML punctuation', () => {
    const fm = frontmatterOf(renderWith({ name: '---' }));
    assert.equal(fm['author'], '---');
  });

  it('is not terminated early by a --- inside the body', () => {
    // An unescaped --- on its own line would be read as a second document
    // delimiter and silently truncate the note.
    const markdown = renderWith({}, 'before\n\n---\n\nafter');
    const fm = frontmatterOf(markdown);
    assert.equal(fm['tweet_id'], '2041501452388954281');
    assert.equal(parse(markdown.slice(4, markdown.indexOf('\n---\n', 4) + 1)) !== null, true);
    assert.match(markdown, /^\\---$/m, 'the body --- must be escaped');
  });

  it('parses the frontmatter of the real captured thread', async () => {
    const { tweets } = dispatch(await loadFixture('real-tweetdetail.json'));
    const doc = assemble(tweets, '2441501452388954281', { ...DEFAULT_CAPS, capturedAt: AT });
    const fm = frontmatterOf(renderMarkdown(doc, DEFAULTS, '0.1.0'));

    assert.equal(fm['author'], 'Alex | Rivera Field Notes 🇨🇭');
    assert.equal(fm['handle'], '@ada');
    assert.equal(fm['tweet_id'], '2441501452388954281');
    assert.equal(fm['source'], 'graphql');
    assert.equal(fm['thread_length'], 2);
    assert.equal(fm['replies_captured'], 23);
    assert.equal(fm['likes'], 207);
    assert.equal(fm['views'], 29080);
  });
});

describe('collection completeness', () => {
  it('records what the collection pass reported', async () => {
    const t = tweet('20', { createdAt: '2026-04-07T13:00:50Z', metrics: metrics({ likes: 1 }) });
    for (const collection of ['complete', 'partial', 'unknown'] as const) {
      const doc = assemble([t], t.id, { ...DEFAULT_CAPS, capturedAt: AT, collection });
      const fm = frontmatterOf(renderMarkdown(doc, DEFAULTS, '0.1.0'));
      assert.equal(fm['collection'], collection);
    }
  });

  it('overrides a complete claim when the caps truncated the tree', async () => {
    // The document is demonstrably missing tweets, whatever collection reported.
    const root = tweet('1900000000000000000');
    const replies = Array.from({ length: 5 }, (_, i) =>
      tweet((BigInt('1900000000000000010') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: root.id,
        inReplyToId: root.id,
      }),
    );
    const doc = assemble([root, ...replies], root.id, {
      ...DEFAULT_CAPS,
      maxChildrenPerNode: 2,
      capturedAt: AT,
      collection: 'complete',
    });
    assert.equal(doc.collection, 'partial');
  });

  it('defaults to unknown, which is an honest answer', async () => {
    const t = tweet('20');
    const doc = assemble([t], t.id, { ...DEFAULT_CAPS, capturedAt: AT });
    assert.equal(doc.collection, 'unknown');
  });
});
