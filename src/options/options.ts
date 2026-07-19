// Options page. Plain DOM binding against storage.sync - no framework, no
// inline script (the extension_pages CSP forbids it).

import { DEFAULTS, loadSettings, saveSettings, normalize } from '../shared/config.ts';
import type { Settings } from '../shared/config.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const fields = {
  action: () => el<HTMLSelectElement>('action'),
  filenameTemplate: () => el<HTMLInputElement>('filenameTemplate'),
  tags: () => el<HTMLInputElement>('tags'),
  escapeMode: () => el<HTMLSelectElement>('escapeMode'),
  obsidianCallouts: () => el<HTMLInputElement>('obsidianCallouts'),
  hardLineBreaks: () => el<HTMLInputElement>('hardLineBreaks'),
  includeVideoPosters: () => el<HTMLInputElement>('includeVideoPosters'),
  autoScroll: () => el<HTMLInputElement>('autoScroll'),
  expandCollapsed: () => el<HTMLInputElement>('expandCollapsed'),
  domMetrics: () => el<HTMLInputElement>('domMetrics'),
  debug: () => el<HTMLInputElement>('debug'),
  includeReplies: () => el<HTMLInputElement>('includeReplies'),
  maxTweets: () => el<HTMLInputElement>('maxTweets'),
  maxDepth: () => el<HTMLInputElement>('maxDepth'),
  maxChildrenPerNode: () => el<HTMLInputElement>('maxChildrenPerNode'),
  maxRounds: () => el<HTMLInputElement>('maxRounds'),
  maxWallClockMs: () => el<HTMLInputElement>('maxWallClockMs'),
};

function fill(settings: Settings): void {
  fields.action().value = settings.action;
  fields.filenameTemplate().value = settings.filenameTemplate;
  fields.tags().value = settings.tags.join(', ');
  fields.escapeMode().value = settings.escapeMode;
  fields.obsidianCallouts().checked = settings.obsidianCallouts;
  fields.hardLineBreaks().checked = settings.hardLineBreaks;
  fields.includeVideoPosters().checked = settings.includeVideoPosters;
  fields.autoScroll().checked = settings.autoScroll;
  fields.expandCollapsed().checked = settings.expandCollapsed;
  fields.domMetrics().checked = settings.domMetrics;
  fields.debug().checked = settings.debug;
  fields.includeReplies().checked = settings.includeReplies;
  fields.maxTweets().value = String(settings.maxTweets);
  fields.maxDepth().value = String(settings.maxDepth);
  fields.maxChildrenPerNode().value = String(settings.maxChildrenPerNode);
  fields.maxRounds().value = String(settings.maxRounds);
  fields.maxWallClockMs().value = String(settings.maxWallClockMs);
}

function collect(): Settings {
  // normalize() does the coercing and clamping; this only gathers raw values.
  return normalize({
    action: fields.action().value,
    filenameTemplate: fields.filenameTemplate().value,
    tags: fields
      .tags()
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    escapeMode: fields.escapeMode().value,
    obsidianCallouts: fields.obsidianCallouts().checked,
    hardLineBreaks: fields.hardLineBreaks().checked,
    includeVideoPosters: fields.includeVideoPosters().checked,
    autoScroll: fields.autoScroll().checked,
    expandCollapsed: fields.expandCollapsed().checked,
    domMetrics: fields.domMetrics().checked,
    debug: fields.debug().checked,
    includeReplies: fields.includeReplies().checked,
    maxTweets: Number(fields.maxTweets().value),
    maxDepth: Number(fields.maxDepth().value),
    maxChildrenPerNode: Number(fields.maxChildrenPerNode().value),
    maxRounds: Number(fields.maxRounds().value),
    maxWallClockMs: Number(fields.maxWallClockMs().value),
  });
}

function flash(message: string): void {
  const status = el<HTMLElement>('status');
  status.textContent = message;
  setTimeout(() => {
    if (status.textContent === message) status.textContent = '';
  }, 2500);
}

void loadSettings().then(fill);

el<HTMLFormElement>('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const settings = collect();
  void saveSettings(settings).then(() => {
    // Re-fill so the user sees any clamping that was applied.
    fill(settings);
    flash('Saved.');
  });
});

el<HTMLButtonElement>('reset').addEventListener('click', () => {
  fill(DEFAULTS);
  void saveSettings(DEFAULTS).then(() => flash('Reset to defaults.'));
});
