// extended_entities.media[] -> Media[].

import type { Media, MediaKind } from '../types/model.ts';
import { arr, get, num, str } from './accessors.ts';

/**
 * Upgrade a pbs.twimg.com URL to the largest stored version.
 *
 * `name=orig` returns the largest stored size (up to 4096px) and is also less
 * aggressively re-compressed than `large` at the same pixel dimensions.
 *
 * The original extension is preserved as the `format` value on purpose:
 * requesting `format=jpg` on a PNG re-encodes it and loses transparency.
 */
export function originalResolution(url: string): string {
  const match = /^(.*)\.(jpg|jpeg|png|webp|gif)$/i.exec(url);
  if (!match) {
    // Already parameterised, or an unexpected shape: only rewrite an existing
    // name= if there is one, rather than guessing a format.
    return url.includes('name=') ? url.replace(/name=[^&]+/, 'name=orig') : url;
  }
  const [, base, ext] = match;
  const format = ext!.toLowerCase() === 'jpeg' ? 'jpg' : ext!.toLowerCase();
  return `${base}?format=${format}&name=orig`;
}

function kindOf(type: string | null): MediaKind {
  switch (type) {
    case 'photo':
      return 'photo';
    case 'video':
      return 'video';
    case 'animated_gif':
      return 'gif';
    default:
      return 'unknown';
  }
}

/**
 * Best downloadable video variant.
 *
 * HLS variants (`application/x-mpegURL`) carry no bitrate and are not directly
 * downloadable, so only `video/mp4` is considered. `animated_gif` has a single
 * mp4 variant with no bitrate at all, hence the `?? 0` rather than a filter.
 */
export function bestVariant(variants: unknown[]): string | null {
  let best: { url: string; bitrate: number } | null = null;
  for (const variant of variants) {
    if (str(variant, 'content_type') !== 'video/mp4') continue;
    const url = str(variant, 'url');
    if (!url) continue;
    const bitrate = num(variant, 'bitrate') ?? 0;
    if (!best || bitrate > best.bitrate) best = { url, bitrate };
  }
  return best?.url ?? null;
}

export function parseMedia(legacy: unknown): Media[] {
  // extended_entities carries all four photos and the video variants;
  // entities.media is truncated to the first item.
  const items = arr(legacy, 'extended_entities.media');
  const out: Media[] = [];

  for (const item of items) {
    const kind = kindOf(str(item, 'type'));
    const posterUrl = str(item, 'media_url_https');
    const alt = str(item, 'ext_alt_text');
    const tcoUrl = str(item, 'url');

    let url: string | null = null;
    let durationMs: number | null = null;

    if (kind === 'photo') {
      url = posterUrl ? originalResolution(posterUrl) : null;
    } else {
      url = bestVariant(arr(item, 'video_info.variants'));
      durationMs = num(item, 'video_info.duration_millis');
    }
    if (!url) continue;

    out.push({
      kind,
      url,
      posterUrl: kind === 'photo' ? null : posterUrl,
      alt,
      width: num(item, 'original_info.width'),
      height: num(item, 'original_info.height'),
      durationMs,
      tcoUrl,
    });
  }

  return out;
}

/** The t.co URLs that stand in for attached media, so text can drop them. */
export function mediaTcoUrls(legacy: unknown): Set<string> {
  const urls = new Set<string>();
  for (const source of ['extended_entities.media', 'entities.media']) {
    for (const item of arr(legacy, source)) {
      const url = str(item, 'url');
      if (url) urls.add(url);
    }
  }
  // Some payloads carry the media t.co only on the media entity object itself.
  const single = get(legacy, 'entities.media.0.url');
  if (typeof single === 'string') urls.add(single);
  return urls;
}
