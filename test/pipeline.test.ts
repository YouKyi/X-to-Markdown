// The milestone this project is optimised around: a committed GraphQL fixture
// goes all the way to a complete .md file, byte-compared against a golden, with
// no browser involved anywhere.
//
// If this passes, the entire core — envelope walking, tweet normalisation, media
// and entity handling, thread assembly, Markdown rendering — is verified by
// `node --test` alone.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { dispatch } from '../src/parse/dispatch.ts';
import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import { renderMarkdown } from '../src/render/markdown.ts';
import { buildFilename } from '../src/render/filename.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import { loadFixture, loadGolden, assertBlockquotesIntact } from './helpers.ts';

const AT = '2026-07-19T14:03:11Z';
const VERSION = '0.1.0';

describe('fixture -> markdown, end to end', () => {
  it('renders tweetdetail-simple.json to the golden document', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const doc = assemble(tweets, '1900000000000000001', { ...DEFAULT_CAPS, capturedAt: AT });
    const markdown = renderMarkdown(doc, DEFAULTS, VERSION);

    assert.equal(markdown, await loadGolden('fixture-end-to-end.md'));
  });

  it('produces a usable download filename from the same document', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const doc = assemble(tweets, '1900000000000000001', { ...DEFAULT_CAPS, capturedAt: AT });

    assert.equal(
      buildFilename(DEFAULTS.filenameTemplate, doc.focal, doc.capturedAt),
      '2006-03-21-robin-1900000000000000001.md',
    );
  });

  it('reports a clean run: no warnings, nothing truncated, no orphans', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const doc = assemble(tweets, '1900000000000000001', { ...DEFAULT_CAPS, capturedAt: AT });

    assert.deepEqual(doc.warnings, []);
    assert.deepEqual(doc.stats, {
      captured: 3,
      rendered: 3,
      truncated: 0,
      orphans: 0,
      // The fixture's root declares reply_count 90 and the payload carries two
      // replies, so 89 are correctly reported as never captured. Exactly the
      // signal a folded "show replies" branch produces on a real thread.
      uncaptured: 89,
      source: 'graphql',
    });
    assert.deepEqual(
      doc.selfThread.map((t) => t.id),
      ['1900000000000000001', '1900000000000000002'],
    );
  });

  it('never emits a bare blank line inside a blockquote', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const doc = assemble(tweets, '1900000000000000001', { ...DEFAULT_CAPS, capturedAt: AT });
    assertBlockquotesIntact(renderMarkdown(doc, DEFAULTS, VERSION));
  });
});

describe('README stays honest', () => {
  it('shows the golden document verbatim, not an abridged version', async () => {
    // The README claims this example cannot drift from the real output. That is
    // only true if something checks, and an abridged sample that quietly omits
    // fields is exactly the kind of documentation that goes stale unnoticed.
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const block = /````markdown\n([\s\S]*?)````/.exec(readme);
    assert.ok(block, 'README no longer contains a markdown example block');

    const golden = await loadGolden('simple-thread.md');
    assert.equal(block[1]!.trimEnd(), golden.trimEnd());
  });
});
