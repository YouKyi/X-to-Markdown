// In-page UI: the export button and the progress toast.
//
// Everything lives in a CLOSED shadow root, for two reasons. X's stylesheet
// cannot reach in and ours cannot leak out, and the page cannot walk into it
// looking for our nodes. Nothing here uses innerHTML: every node is built with
// createElement and textContent, because much of what ends up on screen derives
// from bridged, untrusted input.

import styles from './ui.css';
import { debug } from '../shared/log.ts';

const HOST_ID = 'x-thread-md-root';

/**
 * The action bar under a tweet — the row holding reply/repost/like.
 *
 * `[role="group"]` is the anchor rather than a data-testid because it is
 * semantic markup X is unlikely to drop, whereas testids get renamed. If it
 * moves anyway, injection fails softly and the floating button takes over.
 */
const ACTION_BAR = 'article [role="group"]';
const ARTICLE = 'article';

function icon(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  // Download glyph: shaft, head, baseline.
  path.setAttribute(
    'd',
    'M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3zM4 19h16v2H4v-2z',
  );
  svg.appendChild(path);
  return svg;
}

function caret(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M7 10l5 5 5-5z');
  svg.appendChild(path);
  return svg;
}

export interface UiHandlers {
  /** `plain` false means a modifier was held: export without auto-scrolling. */
  onExport: (plain: boolean) => void;
  onCancel: () => void;
  /** The scope toggle was changed; persist it. */
  onIncludeRepliesChange: (value: boolean) => void;
}

export class Ui {
  readonly #root: ShadowRoot;
  readonly #host: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #button: HTMLButtonElement;
  readonly #more: HTMLButtonElement;
  readonly #menu: HTMLElement;
  readonly #repliesBox: HTMLInputElement;
  readonly #toast: HTMLElement;
  readonly #message: HTMLElement;
  readonly #cancel: HTMLButtonElement;
  #onDocumentClick: ((event: Event) => void) | null = null;
  #onDismiss: (() => void) | null = null;
  #observer: MutationObserver | null = null;
  #placeTimer: ReturnType<typeof setInterval> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #anchored = false;
  #reloadOffered = false;

  constructor(handlers: UiHandlers) {
    this.#host = document.createElement('div');
    this.#host.id = HOST_ID;
    this.#root = this.#host.attachShadow({ mode: 'closed' });

    const sheet = document.createElement('style');
    sheet.textContent = styles;
    this.#root.appendChild(sheet);

    // The bar wraps button + caret + menu so the menu can be positioned against
    // it. Being inside the same shadow root, it follows the host wherever
    // #place() moves it, with no repositioning code of its own.
    this.#bar = document.createElement('div');
    this.#bar.className = 'bar';

    this.#button = document.createElement('button');
    this.#button.className = 'btn';
    this.#button.type = 'button';
    this.#button.title = 'Export this thread as Markdown (hold Alt to skip loading more replies)';
    this.#button.appendChild(icon());
    const label = document.createElement('span');
    label.textContent = 'Markdown';
    this.#button.appendChild(label);
    this.#button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#closeMenu();
      handlers.onExport(!event.altKey);
    });

    this.#more = document.createElement('button');
    this.#more.className = 'btn more';
    this.#more.type = 'button';
    this.#more.title = 'Export options';
    this.#more.setAttribute('aria-haspopup', 'true');
    this.#more.setAttribute('aria-expanded', 'false');
    this.#more.appendChild(caret());
    this.#more.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#toggleMenu();
    });

    this.#menu = document.createElement('div');
    this.#menu.className = 'menu';
    this.#menu.hidden = true;

    const row = document.createElement('label');
    row.className = 'row';
    this.#repliesBox = document.createElement('input');
    this.#repliesBox.type = 'checkbox';
    this.#repliesBox.checked = true;
    this.#repliesBox.addEventListener('change', () => {
      handlers.onIncludeRepliesChange(this.#repliesBox.checked);
      this.#syncHint();
    });
    const rowLabel = document.createElement('span');
    rowLabel.textContent = 'Include replies';
    row.append(this.#repliesBox, rowLabel);

    const hint = document.createElement('div');
    hint.className = 'hint';
    this.#menu.append(row, hint);

    this.#bar.append(this.#button, this.#more, this.#menu);
    this.#root.appendChild(this.#bar);
    this.#syncHint();

    this.#toast = document.createElement('div');
    this.#toast.className = 'toast';
    this.#toast.hidden = true;
    this.#toast.setAttribute('role', 'status');
    this.#message = document.createElement('div');
    this.#message.className = 'msg';
    this.#cancel = document.createElement('button');
    this.#cancel.className = 'cancel';
    this.#cancel.type = 'button';
    this.#cancel.textContent = 'Cancel';
    this.#cancel.hidden = true;
    this.#cancel.addEventListener('click', () => handlers.onCancel());
    this.#toast.append(this.#message, this.#cancel);
    this.#root.appendChild(this.#toast);
  }

  /**
   * Reflect the stored setting on the checkbox.
   *
   * Called after settings load and on every change from the options page, so
   * the menu never shows a state the exporter will not act on.
   */
  setIncludeReplies(value: boolean): void {
    this.#repliesBox.checked = value;
    this.#syncHint();
  }

  /** Say what the button will produce, so the choice is legible before clicking. */
  #syncHint(): void {
    const hint = this.#menu.querySelector('.hint');
    if (hint) {
      hint.textContent = this.#repliesBox.checked
        ? 'The full conversation, replies included.'
        : "Only the author's thread — no scrolling needed.";
    }
    this.#button.title = this.#repliesBox.checked
      ? 'Export this thread as Markdown (hold Alt to skip loading more replies)'
      : "Export the author's thread as Markdown";
  }

  #toggleMenu(): void {
    if (this.#menu.hidden) this.#openMenu();
    else this.#closeMenu();
  }

  /** Menu width used for edge clamping; matches min-width in the stylesheet. */
  static readonly #MENU_WIDTH = 220;

  /**
   * Place the fixed-position menu against the caret.
   *
   * Computed here rather than in CSS because a fixed element has no anchor.
   * Right-aligned to the bar, flipped above it when there is not enough room
   * below — which is the normal case for the floating button, since it sits
   * near the bottom of the viewport.
   */
  #positionMenu(): void {
    const anchor = this.#bar.getBoundingClientRect();
    const gap = 6;

    this.#menu.style.left = `${Math.max(
      8,
      Math.min(anchor.right - Ui.#MENU_WIDTH, window.innerWidth - Ui.#MENU_WIDTH - 8),
    )}px`;

    // Measured rather than assumed: the hint line wraps differently depending on
    // which of the two texts is showing, so the height is not a constant.
    const height = this.#menu.offsetHeight || 90;
    const below = anchor.bottom + gap;
    this.#menu.style.top =
      below + height > window.innerHeight ? `${Math.max(8, anchor.top - gap - height)}px` : `${below}px`;
  }

  #openMenu(): void {
    this.#menu.hidden = false;
    this.#more.setAttribute('aria-expanded', 'true');
    this.#positionMenu();
    // Dismiss on any click elsewhere. Registered on the document rather than on
    // the host so a click anywhere on x.com closes it; the listener is removed
    // again on close so nothing of ours stays attached to the page while idle.
    this.#onDocumentClick = (event: Event) => {
      if (event.composedPath().includes(this.#bar)) return;
      this.#closeMenu();
    };
    document.addEventListener('click', this.#onDocumentClick, true);

    // A fixed menu no longer travels with the page, so scrolling would leave it
    // stranded beside whatever scrolled under it. Closing is the honest answer:
    // repositioning on every scroll frame buys nothing for a menu the user is
    // about to click anyway. Capture phase, because x.com scrolls an inner
    // container rather than the window, and those events do not bubble to it.
    this.#onDismiss = () => this.#closeMenu();
    document.addEventListener('scroll', this.#onDismiss, true);
    window.addEventListener('resize', this.#onDismiss);
  }

  #closeMenu(): void {
    if (this.#menu.hidden) return;
    this.#menu.hidden = true;
    this.#more.setAttribute('aria-expanded', 'false');
    if (this.#onDismiss) {
      document.removeEventListener('scroll', this.#onDismiss, true);
      window.removeEventListener('resize', this.#onDismiss);
      this.#onDismiss = null;
    }
    if (this.#onDocumentClick) {
      document.removeEventListener('click', this.#onDocumentClick, true);
      this.#onDocumentClick = null;
    }
  }

  /**
   * Attach to the page and keep the button anchored as X re-renders.
   *
   * Callers must wait for document.body: this script runs at document_start,
   * where body does not exist yet. The guard is a second line of defence, not
   * the mechanism.
   */
  mount(): void {
    if (!document.body) throw new Error('mount() called before document.body exists');

    // Remove any host left behind by a previous instance of this content
    // script. Reloading the extension while a tab is open injects a fresh
    // script and orphans the old one: its listeners are dead but its DOM is
    // still on the page, so without this the user accumulates buttons that do
    // nothing. The shadow root is closed, so a stale host cannot be told apart
    // from ours — removing every one and re-appending is the reliable move.
    for (const stale of document.querySelectorAll(`#${HOST_ID}`)) {
      if (stale !== this.#host) stale.remove();
    }

    if (!this.#host.isConnected) document.body.appendChild(this.#host);
    this.#place();

    // X recycles DOM nodes constantly on a virtualised timeline, so the anchor
    // disappears without warning. Re-place on any body mutation, throttled to
    // one animation frame.
    let queued = false;
    this.#observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.#place();
      });
    });
    this.#observer.observe(document.body, { childList: true, subtree: true });

    // Safety net. The observer only reacts to mutations, so if X detaches the
    // host and then goes quiet, the button would stay gone. A slow poll makes
    // "the button is present" an invariant this class holds, rather than
    // something that depends on x.com continuing to re-render.
    this.#placeTimer = setInterval(() => this.#place(), 1000);
  }

  unmount(): void {
    // First: the menu owns document-level scroll and click listeners, and
    // removing the host would leave them attached to a page that no longer has
    // any of our UI on it. This runs on retire(), which is exactly when an
    // orphaned content script is trying to stop touching x.com.
    this.#closeMenu();
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#placeTimer) clearInterval(this.#placeTimer);
    this.#placeTimer = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#host.remove();
  }

  /**
   * Put the host next to the focal tweet's action bar, or fall back to a
   * floating button. The host carries the shadow root, so moving it moves the
   * whole UI including the toast, which is position: fixed regardless.
   */
  #place(): void {
    // X re-renders the tweet header constantly and takes our host with it when
    // it replaces that subtree. Reattaching is the first thing done here, and
    // unconditionally: a host that is merely mispositioned is a cosmetic
    // problem, whereas a detached one is a button that has vanished with no
    // path back.
    if (!this.#host.isConnected) this.#toFloating();

    const bar = this.#focalActionBar();
    const target = bar?.parentElement ?? null;

    // A detached action bar has no parent to anchor to. Staying floating and
    // visible beats moving nowhere and losing the `floating` styling, which is
    // what previously left the button as an unpositioned child of <body>, below
    // every other element on the page.
    if (!target) {
      if (this.#anchored) debug('action bar lost; using the floating button');
      this.#toFloating();
      return;
    }

    if (this.#host.parentElement !== target) {
      target.appendChild(this.#host);
      this.#host.style.display = 'inline-flex';
      this.#host.style.alignItems = 'center';
      this.#host.style.marginLeft = 'auto';
    }
    if (!this.#anchored) debug('export button anchored to the tweet action bar');
    this.#anchored = true;
    this.#bar.classList.remove('floating');
  }

  #resetAction(): void {
    if (!this.#reloadOffered) return;
    this.#cancel.textContent = 'Cancel';
    this.#reloadOffered = false;
  }

  /** Park the host on <body> as a fixed-position floating button. */
  #toFloating(): void {
    if (this.#host.parentElement !== document.body) document.body.appendChild(this.#host);
    this.#host.removeAttribute('style');
    this.#bar.classList.add('floating');
    this.#anchored = false;
  }

  /** The action bar of the first article on the page — the focal tweet. */
  #focalActionBar(): Element | null {
    const article = document.querySelector(ARTICLE);
    if (!article) return null;
    const bar = article.querySelector('[role="group"]') ?? document.querySelector(ACTION_BAR);
    return bar ?? null;
  }

  setBusy(busy: boolean): void {
    this.#button.disabled = busy;
  }

  progress(message: string, cancellable = true): void {
    this.#resetAction();
    this.#toast.className = 'toast';
    this.#toast.hidden = false;
    this.#message.textContent = message;
    this.#cancel.hidden = !cancellable;
  }

  done(message: string): void {
    this.#resetAction();
    this.#toast.className = 'toast done';
    this.#toast.hidden = false;
    this.#message.textContent = message;
    this.#cancel.hidden = true;
    this.#autoHide(4000);
  }

  error(message: string): void {
    this.#resetAction();
    this.#toast.className = 'toast error';
    this.#toast.hidden = false;
    this.#message.textContent = message;
    this.#cancel.hidden = true;
    this.#autoHide(8000);
  }

  /**
   * Error state with a reload button.
   *
   * Reserved for the one failure a reload actually fixes: the GraphQL payload
   * arrived before the interceptor was listening and cannot be replayed. Telling
   * the user to reload and making them do it themselves is worse than offering
   * the action, and the export re-runs automatically once the page comes back.
   */
  offerReload(message: string): void {
    this.#toast.className = 'toast error';
    this.#toast.hidden = false;
    this.#message.textContent = message;
    this.#cancel.textContent = 'Reload';
    this.#cancel.hidden = false;
    this.#reloadOffered = true;
  }

  hide(): void {
    this.#toast.hidden = true;
    if (this.#reloadOffered) {
      this.#cancel.textContent = 'Cancel';
      this.#reloadOffered = false;
    }
  }

  /** True while the toast's action button means "reload" rather than "cancel". */
  get reloadOffered(): boolean {
    return this.#reloadOffered;
  }

  #autoHide(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.hide(), ms);
  }
}
