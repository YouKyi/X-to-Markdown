// Background event page.
//
// Firefox MV3 uses `background.scripts`, not a service worker. That is a real
// advantage here: event pages have a DOM, so URL.createObjectURL works and the
// Markdown file can be handed to downloads.download as a blob URL rather than a
// size-limited data: URL.
//
// This page holds the only two privileged capabilities in the extension —
// downloads and permissions — and nothing else.

import type { RuntimeRequest, RuntimeResponse } from '../shared/messages.ts';
import { warn } from '../shared/log.ts';

const HOST_ORIGINS = ['https://x.com/*', 'https://twitter.com/*'];

/** Blob URLs pending revocation, keyed by download id. */
const pendingRevokes = new Map<number, string>();

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const url = pendingRevokes.get(delta.id);
  if (!url) return;
  pendingRevokes.delete(delta.id);
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
});

async function handleDownload(
  request: Extract<RuntimeRequest, { kind: 'download' }>,
): Promise<RuntimeResponse> {
  const url = URL.createObjectURL(new Blob([request.text], { type: 'text/markdown' }));
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: request.filename,
      saveAs: request.saveAs,
      conflictAction: 'uniquify',
    });
    pendingRevokes.set(downloadId, url);
    return { ok: true, kind: 'download', downloadId };
  } catch (err) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

browser.runtime.onMessage.addListener((message) => {
  const request = message as RuntimeRequest;
  switch (request?.kind) {
    case 'download':
      return handleDownload(request);
    case 'check-permissions':
      return browser.permissions
        .contains({ origins: HOST_ORIGINS })
        .then((granted): RuntimeResponse => ({ ok: true, kind: 'permissions', granted }));
    case 'request-permissions':
      return browser.permissions
        .request({ origins: HOST_ORIGINS })
        .then((granted): RuntimeResponse => ({ ok: true, kind: 'permissions', granted }));
    default:
      return undefined;
  }
});

// Toolbar action. Two jobs, in priority order.
//
// Host permissions are granted at install from Firefox 127 on, so the missing
// case is rare — but the user can revoke them in about:addons, and when they do
// the content script silently stops injecting. Without this the extension would
// simply appear broken, so the toolbar button becomes the way back.
//
// Otherwise it asks the content script for its retained raw payloads, which is
// the fixture capture path. Only meaningful with debug mode on.
browser.action.onClicked.addListener((tab) => {
  void (async () => {
    try {
      const granted = await browser.permissions.contains({ origins: HOST_ORIGINS });
      if (!granted) {
        // Must be called from a user gesture, which the click provides.
        const now = await browser.permissions.request({ origins: HOST_ORIGINS });
        warn(now ? 'host access granted; reload the page' : 'host access refused');
        return;
      }
    } catch (err) {
      warn('permission check failed', err);
    }

    if (tab.id === undefined) return;
    try {
      await browser.tabs.sendMessage(tab.id, { kind: 'dump-payloads' });
    } catch (err) {
      warn('no content script on this tab', err);
    }
  })();
});
