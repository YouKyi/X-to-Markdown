// User settings, persisted in storage.sync.
//
// The pagination caps here are *hard ceilings*, not just defaults: a runaway
// scroll loop on someone else's site is the failure mode most likely to look
// like abuse, so the options page can lower them but never raise them past
// the LIMITS below.

export type EscapeMode = 'minimal' | 'strict';
export type ExportAction = 'clipboard' | 'download' | 'both';

export interface Settings {
  /** What the export button does on a plain click. */
  action: ExportAction;
  /** Filename template for downloads. See render/filename.ts for variables. */
  filenameTemplate: string;
  /** Frontmatter tags applied to every export. */
  tags: string[];
  /** Markdown escaping aggressiveness. */
  escapeMode: EscapeMode;
  /** Render `> [!quote]` callouts for quoted tweets (Obsidian-flavoured). */
  obsidianCallouts: boolean;
  /** Force `<br>` with two trailing spaces so a tweet's line structure survives
   *  strict CommonMark renderers. Obsidian preserves single newlines anyway. */
  hardLineBreaks: boolean;
  /** Include a poster image line for videos and GIFs. */
  includeVideoPosters: boolean;
  /** Best-effort parse of engagement counts in DOM fallback mode. Off: a wrong
   *  number written silently into your notes is worse than a missing one. */
  domMetrics: boolean;
  /** Verbose logging + Tweet.raw population + raw payload retention. */
  debug: boolean;
  /** Scroll to load the rest of the conversation before exporting. */
  autoScroll: boolean;
  /** Also click "show more replies" controls while scrolling. Structurally
   *  guarded so it can never land on a Follow button — see thread/paginate.ts. */
  expandCollapsed: boolean;

  maxTweets: number;
  maxDepth: number;
  maxChildrenPerNode: number;
  maxRounds: number;
  maxWallClockMs: number;
}

export const DEFAULTS: Settings = {
  action: 'both',
  filenameTemplate: '{date}-{handle}-{id}',
  tags: ['tweet', 'x-export'],
  escapeMode: 'minimal',
  obsidianCallouts: true,
  hardLineBreaks: true,
  includeVideoPosters: true,
  domMetrics: false,
  debug: false,
  autoScroll: true,
  expandCollapsed: true,

  maxTweets: 500,
  maxDepth: 10,
  // Deliberately loose: this exists to stop one tweet eating the whole
  // budget, not to trim a busy conversation. maxTweets is the real limit, and
  // a tight value here discards replies already downloaded.
  maxChildrenPerNode: 250,
  // Enough rounds to traverse a long page at 0.8 viewport each; the time
  // budget is the real backstop.
  maxRounds: 150,
  maxWallClockMs: 90_000,
};

/** Hard ceilings. Settings are clamped to these on load, not just on save. */
export const LIMITS = {
  maxTweets: 2000,
  maxDepth: 25,
  maxChildrenPerNode: 500,
  maxRounds: 400,
  maxWallClockMs: 300_000,
} as const;

const STORAGE_KEY = 'settings';

function clampNumber(value: unknown, fallback: number, ceiling: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(Math.floor(n), ceiling));
}

/** Merge stored values over DEFAULTS, coercing and clamping. Never throws. */
export function normalize(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Settings>;
  return {
    action: s.action === 'clipboard' || s.action === 'download' || s.action === 'both'
      ? s.action
      : DEFAULTS.action,
    filenameTemplate:
      typeof s.filenameTemplate === 'string' && s.filenameTemplate.trim() !== ''
        ? s.filenameTemplate
        : DEFAULTS.filenameTemplate,
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : DEFAULTS.tags,
    escapeMode: s.escapeMode === 'strict' ? 'strict' : 'minimal',
    obsidianCallouts: s.obsidianCallouts !== false,
    hardLineBreaks: s.hardLineBreaks !== false,
    includeVideoPosters: s.includeVideoPosters !== false,
    domMetrics: s.domMetrics === true,
    debug: s.debug === true,
    autoScroll: s.autoScroll !== false,
    expandCollapsed: s.expandCollapsed !== false,

    maxTweets: clampNumber(s.maxTweets, DEFAULTS.maxTweets, LIMITS.maxTweets),
    maxDepth: clampNumber(s.maxDepth, DEFAULTS.maxDepth, LIMITS.maxDepth),
    maxChildrenPerNode: clampNumber(
      s.maxChildrenPerNode,
      DEFAULTS.maxChildrenPerNode,
      LIMITS.maxChildrenPerNode,
    ),
    maxRounds: clampNumber(s.maxRounds, DEFAULTS.maxRounds, LIMITS.maxRounds),
    maxWallClockMs: clampNumber(s.maxWallClockMs, DEFAULTS.maxWallClockMs, LIMITS.maxWallClockMs),
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const got = await browser.storage.sync.get(STORAGE_KEY);
    return normalize(got[STORAGE_KEY]);
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.sync.set({ [STORAGE_KEY]: normalize(settings) });
}

export function onSettingsChanged(cb: (settings: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const change = changes[STORAGE_KEY];
    if (change) cb(normalize(change.newValue));
  });
}
