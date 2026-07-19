import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { install, urlOf, type InterceptTarget } from '../src/main-world/interceptor.ts';

const GQL = 'https://x.com/i/api/graphql/abc123/TweetDetail?variables=%7B%7D';

interface Posted {
  message: unknown;
  origin: string;
}

function makeTarget(fetchImpl?: typeof fetch): InterceptTarget & { posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    posted,
    fetch: fetchImpl,
    postMessage(message: unknown, origin: string) {
      posted.push({ message, origin });
    },
    location: { origin: 'https://x.com' },
  } as InterceptTarget & { posted: Posted[] };
}

/** Minimal XHR stand-in exposing the prototype surface the hook patches. */
function makeFakeXhrClass() {
  const calls: { method: string; url: string }[] = [];
  class FakeXhr {
    status = 200;
    responseType: XMLHttpRequestResponseType = '';
    responseText = '';
    #listeners: (() => void)[] = [];

    open(method: string, url: string) {
      calls.push({ method, url });
    }
    send() {
      /* the test fires 'load' manually */
    }
    addEventListener(type: string, cb: () => void) {
      if (type === 'load') this.#listeners.push(cb);
    }
    fireLoad() {
      for (const cb of this.#listeners) cb();
    }
  }
  return { FakeXhr, calls };
}

/** Let detached promise chains inside the hook settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('urlOf', () => {
  it('handles the three fetch input forms', () => {
    assert.equal(urlOf('https://x.com/a'), 'https://x.com/a');
    assert.equal(urlOf(new URL('https://x.com/b')), 'https://x.com/b');
    assert.equal(urlOf({ url: 'https://x.com/c' }), 'https://x.com/c');
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 42, {}, { url: 7 }, Symbol('x')]) {
      assert.equal(urlOf(junk), '');
    }
  });
});

describe('fetch hook', () => {
  it('captures GraphQL responses and posts the raw body', async () => {
    const target = makeTarget(async () => new Response('{"data":{"ok":true}}', { status: 200 }));
    install(target);

    const response = await target.fetch!(GQL);
    assert.equal(await response.text(), '{"data":{"ok":true}}', 'page still reads the body');

    await settle();
    assert.equal(target.posted.length, 1);
    const message = target.posted[0]!.message as Record<string, unknown>;
    assert.equal(message['kind'], 'graphql');
    assert.equal(message['transport'], 'fetch');
    assert.equal(message['status'], 200);
    assert.equal(message['body'], '{"data":{"ok":true}}');
    assert.equal(target.posted[0]!.origin, 'https://x.com', 'never posts to *');
  });

  it('ignores non-GraphQL requests', async () => {
    const target = makeTarget(async () => new Response('nope'));
    install(target);
    await target.fetch!('https://x.com/home');
    await settle();
    assert.equal(target.posted.length, 0);
  });

  it('returns the original response object untouched', async () => {
    const original = new Response('{}');
    const target = makeTarget(async () => original);
    install(target);
    assert.equal(await target.fetch!(GQL), original);
  });

  it('propagates rejections unchanged and adds no unhandled rejection', async () => {
    const boom = new Error('network down');
    const target = makeTarget(() => Promise.reject(boom));
    install(target);
    await assert.rejects(() => target.fetch!(GQL), boom);
    await settle();
    assert.equal(target.posted.length, 0);
  });

  it('survives a response whose body cannot be cloned', async () => {
    const response = new Response('{}');
    await response.text(); // consume it, so clone() throws
    const target = makeTarget(async () => response);
    install(target);
    assert.equal(await target.fetch!(GQL), response);
    await settle();
    assert.equal(target.posted.length, 0);
  });

  it('preserves the call receiver', async () => {
    let receiver: unknown;
    const target = makeTarget(function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response('{}'));
    } as unknown as typeof fetch);
    install(target);
    await target.fetch!.call(target, GQL);
    assert.equal(receiver, target);
  });

  it('is a no-op when the realm has no fetch', () => {
    const target = makeTarget(undefined);
    assert.doesNotThrow(() => install(target));
  });

  it('installs only once', () => {
    const target = makeTarget(async () => new Response('{}'));
    assert.equal(install(target), true);
    assert.equal(install(target), false);
  });
});

describe('XHR hook', () => {
  it('captures GraphQL responses on load', () => {
    const { FakeXhr, calls } = makeFakeXhrClass();
    const target = makeTarget();
    target.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    install(target);

    const xhr = new FakeXhr();
    xhr.open('GET', GQL);
    xhr.send();
    xhr.responseText = '{"data":{}}';
    xhr.fireLoad();

    assert.deepEqual(calls, [{ method: 'GET', url: GQL }], 'original open still ran');
    assert.equal(target.posted.length, 1);
    const message = target.posted[0]!.message as Record<string, unknown>;
    assert.equal(message['transport'], 'xhr');
    assert.equal(message['body'], '{"data":{}}');
  });

  it('ignores non-GraphQL URLs and non-text response types', () => {
    const { FakeXhr } = makeFakeXhrClass();
    const target = makeTarget();
    target.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    install(target);

    const other = new FakeXhr();
    other.open('GET', 'https://x.com/home');
    other.send();
    other.responseText = 'x';
    other.fireLoad();

    const blob = new FakeXhr();
    blob.open('GET', GQL);
    blob.send();
    blob.responseType = 'blob';
    blob.fireLoad();

    assert.equal(target.posted.length, 0);
  });
});
