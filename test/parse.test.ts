import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../src/parse/dispatch.ts';
import { get, num, str, toIso, unwrapTweet, firstOf } from '../src/parse/accessors.ts';
import { originalResolution, bestVariant } from '../src/parse/media.ts';
import { loadFixture } from './helpers.ts';

const byId = <T extends { id: string }>(tweets: T[], id: string): T | undefined =>
  tweets.find((t) => t.id === id);

describe('accessors', () => {
  it('get walks dotted paths including array indices', () => {
    const obj = { a: { b: [{ c: 1 }] } };
    assert.equal(get(obj, 'a.b.0.c'), 1);
  });

  it('get never throws on missing or non-object segments', () => {
    for (const input of [null, undefined, 42, 'str', {}, { a: null }]) {
      assert.equal(get(input, 'a.b.c'), undefined);
    }
  });

  it('num accepts numeric strings, which is how views.count arrives', () => {
    assert.equal(num({ views: { count: '3400000' } }, 'views.count'), 3400000);
    assert.equal(num({ v: 'abc' }, 'v'), null);
    assert.equal(num({ v: 1.5 }, 'v'), 1.5);
  });

  it('firstOf returns the first defined path', () => {
    const user = { legacy: { screen_name: 'old' } };
    assert.equal(firstOf(user, 'core.screen_name', 'legacy.screen_name'), 'old');
    const modern = { core: { screen_name: 'new' }, legacy: { screen_name: 'old' } };
    assert.equal(firstOf(modern, 'core.screen_name', 'legacy.screen_name'), 'new');
  });

  it('unwrapTweet reaches through TweetWithVisibilityResults', () => {
    const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: '1' } };
    assert.equal(str(unwrapTweet(wrapped), 'rest_id'), '1');
    const plain = { __typename: 'Tweet', rest_id: '2' };
    assert.equal(unwrapTweet(plain), plain);
  });

  it("toIso normalises X's created_at", () => {
    assert.equal(toIso('Wed Mar 21 20:50:14 +0000 2006'), '2006-03-21T20:50:14Z');
    assert.equal(toIso('not a date'), null);
    assert.equal(toIso(null), null);
    assert.equal(toIso(''), null);
  });
});

describe('media helpers', () => {
  it('upgrades photo URLs to original resolution, preserving format', () => {
    assert.equal(
      originalResolution('https://pbs.twimg.com/media/ABC.jpg'),
      'https://pbs.twimg.com/media/ABC?format=jpg&name=orig',
    );
    assert.equal(
      originalResolution('https://pbs.twimg.com/media/ABC.png'),
      'https://pbs.twimg.com/media/ABC?format=png&name=orig',
      'a PNG must not be re-encoded to jpg, which would drop transparency',
    );
    assert.equal(
      originalResolution('https://pbs.twimg.com/media/ABC.jpeg'),
      'https://pbs.twimg.com/media/ABC?format=jpg&name=orig',
    );
  });

  it('rewrites an existing name= parameter', () => {
    assert.equal(
      originalResolution('https://pbs.twimg.com/media/ABC?format=jpg&name=small'),
      'https://pbs.twimg.com/media/ABC?format=jpg&name=orig',
    );
  });

  it('leaves unrecognised URLs alone', () => {
    assert.equal(originalResolution('https://example.com/x'), 'https://example.com/x');
  });

  it('picks the highest-bitrate mp4 and ignores HLS', () => {
    const variants = [
      { content_type: 'application/x-mpegURL', url: 'hls.m3u8' },
      { bitrate: 632000, content_type: 'video/mp4', url: 'low.mp4' },
      { bitrate: 2176000, content_type: 'video/mp4', url: 'high.mp4' },
    ];
    assert.equal(bestVariant(variants), 'high.mp4');
  });

  it('handles a single bitrate-less mp4, which is how animated_gif arrives', () => {
    assert.equal(bestVariant([{ content_type: 'video/mp4', url: 'gif.mp4' }]), 'gif.mp4');
  });

  it('returns null when nothing is downloadable', () => {
    assert.equal(bestVariant([{ content_type: 'application/x-mpegURL', url: 'x.m3u8' }]), null);
  });
});

describe('dispatch — TweetDetail conversation', () => {
  it('walks tweet-*, conversationthread-* and skips cursor-*', async () => {
    const result = dispatch(await loadFixture('tweetdetail-simple.json'));
    assert.deepEqual(
      result.tweets.map((t) => t.id),
      ['1900000000000000001', '1900000000000000002', '1900000000000000003'],
    );
    assert.equal(result.cursorBottom, 'CURSOR-BOTTOM-VALUE');
    assert.equal(result.yieldRatio, 1);
  });

  it('reads the legacy author shape', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const root = byId(tweets, '1900000000000000001')!;
    assert.equal(root.author.handle, 'robin');
    assert.equal(root.author.name, 'Robin Novak');
    assert.equal(root.author.id, '12');
    assert.equal(root.author.verified, true);
    assert.equal(root.permalink, 'https://x.com/robin/status/1900000000000000001');
  });

  it('expands t.co links and strips the trailing media t.co', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const root = byId(tweets, '1900000000000000001')!;
    assert.ok(!root.text.includes('t.co'), `t.co survived in: ${root.text}`);
    assert.equal(root.text, 'just setting up my twttr, see https://example.com/twttr-origins');
    assert.equal(root.links[0]?.expanded, 'https://example.com/twttr-origins');
  });

  it('applies display_text_range to drop leading reply mentions', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const reply = byId(tweets, '1900000000000000003')!;
    assert.equal(reply.text, 'congrats — this is going to be big');
  });

  it('parses photo media at original resolution with alt text', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const root = byId(tweets, '1900000000000000001')!;
    assert.equal(root.media.length, 1);
    assert.equal(root.media[0]?.kind, 'photo');
    assert.equal(root.media[0]?.url, 'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig');
    assert.equal(root.media[0]?.alt, 'A desk with a laptop and a coffee mug');
    assert.equal(root.media[0]?.width, 2048);
  });

  it('parses metrics, including views delivered as a string', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const root = byId(tweets, '1900000000000000001')!;
    assert.deepEqual(root.metrics, {
      likes: 12345,
      retweets: 678,
      replies: 90,
      quotes: 12,
      bookmarks: 5,
      views: 3400000,
      reliable: true,
    });
  });

  it('carries reply linkage and timestamps', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-simple.json'));
    const reply = byId(tweets, '1900000000000000003')!;
    assert.equal(reply.inReplyToId, '1900000000000000002');
    assert.equal(reply.inReplyToHandle, 'robin');
    assert.equal(reply.conversationId, '1900000000000000001');
    assert.equal(reply.createdAt, '2006-03-21T21:00:00Z');
    assert.equal(reply.partial, false);
  });
});

describe('dispatch — long-form posts', () => {
  it('prefers note_tweet over the truncated full_text', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-longform.json'));
    const tweet = tweets[0]!;
    assert.equal(tweet.isLongForm, true);
    assert.ok(!tweet.text.includes('cut off…'), 'must not be the truncated variant');
    assert.ok(tweet.text.startsWith('The full essay, well past 280 characters'));
    assert.ok(tweet.text.includes('past the point where legacy.full_text would have been cut off'));
  });

  it("expands links using the note's own entity_set, not legacy.entities", async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-longform.json'));
    const tweet = tweets[0]!;
    assert.ok(
      tweet.text.includes('https://example.com/the-real-essay'),
      `note entity_set was not applied: ${tweet.text}`,
    );
    assert.ok(!tweet.text.includes('t.co'));
    assert.equal(tweet.links.length, 1);
    assert.equal(tweet.links[0]?.tco, 'https://t.co/NOTE1');
  });
});

describe('dispatch — visibility wrappers and tombstones', () => {
  it('unwraps TweetWithVisibilityResults instead of dropping it', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-visibility.json'));
    const tweet = byId(tweets, '1900000000000000020');
    assert.ok(tweet, 'restricted tweet must survive');
    assert.equal(tweet.author.handle, 'restricted');
    assert.equal(tweet.text, 'this one is behind a visibility interstitial');
  });

  it('skips tombstones without failing the rest of the payload', async () => {
    const { tweets } = dispatch(await loadFixture('tweetdetail-visibility.json'));
    assert.equal(byId(tweets, '1900000000000000021'), undefined);
    assert.equal(tweets.length, 1);
  });
});

describe('dispatch — author schema migration', () => {
  it('reads the 2025+ core.* author shape', async () => {
    const { tweets } = dispatch(await loadFixture('user-core-shape.json'));
    const tweet = tweets[0]!;
    assert.equal(tweet.author.handle, 'modernshape');
    assert.equal(tweet.author.name, 'Modern Shape');
    assert.equal(tweet.author.id, '31337');
    assert.equal(tweet.author.verified, true);
    assert.equal(tweet.author.avatarUrl, 'https://pbs.twimg.com/profile_images/31337/av_normal.jpg');
    assert.equal(tweet.partial, false);
  });
});

describe('dispatch — video and gif', () => {
  it('selects the best mp4, keeps the poster, and reads duration', async () => {
    const { tweets } = dispatch(await loadFixture('media-video.json'));
    const [video, gif] = tweets[0]!.media;
    assert.equal(video?.kind, 'video');
    assert.equal(video?.url, 'https://video.twimg.com/ext_tw_video/44/pu/vid/1280x720/high.mp4');
    assert.equal(video?.posterUrl, 'https://pbs.twimg.com/ext_tw_video_thumb/44/pu/img/poster.jpg');
    assert.equal(video?.durationMs, 32400);
    assert.equal(video?.alt, 'a short clip');

    assert.equal(gif?.kind, 'gif');
    assert.equal(gif?.url, 'https://video.twimg.com/tweet_video/gif1.mp4');
    assert.equal(gif?.alt, null);
  });

  it('strips every media t.co from the text', async () => {
    const { tweets } = dispatch(await loadFixture('media-video.json'));
    assert.equal(tweets[0]!.text, 'clip and a gif');
  });
});

describe('dispatch — quoted tweets', () => {
  it('nests quotes recursively up to the depth cap', async () => {
    const { tweets } = dispatch(await loadFixture('quoted-nested.json'));
    const bob = tweets[0]!;
    assert.equal(bob.quoted?.author.handle, 'carol');
    assert.equal(bob.quoted?.text, 'the original observation');
    assert.equal(bob.quoted?.quoted?.author.handle, 'dave');
    assert.equal(bob.quoted?.quoted?.quoted, null);
  });

  it('does not hoist quoted tweets into the conversation as siblings', async () => {
    const { tweets } = dispatch(await loadFixture('quoted-nested.json'));
    assert.equal(tweets.length, 1, 'only the quoting tweet is a top-level result');
  });
});

describe('dispatch — malformed input', () => {
  const junk: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['empty data', { data: {} }],
    ['number', 42],
    ['string', 'nope'],
    ['array', []],
    ['empty instructions', { data: { threaded_conversation_with_injections_v2: { instructions: [] } } }],
  ];

  for (const [label, input] of junk) {
    it(`returns an empty result for ${label} without throwing`, () => {
      const result = dispatch(input);
      assert.deepEqual(result.tweets, []);
      assert.equal(result.cursorBottom, null);
    });
  }

  it('survives an entry whose tweet_results is empty', () => {
    const payload = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [{ entryId: 'tweet-1', content: { itemContent: { tweet_results: {} } } }],
            },
          ],
        },
      },
    };
    assert.deepEqual(dispatch(payload).tweets, []);
  });

  it('marks a tweet partial when the author is unreadable', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '1900000000000000099',
            legacy: { full_text: 'orphaned from its author', created_at: 'Mon Jan 06 00:00:00 +0000 2025' },
          },
        },
      },
    };
    const tweet = dispatch(payload).tweets[0]!;
    assert.equal(tweet.partial, true);
    assert.equal(tweet.author.handle, '');
    assert.equal(tweet.text, 'orphaned from its author');
  });

  it('drops a result with no usable id rather than emitting a broken tweet', () => {
    const payload = { data: { tweetResult: { result: { __typename: 'Tweet', legacy: {} } } } };
    assert.deepEqual(dispatch(payload).tweets, []);
  });
});

describe('dispatch — replies loaded by a "show more replies" click', () => {
  it('reads tweets out of TimelineAddToModule', async () => {
    // The bug this pins: clicking the control worked, X answered, and the
    // payload parsed to nothing because the tweets arrive under `moduleItems`
    // rather than `entries`. The branch then looked as though it did not exist.
    const result = dispatch(await loadFixture('addtomodule.json'));

    assert.equal(result.tweets.length, 1);
    const tweet = result.tweets[0]!;
    assert.equal(tweet.id, '1900000000000000060');
    assert.equal(tweet.author.handle, 'hidden');
    assert.equal(tweet.inReplyToId, '1900000000000000002');
    assert.match(tweet.text, /folded behind/);
    assert.equal(result.yieldRatio, 1);
  });

  it('ignores the module cursor without counting it as a miss', async () => {
    const result = dispatch(await loadFixture('addtomodule.json'));
    assert.equal(result.eligible, 1);
    assert.equal(result.parsed, 1);
  });
});

describe('dispatch — promoted content', () => {
  it('drops ads injected into the conversation', async () => {
    // X serves ads inline among the replies. They answer nothing, so they land
    // in the orphan bucket and read as though someone replied to the thread —
    // and their reply counts, often in the hundreds, swamp the "not captured"
    // total.
    const result = dispatch(await loadFixture('promoted.json'));
    assert.deepEqual(
      result.tweets.map((t) => t.id),
      ['1900000000000000070', '1900000000000000072'],
    );
    assert.ok(!result.tweets.some((t) => t.author.handle === 'bigbrand'));
  });

  it('does not count an ad as a parsing miss', async () => {
    const result = dispatch(await loadFixture('promoted.json'));
    assert.equal(result.eligible, 2);
    assert.equal(result.parsed, 2);
    assert.equal(result.yieldRatio, 1, 'an ad is not a schema drift signal');
  });
});
