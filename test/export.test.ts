import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { focalIdFrom } from '../src/content/route.ts';
import { runExport } from '../src/content/export.ts';
import { DEFAULTS } from '../src/shared/config.ts';
import type { Settings } from '../src/shared/config.ts';
import { tweet, metrics } from './helpers.ts';

const AT = '2026-07-19T14:03:11Z';

/** Captures what the content script would hand to the background page. */
interface Sent {
  kind?: string;
  filename?: string;
  text?: string;
}
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  (globalThis as Record<string, unknown>)['browser'] = {
    runtime: {
      sendMessage: async (message: Sent) => {
        sent.push(message);
        return { ok: true, kind: 'download', downloadId: 1 };
      },
    },
  };
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  action: 'download', // clipboard is unavailable outside a secure browser context
  ...over,
});

describe('focalIdFrom', () => {
  it('extracts the tweet id from a status URL', () => {
    assert.equal(focalIdFrom('/writer/status/2041501452388954281'), '2041501452388954281');
    assert.equal(focalIdFrom('/robin/status/20/photo/1'), '20');
    assert.equal(focalIdFrom('/i/status/20'), '20');
  });

  it('returns null anywhere else on the site', () => {
    for (const path of ['/home', '/writer', '/i/bookmarks', '/', '/search?q=x', '/robin/status/']) {
      assert.equal(focalIdFrom(path), null, path);
    }
  });
});

describe('runExport', () => {
  const root = tweet('1900000000000000000', {
    createdAt: '2026-03-01T10:00:00Z',
    text: 'root',
    metrics: metrics({ likes: 1 }),
  });
  const reply = tweet('1900000000000000001', {
    author: 'alice',
    conversationId: root.id,
    inReplyToId: root.id,
    createdAt: '2026-03-01T10:01:00Z',
    text: 'reply',
    metrics: metrics({ likes: 2 }),
  });

  it('renders and downloads', async () => {
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.downloaded, true);
    assert.match(outcome.message, /^2 tweets downloaded\./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, 'download');
    assert.equal(sent[0]?.filename, '2026-03-01-robin-1900000000000000000.md');
    assert.ok(sent[0]?.text?.startsWith('---\n'));
  });

  it('fails cleanly with nothing captured', async () => {
    const outcome = await runExport({
      tweets: [],
      focalId: root.id,
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Nothing captured/);
    assert.equal(sent.length, 0);
  });

  it('exports the conversation and warns when the focal tweet is missing', async () => {
    // Step 2 of the degradation ladder: some of the conversation was captured
    // but not the tweet the URL points at.
    const outcome = await runExport({
      tweets: [root, reply],
      focalId: '9999999999999999999',
      settings: settings(),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /Focal tweet missing/);
    assert.match(outcome.markdown!, /^warnings:\n {2}- The focal tweet was not captured/m);
  });

  it('reports truncation caused by the caps', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      tweet((BigInt('1900000000000000010') + BigInt(i)).toString(), {
        author: 'alice',
        conversationId: root.id,
        inReplyToId: root.id,
        metrics: metrics({ likes: 0 }),
      }),
    );

    const outcome = await runExport({
      tweets: [root, ...many],
      focalId: root.id,
      settings: settings({ maxChildrenPerNode: 3 }),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /5 not included \(limits\)/);
  });

  it('honours the clipboard-only action by not downloading', async () => {
    const outcome = await runExport({
      tweets: [root],
      focalId: root.id,
      settings: settings({ action: 'clipboard' }),
      version: '0.1.0',
      capturedAt: AT,
    });

    assert.equal(sent.length, 0);
    // No clipboard in this environment, so the copy fails and that is reported
    // rather than being silently swallowed.
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Clipboard/);
  });
});
