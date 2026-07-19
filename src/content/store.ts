// In-memory collection point for everything captured from X's GraphQL traffic.
//
// Two properties make the rest of the design simple:
//
//   1. It is append-only. X's timeline is virtualised, so scrolling destroys DOM
//      nodes — but we collect from the network, so scrolling away never loses
//      data and the pagination driver can scroll freely without scraping.
//
//   2. It carries a version counter. The pagination driver waits on the counter
//      changing rather than on a fixed sleep, so a fast connection finishes in
//      seconds instead of rounds × sleep.

import type { BridgeGraphqlMessage } from '../shared/messages.ts';
import type { Tweet } from '../types/model.ts';
import { dispatch } from '../parse/dispatch.ts';
import { debug } from '../shared/log.ts';

/** How many raw payloads to retain for the debug fixture dump. */
const RAW_RING_SIZE = 5;

export interface RawPayload {
  url: string;
  status: number;
  transport: 'fetch' | 'xhr';
  /** Milliseconds since epoch, for fixture provenance. */
  receivedAt: number;
  /** The parsed JSON body. Retained only while debug mode is on. */
  json: unknown;
}

export interface PayloadMeta {
  status: number;
  /** Operation name lifted from the GraphQL path. Debug label only — X renames
   *  operations, so nothing dispatches on this. */
  operation: string;
  /** Last `cursor-bottom` value seen, used to detect cursor exhaustion. */
  cursorBottom: string | null;
}

export type PayloadListener = (json: unknown, meta: PayloadMeta) => void;

/** `/i/api/graphql/<queryId>/<OperationName>` -> `OperationName`. */
function operationName(url: string): string {
  try {
    const path = new URL(url, window.location.origin).pathname;
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export class PayloadStore {
  #version = 0;
  #waiters: (() => void)[] = [];
  #listeners: PayloadListener[] = [];
  #raw: RawPayload[] = [];
  #retainRaw = false;
  #rateLimited = false;
  #received = 0;
  #tweets = new Map<string, Tweet>();
  #cursorBottom: string | null = null;
  #keepRaw = false;
  #lowYield = false;

  /** Bumped every time a payload is accepted. */
  get version(): number {
    return this.#version;
  }

  get receivedCount(): number {
    return this.#received;
  }

  /** True once any GraphQL response came back 429. */
  get rateLimited(): boolean {
    return this.#rateLimited;
  }

  /** Every tweet seen so far, in insertion order. */
  get tweets(): Tweet[] {
    return [...this.#tweets.values()];
  }

  get tweetCount(): number {
    return this.#tweets.size;
  }

  /** Last bottom cursor seen; repeated values mean pagination is exhausted. */
  get cursorBottom(): string | null {
    return this.#cursorBottom;
  }

  /** True once a payload parsed suspiciously poorly — likely a schema change. */
  get sawLowYield(): boolean {
    return this.#lowYield;
  }

  /** Retain raw payloads for the debug fixture dump. */
  setRetainRaw(value: boolean): void {
    this.#retainRaw = value;
    this.#keepRaw = value;
    if (!value) this.#raw = [];
  }

  /**
   * Forget everything. Called on SPA navigation: tweets from the previous
   * conversation must not leak into the next export.
   */
  reset(): void {
    this.#tweets.clear();
    this.#raw = [];
    this.#cursorBottom = null;
    this.#rateLimited = false;
    this.#lowYield = false;
    this.#received = 0;
  }

  onPayload(listener: PayloadListener): void {
    this.#listeners.push(listener);
  }

  /** Feed one bridged message. Never throws. */
  accept(message: BridgeGraphqlMessage): void {
    if (message.status === 429) {
      this.#rateLimited = true;
      debug('rate limited on', message.url);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(message.body);
    } catch {
      debug('unparseable body from', message.url);
      return;
    }

    this.#received += 1;

    const parsed = dispatch(json, this.#keepRaw ? { keepRaw: true } : {});

    // Append-only. A tweet already seen is not overwritten: the first capture of
    // a conversation is the most complete one, and later timeline fragments can
    // carry thinner versions of the same tweet.
    for (const tweet of parsed.tweets) {
      if (!this.#tweets.has(tweet.id)) this.#tweets.set(tweet.id, tweet);
    }
    if (parsed.cursorBottom) this.#cursorBottom = parsed.cursorBottom;
    if (parsed.yieldRatio < 0.8) this.#lowYield = true;

    const meta: PayloadMeta = {
      status: message.status,
      operation: operationName(message.url),
      cursorBottom: parsed.cursorBottom,
    };

    if (this.#retainRaw) {
      this.#raw.push({
        url: message.url,
        status: message.status,
        transport: message.transport,
        receivedAt: Date.now(),
        json,
      });
      if (this.#raw.length > RAW_RING_SIZE) this.#raw.shift();
    }

    for (const listener of this.#listeners) {
      try {
        listener(json, meta);
      } catch (err) {
        debug('payload listener threw', err);
      }
    }

    this.#bump();
  }

  #bump(): void {
    this.#version += 1;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve when the next payload lands, or after `timeoutMs`.
   * Resolves `true` if a payload arrived, `false` on timeout.
   */
  waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(changed);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.#waiters.push(() => done(true));
      signal?.addEventListener('abort', () => done(false), { once: true });
    });
  }

  /** Snapshot of retained raw payloads, for the debug fixture dump. */
  rawPayloads(): RawPayload[] {
    return [...this.#raw];
  }
}
