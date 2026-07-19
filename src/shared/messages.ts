// Typed contracts for the two message channels in this extension.
//
//   1. MAIN world  -> ISOLATED content script, via window.postMessage
//   2. content script <-> background event page, via browser.runtime

/** Envelope tag. Bumped only if the envelope shape itself changes. */
export const BRIDGE_TAG = '__xtmd' as const;
export const BRIDGE_VERSION = 1 as const;

/**
 * One captured HTTP response from X's own GraphQL traffic.
 *
 * `body` is the raw response text, NOT a parsed object: structured-cloning a
 * parsed 5 MB payload across the world boundary is slow, and parsing on the
 * ISOLATED side keeps JSON.parse inside our own try/catch.
 */
export interface BridgeGraphqlMessage {
  [BRIDGE_TAG]: typeof BRIDGE_VERSION;
  kind: 'graphql';
  /** Request URL, used only for debug labelling and rate-limit attribution. */
  url: string;
  /** HTTP status. 429 stops pagination immediately. */
  status: number;
  /** Which transport captured it - useful when diagnosing a miss. */
  transport: 'fetch' | 'xhr';
  body: string;
}

export type BridgeMessage = BridgeGraphqlMessage;

/** Runtime messages: content script -> background. */
export type RuntimeRequest =
  | { kind: 'download'; filename: string; text: string; saveAs: boolean }
  | { kind: 'check-permissions' }
  | { kind: 'request-permissions' };

export type RuntimeResponse =
  | { ok: true; kind: 'download'; downloadId: number }
  | { ok: true; kind: 'permissions'; granted: boolean }
  | { ok: false; error: string };
