// The retained-payload ring behind the debug dump.
//
// Small surface, but it decides whether a dump is usable at all: the payload
// worth diagnosing is almost always the first TweetDetail of the session, and
// the requests that follow it are avatars, sidebars and preference lookups.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PayloadStore } from '../src/content/store.ts';
import { BRIDGE_TAG, BRIDGE_VERSION } from '../src/shared/messages.ts';
import type { BridgeGraphqlMessage } from '../src/shared/messages.ts';
import { loadFixture } from './helpers.ts';

function message(url: string, body: unknown = {}): BridgeGraphqlMessage {
  return {
    [BRIDGE_TAG]: BRIDGE_VERSION,
    kind: 'graphql',
    url,
    status: 200,
    transport: 'fetch',
    body: JSON.stringify(body),
  };
}

describe('store - retained payload ring', () => {
  it('retains nothing until debug mode asks it to', () => {
    const store = new PayloadStore();
    store.accept(message('https://x.com/i/api/graphql/abc/TweetDetail'));
    assert.equal(store.rawPayloads().length, 0);
  });

  it('keeps the payload that carried tweets, wherever it arrived', async () => {
    // The order below is the one a real SPA navigation produced: four payloads
    // that yield nothing, then the TweetDetail, then more noise. Both a plain
    // oldest-first ring and a pin-the-first-entry rule lose the only payload
    // worth dumping - the first because it arrives late, the second because the
    // pinned slot holds a preference lookup.
    const store = new PayloadStore();
    store.setRetainRaw(true);

    for (const op of ['DataSaverMode', 'ExploreSidebar', 'SidebarUserRecommendations', 'HomeTimeline']) {
      store.accept(message(`https://x.com/i/api/graphql/abc/${op}`));
    }
    store.accept(
      message('https://x.com/i/api/graphql/abc/TweetDetail', await loadFixture('tweetdetail-simple.json')),
    );
    for (let i = 0; i < 10; i += 1) {
      store.accept(message(`https://x.com/i/api/graphql/def/UsersVerifiedAvatars${i}`));
    }

    const kept = store.rawPayloads();
    assert.ok(kept.length <= 5, `ring grew to ${kept.length}`);
    assert.ok(
      kept.some((p) => p.url.includes('TweetDetail')),
      'the only payload carrying tweets was evicted',
    );
    assert.match(kept[kept.length - 1]!.url, /UsersVerifiedAvatars9/, 'newest payload not kept');
  });

  it('falls back to oldest-first when every payload carried tweets', async () => {
    const store = new PayloadStore();
    store.setRetainRaw(true);
    const body = await loadFixture('tweetdetail-simple.json');

    for (let i = 0; i < 8; i += 1) {
      store.accept(message(`https://x.com/i/api/graphql/abc/TweetDetail?page=${i}`, body));
    }

    const kept = store.rawPayloads();
    assert.equal(kept.length, 5);
    assert.match(kept[0]!.url, /page=3/, 'eviction was not oldest-first among equals');
  });

  it('drops everything when debug mode is turned back off', () => {
    const store = new PayloadStore();
    store.setRetainRaw(true);
    store.accept(message('https://x.com/i/api/graphql/abc/TweetDetail'));
    assert.equal(store.rawPayloads().length, 1);

    store.setRetainRaw(false);
    assert.equal(store.rawPayloads().length, 0);
  });
});
