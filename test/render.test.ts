import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, quote } from '../src/render/markdown.ts';
import { escapeLine, escapeText, yamlScalar } from '../src/render/escape.ts';
import { buildFilename, slugify, sanitize } from '../src/render/filename.ts';
import { assemble, DEFAULT_CAPS } from '../src/thread/assemble.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import type { Settings } from '../src/shared/config.ts';
import type { Media, Tweet } from '../src/types/model.ts';
import { tweet, metrics, loadGolden } from './helpers.ts';

const AT = '2026-07-19T14:03:11Z';
const VERSION = '0.1.0';
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...over });

function render(tweets: Tweet[], focalId: string, over: Partial<Settings> = {}): string {
  const doc = assemble(tweets, focalId, { ...DEFAULT_CAPS, capturedAt: AT });
  return renderMarkdown(doc, settings(over), VERSION);
}

const photo = (url: string, alt: string | null): Media => ({
  kind: 'photo',
  url,
  posterUrl: null,
  alt,
  width: null,
  height: null,
  durationMs: null,
  tcoUrl: null,
});

describe('quote', () => {
  it('marks blank lines so the blockquote does not terminate', () => {
    assert.deepEqual(quote(['a', '', 'b'], 1), ['> a', '>', '> b']);
  });

  it('nests', () => {
    assert.deepEqual(quote(['a', ''], 2), ['> > a', '> >']);
  });

  it('is identity at depth 0', () => {
    assert.deepEqual(quote(['a', ''], 0), ['a', '']);
  });
});

describe('escapeLine', () => {
  it('preserves lists the author meant as lists', () => {
    assert.equal(escapeLine('- Des idées de business'), '- Des idées de business');
    assert.equal(escapeLine('* bullet'), '* bullet');
    assert.equal(escapeLine('+ bullet'), '+ bullet');
    assert.equal(escapeLine('1. first'), '1. first');
    assert.equal(escapeLine('  - indented'), '  - indented');
  });

  it('escapes thematic breaks, which would otherwise split the document', () => {
    // Critically: an unescaped --- right after the frontmatter would be read as
    // a second document delimiter.
    assert.equal(escapeLine('---'), '\\---');
    assert.equal(escapeLine('***'), '\\***');
    assert.equal(escapeLine('___'), '\\___');
    assert.equal(escapeLine('- - -'), '\\- - -');
  });

  it('escapes headings but not hashtags', () => {
    assert.equal(escapeLine('# not a heading'), '\\# not a heading');
    assert.equal(escapeLine('### also not'), '\\### also not');
    assert.equal(escapeLine('#SecondBrain'), '#SecondBrain', 'a hashtag is not a heading');
  });

  it('escapes blockquote and table starters', () => {
    assert.equal(escapeLine('> not a quote'), '\\> not a quote');
    assert.equal(escapeLine('| not a table'), '\\| not a table');
  });

  it('leaves inline emphasis alone in minimal mode', () => {
    assert.equal(escapeLine('a *b* c_d'), 'a *b* c_d');
  });

  it('escapes inline characters in strict mode', () => {
    assert.equal(escapeLine('a *b* c_d', 'strict'), 'a \\*b\\* c\\_d');
  });

  it('leaves ordinary prose untouched', () => {
    assert.equal(escapeLine('first note in the new system'), 'first note in the new system');
  });
});

describe('escapeText - hard line breaks', () => {
  it('appends two spaces so single newlines survive strict CommonMark', () => {
    assert.deepEqual(escapeText('one\ntwo'), ['one  ', 'two']);
  });

  it('leaves paragraph breaks alone', () => {
    assert.deepEqual(escapeText('one\n\ntwo'), ['one', '', 'two']);
  });

  it('skips the noise between consecutive list items', () => {
    assert.deepEqual(escapeText('- a\n- b'), ['- a', '- b']);
  });

  it('still breaks between prose and a following list', () => {
    assert.deepEqual(escapeText('intro\n- a'), ['intro  ', '- a']);
  });

  it('can be turned off', () => {
    assert.deepEqual(escapeText('one\ntwo', 'minimal', false), ['one', 'two']);
  });
});

describe('yamlScalar', () => {
  it('leaves simple words bare', () => {
    assert.equal(yamlScalar('Robin Novak'), 'Robin Novak');
  });

  it('quotes values that would change meaning', () => {
    assert.equal(yamlScalar('@robin'), '"@robin"');
    assert.equal(yamlScalar('a: b'), '"a: b"');
    assert.equal(yamlScalar('say "hi"'), '"say \\"hi\\""');
    assert.equal(yamlScalar('- dash'), '"- dash"');
    assert.equal(yamlScalar(' padded '), '" padded "');
    assert.equal(yamlScalar(''), '""');
    assert.equal(yamlScalar('true'), '"true"');
    assert.equal(yamlScalar('2026-07-19T14:03:11Z'), '"2026-07-19T14:03:11Z"');
    assert.equal(yamlScalar('C:\\path'), '"C:\\\\path"');
  });

  it('flattens newlines instead of emitting a block scalar', () => {
    assert.equal(yamlScalar('two\nlines'), 'two lines');
  });

  it('keeps emoji bare', () => {
    assert.equal(yamlScalar('Robin 🚀'), 'Robin 🚀');
  });
});

describe('renderMarkdown - golden', () => {
  it('matches the two-tweet thread with one reply and one image', async () => {
    const first = tweet('20', {
      author: {
        id: 'u-robin',
        handle: 'robin',
        name: 'Robin Novak',
        avatarUrl: null,
        verified: true,
      },
      createdAt: '2006-03-21T20:50:14Z',
      text: 'first note in the new system',
      media: [photo('https://pbs.twimg.com/media/ABC123.jpg?format=jpg&name=orig', 'A desk with a laptop and a coffee mug')],
      metrics: metrics({ likes: 12345, retweets: 678, replies: 1, quotes: 12, views: 3400000 }),
    });
    const second = tweet('21', {
      author: first.author,
      conversationId: '20',
      inReplyToId: '20',
      inReplyToHandle: 'robin',
      createdAt: '2006-03-21T20:52:00Z',
      text: "follow-up: here's the writeup → [example.com/system-notes](https://example.com/system-notes)",
      metrics: metrics({ likes: 402, retweets: 31 }),
    });
    const reply = tweet('22', {
      author: 'alice',
      conversationId: '20',
      inReplyToId: '21',
      inReplyToHandle: 'robin',
      createdAt: '2006-03-21T21:00:00Z',
      text: 'congrats — this is going to be big',
      metrics: metrics({ likes: 3 }),
    });

    const actual = render([first, second, reply], '20');
    assert.equal(actual, await loadGolden('simple-thread.md'));
  });
});

describe('renderMarkdown - structure', () => {
  const root = () =>
    tweet('1900000000000000000', {
      createdAt: '2026-03-01T10:00:00Z',
      text: 'root',
      metrics: metrics({ likes: 1 }),
    });

  it('nests replies by depth with quoted blank lines', () => {
    const a = root();
    const b = tweet('1900000000000000001', {
      author: 'alice',
      conversationId: a.id,
      inReplyToId: a.id,
      createdAt: '2026-03-01T10:01:00Z',
      text: 'level one\n\nwith a gap',
      metrics: metrics({ likes: 2 }),
    });
    const c = tweet('1900000000000000002', {
      author: 'bob',
      conversationId: a.id,
      inReplyToId: b.id,
      createdAt: '2026-03-01T10:02:00Z',
      text: 'level two',
      metrics: metrics({ likes: 3 }),
    });

    const out = render([a, b, c], a.id);
    assert.match(out, /^> \*\*\[@alice\]/m);
    assert.match(out, /^> > \*\*\[@bob\]/m);
    assert.ok(out.includes('\n>\n'), 'blank lines inside a quote carry the marker');
    assert.ok(!/^\s*$\n> >/m.test(out.split('## Replies')[1] ?? ''), 'no bare blank inside nesting');
  });

  it('renders a quoted tweet one level deeper than its quoter', () => {
    const quoted = tweet('1800000000000000000', {
      author: 'carol',
      createdAt: '2026-02-01T09:00:00Z',
      text: 'the original observation',
      metrics: metrics({ likes: 9 }),
    });
    const a = root();
    const b = tweet('1900000000000000003', {
      author: 'bob',
      conversationId: a.id,
      inReplyToId: a.id,
      createdAt: '2026-03-01T10:04:00Z',
      text: 'agreed, see also:',
      quoted,
      metrics: metrics({ likes: 1 }),
    });

    // Callouts are on by default (the export target is Obsidian).
    const out = render([a, b], a.id);
    assert.match(out, /^> > \[!quote\] \*\*\[@carol\]/m);
    assert.match(out, /^> > the original observation$/m);

    // Turning them off falls back to a portable marker.
    const plain = render([a, b], a.id, { obsidianCallouts: false });
    assert.match(plain, /^> > ↩ \*\*\[@carol\]/m);
    assert.match(plain, /^> > the original observation$/m);
  });

  it('emits a truncation marker', () => {
    const a = root();
    const replies = Array.from({ length: 6 }, (_, i) =>
      tweet((BigInt('1900000000000000010') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: a.id,
        inReplyToId: a.id,
        metrics: metrics({ likes: 0 }),
      }),
    );
    const doc = assemble([a, ...replies], a.id, {
      ...DEFAULT_CAPS,
      maxChildrenPerNode: 2,
      capturedAt: AT,
    });
    const out = renderMarkdown(doc, settings(), VERSION);
    assert.match(out, /\*… 4 more replies dropped by a collection limit\*/);
  });

  it('omits the Replies section when there are none', () => {
    const a = root();
    assert.ok(!render([a], a.id).includes('## Replies'));
  });

  it('ends with exactly one trailing newline', () => {
    const a = root();
    const out = render([a], a.id);
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.endsWith('\n\n'));
  });
});

describe('renderMarkdown - frontmatter', () => {
  it('omits unknown metrics but renders zeroes', () => {
    const a = tweet('1900000000000000000', {
      metrics: { ...metrics(), likes: 0, retweets: null, replies: null, quotes: null, views: null },
    });
    const out = render([a], a.id);
    assert.match(out, /^likes: 0$/m);
    assert.ok(!/^retweets:/m.test(out), 'null metric is omitted, not zeroed');
  });

  it('flags DOM-sourced output', () => {
    const a = tweet('1900000000000000000', {
      source: 'dom',
      metrics: { ...metrics(), reliable: false, likes: null },
    });
    const out = render([a], a.id);
    assert.match(out, /^source: dom$/m);
    assert.match(out, /^metrics_reliable: false$/m);
  });

  it('quotes ids so Snowflakes survive a YAML round-trip', () => {
    const a = tweet('1948573926184756002');
    assert.match(render([a], a.id), /^tweet_id: "1948573926184756002"$/m);
  });

  it('lists warnings', () => {
    const a = tweet('1900000000000000000', { partial: true });
    assert.match(render([a], a.id), /^warnings:\n {2}- Some tweets were missing/m);
  });
});

describe('filename', () => {
  it('expands the template', () => {
    const a = tweet('20', {
      author: 'robin',
      createdAt: '2006-03-21T20:50:14Z',
      text: 'first note in the new system',
    });
    assert.equal(buildFilename('{date}-{handle}-{id}', a, AT), '2006-03-21-robin-20.md');
    assert.equal(buildFilename('{handle}-{slug}', a, AT), 'robin-first-note-in-the-new-system.md');
  });

  it('leaves unknown placeholders alone', () => {
    const a = tweet('20', { author: 'robin' });
    assert.ok(buildFilename('{nope}-{id}', a, AT).includes('{nope}'));
  });

  it('falls back to the capture date when the tweet has none', () => {
    const a = tweet('20', { author: 'robin', createdAt: null });
    assert.equal(buildFilename('{date}-{id}', a, AT), '2026-07-19-20.md');
  });

  it('strips path separators, traversal and control characters', () => {
    assert.ok(!sanitize('a/b\\c').includes('/'));
    assert.ok(!sanitize('../../etc/passwd').includes('..'));
    assert.ok(!sanitize('a b').includes(' '));
    assert.equal(sanitize('  ..  '), 'export');
  });

  it('caps length', () => {
    assert.ok(sanitize('x'.repeat(500)).length <= 180);
  });

  it('avoids reserved device names', () => {
    assert.notEqual(sanitize('CON'), 'CON');
  });

  it('slugifies without URLs or punctuation', () => {
    assert.equal(slugify('Hello, World! https://t.co/abc - done'), 'hello-world-done');
  });
});
