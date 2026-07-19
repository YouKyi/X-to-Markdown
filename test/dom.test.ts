// Tests for the DOM fallback.
//
// Scope is deliberate. The pure logic — permalink parsing, text reconstruction,
// aria-label counts — is pinned here, because it is real logic that can be
// wrong in ways nobody notices. The selector walk is exercised on a
// representative fragment rather than exhaustively: any X redesign rewrites it,
// and tests over it would be rewritten with it rather than catching anything.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { scrapeDom, parsePermalink, textOf } from '../src/parse/dom.ts';
import { runExport } from '../src/content/export.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import { tweet, metrics } from './helpers.ts';

function dom(body: string): ParentNode {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  return document as unknown as ParentNode;
}

/** A tweet article in roughly the shape x.com renders. */
function article(options: {
  handle: string;
  id: string;
  datetime: string;
  text: string;
  extra?: string;
  ariaLabel?: string;
}): string {
  return `
    <article data-testid="tweet">
      <div data-testid="User-Name">
        <span>${options.handle.toUpperCase()}</span>
        <span>@${options.handle}</span>
        <a href="/${options.handle}/status/${options.id}"><time datetime="${options.datetime}">1h</time></a>
      </div>
      <div data-testid="tweetText">${options.text}</div>
      ${options.extra ?? ''}
      <div role="group" aria-label="${options.ariaLabel ?? ''}"></div>
    </article>
  `;
}

describe('parsePermalink', () => {
  it('reads handle and id from every form X emits', () => {
    assert.deepEqual(parsePermalink('/writer/status/2041501452388954281'), {
      handle: 'writer',
      id: '2041501452388954281',
    });
    assert.deepEqual(parsePermalink('https://x.com/robin/status/20'), { handle: 'robin', id: '20' });
    assert.deepEqual(parsePermalink('https://twitter.com/robin/status/20'), {
      handle: 'robin',
      id: '20',
    });
    assert.deepEqual(parsePermalink('/robin/status/20/photo/1'), { handle: 'robin', id: '20' });
  });

  it('rejects anything that is not a status link', () => {
    for (const href of ['/home', '/writer', '', '/robin/status/', '/robin/status/abc']) {
      assert.equal(parsePermalink(href), null, href);
    }
  });
});

describe('textOf', () => {
  it('keeps emoji, which X renders as <img alt>', () => {
    // textContent would silently drop these entirely.
    const root = dom('<div id="t">bravo <img alt="🎉" src="e.svg"> vraiment</div>');
    assert.equal(textOf(root.querySelector('#t')!), 'bravo 🎉 vraiment');
  });

  it('turns <br> into a newline', () => {
    const root = dom('<div id="t">one<br>two</div>');
    assert.equal(textOf(root.querySelector('#t')!), 'one\ntwo');
  });

  it('flattens nested spans', () => {
    const root = dom('<div id="t"><span>a<span> b</span></span><span> c</span></div>');
    assert.equal(textOf(root.querySelector('#t')!), 'a b c');
  });
});

describe('scrapeDom', () => {
  const root = () =>
    dom(
      article({
        handle: 'writer',
        id: '2041501452388954281',
        datetime: '2026-04-07T13:00:50.000Z',
        text: 'Je ne comprends pas <img alt="🧠" src="e.svg">',
        extra:
          '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/ABC.jpg" alt="a desk" /></div>',
        ariaLabel: '17 réponses, 21 reposts, 207 j’aime',
      }) +
        article({
          handle: 'alice',
          id: '2041512444439249251',
          datetime: '2026-04-07T13:44:30.000Z',
          text: 'Yop',
        }),
    );

  it('produces the same Tweet shape as the GraphQL parser', () => {
    const [first, second] = scrapeDom(root());
    assert.equal(first?.id, '2041501452388954281');
    assert.equal(first?.author.handle, 'writer');
    assert.equal(first?.createdAt, '2026-04-07T13:00:50.000Z');
    assert.equal(first?.text, 'Je ne comprends pas 🧠');
    assert.equal(first?.permalink, 'https://x.com/writer/status/2041501452388954281');
    assert.equal(second?.author.handle, 'alice');
  });

  it('marks everything it produces as degraded', () => {
    for (const t of scrapeDom(root())) {
      assert.equal(t.source, 'dom');
      assert.equal(t.partial, true, 'a DOM tweet is missing fields by construction');
      assert.equal(t.isLongForm, false);
      assert.deepEqual(t.links, [], 't.co destinations are not in the markup');
      assert.equal(t.author.id, null, 'the DOM never exposes a user rest_id');
    }
  });

  it('upgrades photos to original resolution and keeps alt text', () => {
    const [first] = scrapeDom(root());
    assert.equal(first?.media[0]?.url, 'https://pbs.twimg.com/media/ABC?format=jpg&name=orig');
    assert.equal(first?.media[0]?.alt, 'a desk');
  });

  it('omits metrics by default', () => {
    const [first] = scrapeDom(root());
    // A missing number is recoverable; a wrong one written into someone's notes
    // is not, and aria-labels are localised and abbreviated.
    assert.equal(first?.metrics.likes, null);
    assert.equal(first?.metrics.reliable, false);
  });

  it('reads localised counts only when explicitly asked', () => {
    const [first] = scrapeDom(root(), { metrics: true });
    assert.equal(first?.metrics.likes, 207);
    assert.equal(first?.metrics.retweets, 21);
    assert.equal(first?.metrics.replies, 17);
    assert.equal(first?.metrics.reliable, false, 'still never claimed to be reliable');
  });

  it('deduplicates and skips articles with no status link', () => {
    const duplicated = dom(
      article({ handle: 'robin', id: '20', datetime: '2026-01-01T00:00:00Z', text: 'a' }).repeat(3) +
        '<article data-testid="tweet"><div data-testid="tweetText">no link</div></article>',
    );
    assert.equal(scrapeDom(duplicated).length, 1);
  });

  it('returns an empty list rather than throwing on junk', () => {
    assert.deepEqual(scrapeDom(dom('')), []);
    assert.deepEqual(scrapeDom(dom('<article></article>')), []);
  });
});

describe('degradation ladder', () => {
  const settings = { ...DEFAULTS, action: 'download' as const };

  it('falls back to the DOM when nothing was intercepted', async () => {
    (globalThis as Record<string, unknown>)['browser'] = {
      runtime: { sendMessage: async () => ({ ok: true, kind: 'download', downloadId: 1 }) },
    };

    const scraped = [
      tweet('20', { source: 'dom', partial: true, metrics: { ...metrics(), reliable: false } }),
    ];
    const outcome = await runExport({
      tweets: [],
      focalId: '20',
      settings,
      version: '0.1.0',
      capturedAt: '2026-07-19T14:03:11Z',
      scrapeDom: () => scraped,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /^Degraded export\./);
    assert.match(outcome.markdown!, /^source: dom$/m);
    // The warning contains ": ", so the YAML emitter quotes it — which is
    // exactly the behaviour the frontmatter tests pin.
    assert.match(outcome.markdown!, /^ {2}- "Read from the page instead of the network: /m);
  });

  it('asks for a reload when neither source produced anything', async () => {
    const outcome = await runExport({
      tweets: [],
      focalId: '20',
      settings,
      version: '0.1.0',
      scrapeDom: () => [],
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.needsReload, true, 'a reload is the only thing that helps here');
    assert.match(outcome.message, /Reload it and try again/);
  });
});
