// Safe navigation over X's GraphQL blobs.
//
// The central difficulty of this project is walking a deeply nested, untyped,
// third-party JSON structure whose shape changes without notice. Every access in
// parse/ goes through this module, and nothing here ever throws.

/** Walk a dotted path. Array indices are written as numbers: 'a.b.0.c'. */
export function get(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function str(obj: unknown, path: string): string | null {
  const value = get(obj, path);
  return typeof value === 'string' ? value : null;
}

export function num(obj: unknown, path: string): number | null {
  const value = get(obj, path);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // X returns some counts as numeric strings (views.count in particular).
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function bool(obj: unknown, path: string): boolean | null {
  const value = get(obj, path);
  return typeof value === 'boolean' ? value : null;
}

export function arr(obj: unknown, path: string): unknown[] {
  const value = get(obj, path);
  return Array.isArray(value) ? value : [];
}

/**
 * First defined value among several paths.
 *
 * This is how schema migrations are absorbed. Every call site should name both
 * eras in a comment, e.g. the 2025 move of author fields from
 * `core.user_results.result.legacy.screen_name` to `...result.core.screen_name`.
 */
export function firstOf(obj: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    const value = get(obj, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function strOf(obj: unknown, ...paths: string[]): string | null {
  const value = firstOf(obj, ...paths);
  return typeof value === 'string' ? value : null;
}

/**
 * Unwrap `TweetWithVisibilityResults`.
 *
 * When a tweet carries a visibility interstitial ("this post may contain
 * sensitive content"), X wraps the real object one level deeper under `.tweet`.
 * Missing this is the single most common bug in third-party X parsers: it
 * silently drops every restricted tweet in a conversation.
 */
export function unwrapTweet(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const typename = str(result, '__typename');
  if (typename === 'TweetWithVisibilityResults') {
    const inner = get(result, 'tweet');
    return inner ?? result;
  }
  return result;
}

/**
 * X's created_at format: "Wed Mar 21 20:50:14 +0000 2006" -> ISO 8601 UTC.
 * Returns null rather than an Invalid Date string.
 */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
