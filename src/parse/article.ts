// One raw `article.article_results.result` -> one normalised Article.
//
// X Articles are not long-form posts. A `note_tweet` is still tweet text and
// parse/text.ts handles it; an Article is a separate entity whose body lives in
// a Draft.js content state, while the carrying tweet's `full_text` holds one
// t.co and nothing else. Reading only the tweet gives you a link.
//
// Everything here was read off a real capture rather than reasoned about, and
// four details would each have produced plausible, wrong output:
//
//   - `entityMap` is NOT indexed by the key an `entityRange` carries. It is a
//     list of `{ key, value }` pairs whose position is unrelated to the key:
//     in the capture this was written against, entity `key: 0` sat at index 17.
//     Indexing by position mislabels every link and every image in the article.
//   - a LINK range includes the space BEFORE the anchor, so the naive slice
//     yields " dynamic workflows" and the rendered link starts with a space.
//   - images carry only a `mediaId`, joined against `media_entities`; there is
//     no URL anywhere in the block.
//   - a MARKDOWN entity already holds a fenced code block, so it must reach the
//     document unescaped, unlike every other piece of text in this codebase.
//
// Nothing in here throws: a block that cannot be read is dropped and the
// article is marked partial, exactly like parse/tweet.ts.

import type { Article, ArticleBlock, ArticleLink, ArticleStyle, Media } from '../types/model.ts';
import { arr, get, num, str } from './accessors.ts';
import { shape } from '../shared/log.ts';

/** X's block types, mapped onto what the renderer can express. */
const BLOCK_KINDS: Record<string, ArticleBlock['kind']> = {
  unstyled: 'paragraph',
  'header-one': 'heading',
  'header-two': 'heading',
  'header-three': 'heading',
  'unordered-list-item': 'list-item',
  'ordered-list-item': 'list-item',
};

const HEADING_LEVELS: Record<string, number> = {
  'header-one': 1,
  'header-two': 2,
  'header-three': 3,
};

/** X spells its inline styles in title case. */
const STYLES: Record<string, ArticleStyle['style']> = {
  Bold: 'bold',
  Italic: 'italic',
};

interface Entity {
  type: string;
  data: unknown;
}

/**
 * Index the entity table by the key an `entityRange` actually references.
 *
 * See the header: position in this list is not the key. The pairs are read in
 * order so that a duplicate key resolves to the first one, which is what a
 * lookup table would have done anyway.
 */
function indexEntities(contentState: unknown): Map<number, Entity> {
  const out = new Map<number, Entity>();
  const map = get(contentState, 'entityMap');
  if (!map || typeof map !== 'object') return out;

  for (const pair of Object.values(map as Record<string, unknown>)) {
    const key = num(pair, 'key');
    const type = str(pair, 'value.type');
    if (key === null || type === null) continue;
    if (out.has(key)) continue;
    out.set(key, { type, data: get(pair, 'value.data') });
  }
  return out;
}

/** media_id -> Media, from the article's own media table. */
function indexMedia(articleResult: unknown): Map<string, Media> {
  const out = new Map<string, Media>();
  for (const entity of arr(articleResult, 'media_entities')) {
    const id = str(entity, 'media_id');
    const url = str(entity, 'media_info.original_img_url');
    if (id === null || url === null) continue;
    out.set(id, {
      kind: 'photo',
      url,
      posterUrl: null,
      // Article images carry no alt text: the caption is the entity's, not the
      // image's, so it stays on the block rather than being promoted to alt.
      alt: null,
      width: num(entity, 'media_info.original_img_width'),
      height: num(entity, 'media_info.original_img_height'),
      durationMs: null,
      tcoUrl: null,
    });
  }
  return out;
}

/** Ranges X sends that fall outside the text are dropped rather than clamped. */
function validRange(offset: number | null, length: number | null, textLength: number): boolean {
  if (offset === null || length === null) return false;
  if (offset < 0 || length <= 0) return false;
  return offset + length <= textLength;
}

/**
 * Trim a range that begins on whitespace.
 *
 * X's editor includes the separating space in a link range. Left alone the
 * anchor renders as `[ dynamic workflows](...)`, whose leading space is inside
 * the link text in every renderer.
 */
function tightenRange(text: string, offset: number, length: number): ArticleLink | ArticleStyle {
  let start = offset;
  let end = offset + length;
  while (start < end && /\s/.test(text.charAt(start))) start += 1;
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1;
  return { offset: start, length: end - start } as ArticleLink;
}

function parseBlock(
  rawBlock: unknown,
  entities: Map<number, Entity>,
  media: Map<string, Media>,
  onPartial: () => void,
): ArticleBlock | null {
  const type = str(rawBlock, 'type');
  const text = str(rawBlock, 'text') ?? '';
  if (type === null) {
    onPartial();
    return null;
  }

  // An atomic block is a placeholder: its text is a single space and everything
  // it means is in the entity it points at.
  if (type === 'atomic') {
    const key = num(rawBlock, 'entityRanges.0.key');
    const entity = key === null ? undefined : entities.get(key);
    if (!entity) {
      shape('article-atomic-without-entity', rawBlock);
      onPartial();
      return null;
    }

    if (entity.type === 'DIVIDER') {
      return blank('divider');
    }

    if (entity.type === 'MARKDOWN') {
      const markdown = str(entity.data, 'markdown');
      if (markdown === null) {
        onPartial();
        return null;
      }
      return { ...blank('code'), code: markdown };
    }

    if (entity.type === 'MEDIA') {
      const items = arr(entity.data, 'mediaItems');
      const id = items.length > 0 ? str(items[0], 'mediaId') : null;
      const found = id === null ? undefined : media.get(id);
      if (!found) {
        // The image exists and we cannot resolve it; saying so beats dropping it.
        shape('article-media-unresolved', { id });
        onPartial();
        return null;
      }
      return { ...blank('image'), media: found, caption: str(entity.data, 'caption') };
    }

    shape(`article-entity:${entity.type}`, entity);
    onPartial();
    return null;
  }

  const kind = BLOCK_KINDS[type];
  if (!kind) {
    shape(`article-block:${type}`, rawBlock);
    onPartial();
    return null;
  }

  const styles: ArticleStyle[] = [];
  for (const range of arr(rawBlock, 'inlineStyleRanges')) {
    const style = STYLES[str(range, 'style') ?? ''];
    const offset = num(range, 'offset');
    const length = num(range, 'length');
    if (!style) {
      shape(`article-style:${str(range, 'style')}`, range);
      continue;
    }
    if (!validRange(offset, length, text.length)) continue;
    const tightened = tightenRange(text, offset as number, length as number);
    if (tightened.length > 0) styles.push({ ...tightened, style });
  }

  const links: ArticleLink[] = [];
  for (const range of arr(rawBlock, 'entityRanges')) {
    const key = num(range, 'key');
    const entity = key === null ? undefined : entities.get(key);
    if (!entity) continue;
    if (entity.type !== 'LINK') {
      // A non-link entity inside a text block is not something this parser
      // knows how to place inline; the text itself is still rendered.
      shape(`article-inline-entity:${entity.type}`, entity);
      continue;
    }
    const url = str(entity.data, 'url');
    const offset = num(range, 'offset');
    const length = num(range, 'length');
    if (url === null || !validRange(offset, length, text.length)) continue;
    const tightened = tightenRange(text, offset as number, length as number);
    if (tightened.length > 0) links.push({ ...tightened, url });
  }

  // Mentions are the third kind of inline run and arrive from neither of the
  // places the other two do: not an entity, not a style, but `block.data`. They
  // render exactly like a link, so they join `links` rather than growing the
  // model a field that would be handled identically everywhere.
  //
  // `fromIndex` points AT the '@' and `toIndex` is exclusive, so the range is
  // the handle including its sigil. `text` is the handle without it.
  for (const mention of arr(rawBlock, 'data.mentions')) {
    const handle = str(mention, 'text');
    const from = num(mention, 'fromIndex');
    const to = num(mention, 'toIndex');
    if (handle === null || from === null || to === null) continue;
    if (!validRange(from, to - from, text.length)) continue;
    links.push({ offset: from, length: to - from, url: `https://x.com/${handle}` });
  }

  // Overlapping runs would produce interleaved markup like `**a *b** c*`, which
  // no renderer reads back the way it was written. Later runs lose.
  return {
    kind,
    text,
    level: HEADING_LEVELS[type] ?? null,
    styles: dropOverlaps(styles),
    links: dropOverlaps(links),
    code: null,
    media: null,
    caption: null,
  };
}

function blank(kind: ArticleBlock['kind']): ArticleBlock {
  return {
    kind,
    text: '',
    level: null,
    styles: [],
    links: [],
    code: null,
    media: null,
    caption: null,
  };
}

function dropOverlaps<T extends { offset: number; length: number }>(runs: T[]): T[] {
  const sorted = [...runs].sort((a, b) => a.offset - b.offset);
  const out: T[] = [];
  let end = -1;
  for (const run of sorted) {
    if (run.offset < end) continue;
    out.push(run);
    end = run.offset + run.length;
  }
  return out;
}

/**
 * Parse the article a tweet carries, if any.
 *
 * Returns null when the tweet has no article - the overwhelmingly common case -
 * so callers can assign the result straight through.
 */
export function parseArticle(tweetResult: unknown): Article | null {
  try {
    const result = get(tweetResult, 'article.article_results.result');
    if (!result || typeof result !== 'object') return null;

    const id = str(result, 'rest_id');
    if (id === null) {
      shape('article-missing-rest-id', result);
      return null;
    }

    let partial = false;
    const onPartial = (): void => {
      partial = true;
    };

    const entities = indexEntities(get(result, 'content_state'));
    const media = indexMedia(result);

    const blocks: ArticleBlock[] = [];
    for (const rawBlock of arr(result, 'content_state.blocks')) {
      const block = parseBlock(rawBlock, entities, media, onPartial);
      if (block) blocks.push(block);
    }

    if (blocks.length === 0) {
      // Title and link still beat nothing, but the reader must not be told this
      // is the article.
      partial = true;
    }

    return {
      id,
      title: str(result, 'title') ?? '',
      url: `https://x.com/i/article/${id}`,
      coverUrl: str(result, 'cover_media.media_info.original_img_url'),
      summary: str(result, 'summary_text'),
      blocks,
      partial,
    };
  } catch (err) {
    shape('parse-article-threw', err);
    return null;
  }
}
