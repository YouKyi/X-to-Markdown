// Debug logging, off by default.
//
// The dedupe matters more than it looks: a single TweetDetail payload can carry
// 500 entries, and an unrecognised shape in all of them would otherwise produce
// 500 identical console lines and bury the one message you needed.

const PREFIX = '[x-thread-md]';

let enabled = false;
const seenShapes = new Set<string>();

export function setDebug(value: boolean): void {
  enabled = value;
}

export function isDebug(): boolean {
  return enabled;
}

export function debug(...args: unknown[]): void {
  if (enabled) console.debug(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

/**
 * Log an unrecognised payload shape at most once per distinct key.
 *
 * `key` should identify the *shape*, not the instance - e.g.
 * `unknown-entry:promoted`, not `unknown-entry:promoted-tweet-1234567890`.
 */
export function shape(key: string, ...args: unknown[]): void {
  if (!enabled) return;
  if (seenShapes.has(key)) return;
  seenShapes.add(key);
  console.debug(PREFIX, 'unrecognised shape:', key, ...args);
}

/** Distinct unrecognised shapes seen so far, for the per-export summary. */
export function seenShapeKeys(): string[] {
  return [...seenShapes];
}

export function resetShapes(): void {
  seenShapes.clear();
}
