// MAIN-world network interceptor.
//
// This is the riskiest file in the extension. It runs inside x.com's own JS
// realm and patches two global functions the site depends on. The top invariant,
// above correctness of capture, is:
//
//     IT MUST NEVER BREAK X.
//
// Every hook body is wrapped in try/catch whose catch path restores the original
// behaviour, the fetch patch returns the original Response synchronously without
// ever awaiting, and body reading happens on a detached clone.
//
// It grants the page no capability it did not already have: everything captured
// here is a response the page itself requested. See SECURITY.md.
//
// `install()` takes its host object as a parameter purely so the hooks can be
// unit-tested against a fake realm; production calls it once with `window`.

import { BRIDGE_TAG, BRIDGE_VERSION } from '../shared/messages.ts';
import type { BridgeGraphqlMessage } from '../shared/messages.ts';

const GRAPHQL_MARKER = '/i/api/graphql/';

// Cap on the size we forward. X's TweetDetail responses run 1–5 MB; anything an
// order of magnitude past that is not a conversation payload and is not worth
// the structured-clone cost.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Guard against double injection (SPA soft-reloads, extension reload in dev). */
const INSTALLED_FLAG = '__xtmdInstalled';

/** The slice of `window` the interceptor touches. */
export interface InterceptTarget {
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  postMessage(message: unknown, targetOrigin: string): void;
  location: { origin: string };
  [key: string]: unknown;
}

function isGraphqlUrl(url: string): boolean {
  return url.indexOf(GRAPHQL_MARKER) !== -1;
}

/** Extract a URL string from any of fetch's three input forms. Never throws. */
export function urlOf(input: unknown): string {
  try {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (input && typeof input === 'object' && 'url' in input) {
      const u = (input as { url: unknown }).url;
      return typeof u === 'string' ? u : '';
    }
  } catch {
    /* fall through */
  }
  return '';
}

function makePoster(target: InterceptTarget) {
  return function post(
    url: string,
    status: number,
    transport: 'fetch' | 'xhr',
    body: string,
  ): void {
    try {
      if (!body || body.length > MAX_BODY_BYTES) return;
      const message: BridgeGraphqlMessage = {
        [BRIDGE_TAG]: BRIDGE_VERSION,
        kind: 'graphql',
        url,
        status,
        transport,
        body,
      };
      target.postMessage(message, target.location.origin);
    } catch {
      /* posting must never surface to the page */
    }
  };
}

export function installFetchHook(target: InterceptTarget): void {
  const original = target.fetch;
  if (typeof original !== 'function') return;
  const post = makePoster(target);

  const patched = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    // Call through first and hold the original promise. Whatever happens below,
    // this is what we hand back - unmodified, and without awaiting.
    const promise = original.apply(this, args) as Promise<Response>;

    try {
      const url = urlOf(args[0]);
      if (isGraphqlUrl(url)) {
        // Detached chain. Both handlers swallow: a capture failure must never
        // become an unhandled rejection in the page.
        promise.then(
          (response) => {
            try {
              // clone() throws if the body was already consumed; that is the
              // page's business, not ours.
              const copy = response.clone();
              const status = response.status;
              copy.text().then(
                (text) => post(url, status, 'fetch', text),
                () => {},
              );
            } catch {
              /* ignore */
            }
          },
          () => {},
        );
      }
    } catch {
      /* ignore */
    }

    return promise;
  };

  try {
    // Preserve identity-ish properties so feature detection on the page still
    // sees something fetch-shaped.
    Object.defineProperty(patched, 'name', { value: 'fetch', configurable: true });
    Object.defineProperty(patched, 'length', { value: original.length, configurable: true });
    target.fetch = patched as typeof fetch;
  } catch {
    /* if we cannot install, leave the original in place */
  }
}

export function installXhrHook(target: InterceptTarget): void {
  const proto = target.XMLHttpRequest?.prototype;
  if (!proto) return;

  const originalOpen = proto.open;
  const originalSend = proto.send;
  if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') return;

  const post = makePoster(target);

  // Per-instance state. A WeakMap keeps it off the XHR objects themselves, so
  // nothing we add is observable to the page.
  const urls = new WeakMap<XMLHttpRequest, string>();

  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = urlOf(args[1]);
      if (isGraphqlUrl(url)) urls.set(this, url);
    } catch {
      /* ignore */
    }
    // @ts-expect-error - forwarding the page's own arguments verbatim
    return originalOpen.apply(this, args);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = urls.get(this);
      if (url) {
        // A separate listener, never onreadystatechange: X may reassign that,
        // and we must not be the reason a handler goes missing.
        this.addEventListener('load', () => {
          try {
            const type = this.responseType;
            if (type !== '' && type !== 'text') return;
            post(url, this.status, 'xhr', this.responseText);
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    // @ts-expect-error - forwarding the page's own arguments verbatim
    return originalSend.apply(this, args);
  } as typeof proto.send;
}

/** Install both hooks once. Returns true if this call did the installing. */
export function install(target: InterceptTarget): boolean {
  try {
    if (target[INSTALLED_FLAG]) return false;
    target[INSTALLED_FLAG] = true;
    installFetchHook(target);
    installXhrHook(target);
    return true;
  } catch {
    // The extension failing is acceptable; breaking x.com is not.
    return false;
  }
}

// Production entry. Guarded so importing this module in a test never touches a
// real window.
if (typeof window !== 'undefined') {
  const installed = install(window as unknown as InterceptTarget);
  if (__DEV__ && installed) console.debug('[x-thread-md] interceptor installed', __VERSION__);
}
