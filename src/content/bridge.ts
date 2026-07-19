// ISOLATED-world receiver for messages posted by the MAIN-world interceptor.
//
// Trust model (see SECURITY.md): the checks below are anti-confusion, not
// anti-attack. A hostile script already running on x.com could forge this
// envelope - but it is already on x.com and already has this data. What matters
// is that everything arriving here is treated as untrusted input: no eval, no
// innerHTML, JSON.parse only inside try/catch, all field access via safe
// accessors. This side never posts back into the page.

import { BRIDGE_TAG, BRIDGE_VERSION } from '../shared/messages.ts';
import type { BridgeGraphqlMessage } from '../shared/messages.ts';
import { debug } from '../shared/log.ts';

const ALLOWED_ORIGINS = new Set(['https://x.com', 'https://twitter.com']);

export type BridgeHandler = (message: BridgeGraphqlMessage) => void;

function isBridgeMessage(data: unknown): data is BridgeGraphqlMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d[BRIDGE_TAG] === BRIDGE_VERSION &&
    d['kind'] === 'graphql' &&
    typeof d['url'] === 'string' &&
    typeof d['status'] === 'number' &&
    typeof d['body'] === 'string' &&
    (d['transport'] === 'fetch' || d['transport'] === 'xhr')
  );
}

/** Start listening. Returns a teardown function. */
export function listen(handler: BridgeHandler): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    if (!ALLOWED_ORIGINS.has(event.origin)) return;
    if (!isBridgeMessage(event.data)) return;
    try {
      handler(event.data);
    } catch (err) {
      debug('bridge handler threw', err);
    }
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
