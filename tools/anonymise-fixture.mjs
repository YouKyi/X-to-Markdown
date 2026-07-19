// Replace every identity in a captured fixture with a synthetic one.
//
//   node tools/anonymise-fixture.mjs <pruned.json> <out.json>
//
// Real captures are the only thing proving our reading of X's schema matches
// what X actually sends - that is where all three parser bugs in this project's
// history were caught. Their value is entirely structural, and none of it comes
// from the content: nobody needs a stranger's post republished in a public
// repository to verify that `note_tweet` is preferred over a truncated
// `full_text`.
//
// So the structure is preserved to the byte and everything identifying is
// replaced. What must survive:
//
//   - JSON shape, key order, entry and item ids' internal structure
//   - Snowflake ordering, because assemble.ts sorts siblings by BigInt(id)
//   - line counts, list markers and length class of text, because the renderer's
//     escaping and hard-break rules key off them
//   - a display name containing a pipe and an emoji, because that is a
//     frontmatter test case
//   - promoted markers, `note_tweet` length, media URL shape

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Deterministic, so re-running produces an identical file. */
function makeRng(seed = 20260719) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const rng = makeRng();

const HANDLE_STEMS = [
  'ada', 'bo', 'cyd', 'dex', 'eli', 'fen', 'gus', 'hal', 'ivo', 'jun',
  'kit', 'lex', 'mo', 'nia', 'ola', 'pax', 'quin', 'rex', 'sol', 'tam',
  'uma', 'vik', 'wren', 'xan', 'yon', 'zev',
];
const NAME_FIRST = ['Alex', 'Robin', 'Sam', 'Jules', 'Charlie', 'Morgan', 'Noa', 'Kim'];
const NAME_LAST = ['Rivera', 'Novak', 'Sato', 'Dubois', 'Okafor', 'Lindqvist', 'Marek'];

const WORDS = (
  'note idea system tool export archive thread reply context memory search index ' +
  'connect capture write read parse render build ship draft signal pattern format ' +
  'structure record store query link graph value field entry item source result'
).split(' ');

// --- stable maps -------------------------------------------------------------

const handles = new Map();
const names = new Map();
const userIds = new Map();
const tweetIds = new Map();
const mediaKeys = new Map();
const tcoCodes = new Map();

/** Snowflake ids are remapped by a constant offset, which keeps their relative
 *  order - and therefore the sibling sort - exactly as captured. */
const ID_OFFSET = 400000000000000000n;

function mapTweetId(id) {
  if (!/^\d{5,}$/.test(id)) return id;
  if (!tweetIds.has(id)) tweetIds.set(id, (BigInt(id) + ID_OFFSET).toString());
  return tweetIds.get(id);
}

function mapUserId(id) {
  if (!/^\d+$/.test(id)) return id;
  if (!userIds.has(id)) userIds.set(id, String(100000 + userIds.size * 137));
  return userIds.get(id);
}

function mapHandle(handle) {
  if (!handles.has(handle)) {
    const n = handles.size;
    const stem = HANDLE_STEMS[n % HANDLE_STEMS.length];
    handles.set(handle, n < HANDLE_STEMS.length ? stem : `${stem}${Math.floor(n / HANDLE_STEMS.length)}`);
  }
  return handles.get(handle);
}

/** Preserves a pipe and an emoji when the original had them: both are
 *  frontmatter test cases, and losing them would quietly weaken the suite. */
function mapName(name, handle) {
  if (!names.has(name)) {
    const n = names.size;
    const first = NAME_FIRST[n % NAME_FIRST.length];
    const last = NAME_LAST[n % NAME_LAST.length];
    let out = `${first} ${last}`;
    if (name.includes('|')) out = `${first} | ${last} Field Notes`;
    const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u.exec(name);
    if (emoji) out += ` ${emoji[0]}`;
    names.set(name, out);
  }
  return names.get(name);
}

function mapMediaKey(key) {
  if (!mediaKeys.has(key)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < key.length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
    mediaKeys.set(key, out);
  }
  return mediaKeys.get(key);
}

function mapTco(code) {
  if (!tcoCodes.has(code)) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < code.length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
    tcoCodes.set(code, out);
  }
  return tcoCodes.get(code);
}

// --- text --------------------------------------------------------------------

function fillerOfLength(target) {
  if (target <= 0) return '';
  let out = '';
  while (out.length < target) {
    out += (out ? ' ' : '') + WORDS[Math.floor(rng() * WORDS.length)];
  }
  return out.slice(0, target).replace(/\s+$/, '');
}

/**
 * Rewrite prose, keeping the shape the renderer reacts to: one output line per
 * input line, list markers where the author had them, mentions still mentions,
 * t.co tokens still t.co tokens, and roughly the original length.
 */
function mapText(text) {
  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;

      const list = /^(\s*)([-*+]|\d{1,2}[.)])\s+/.exec(line);
      const prefix = list ? list[0] : '';
      const body = line.slice(prefix.length);

      const rebuilt = body
        .split(/(\s+)/)
        .map((token) => {
          if (/^\s+$/.test(token)) return token;
          const tco = /^https?:\/\/t\.co\/(\w+)/.exec(token);
          if (tco) return `https://t.co/${mapTco(tco[1])}`;
          if (/^https?:\/\//.test(token)) return 'https://example.com/link';
          if (/^@\w+/.test(token)) return `@${mapHandle(token.slice(1).replace(/\W+$/, ''))}`;
          if (/^#\w+/.test(token)) return '#topic';
          return null;
        })
        .map((mapped, i, all) => (mapped === null ? '' : mapped))
        .join('');

      // Length is preserved so note_tweet stays long enough to exercise the
      // long-form path, and short replies stay short.
      const keptLength = rebuilt.replace(/\s+/g, '').length;
      const filler = fillerOfLength(Math.max(0, body.length - keptLength - 1));
      const joined = [filler, rebuilt.trim()].filter(Boolean).join(' ');
      return prefix + (joined || fillerOfLength(body.length));
    })
    .join('\n');
}

// --- walk --------------------------------------------------------------------

const ID_KEYS = new Set([
  'rest_id', 'id_str', 'conversation_id_str', 'in_reply_to_status_id_str',
]);

function walk(node, keyHint = '') {
  if (Array.isArray(node)) return node.map((v) => walk(v, keyHint));
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  const isUser = node.__typename === 'User' || 'screen_name' in node;

  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (key === 'screen_name' || key === 'in_reply_to_screen_name') {
        out[key] = mapHandle(value);
      } else if (key === 'name') {
        out[key] = mapName(value, '');
      } else if (key === 'rest_id' && isUser) {
        out[key] = mapUserId(value);
      } else if (ID_KEYS.has(key)) {
        out[key] = mapTweetId(value);
      } else if (key === 'entryId' || key === 'moduleEntryId') {
        // Ids are embedded in entry ids; keep the surrounding structure intact.
        out[key] = value.replace(/\d{15,}/g, (m) => mapTweetId(m));
      } else if (key === 'full_text' || (key === 'text' && value.length > 20)) {
        out[key] = mapText(value);
      } else if (key === 'ext_alt_text') {
        out[key] = 'a synthetic illustration';
      } else if (key === 'media_url_https' || key === 'profile_image_url_https' || key === 'image_url') {
        out[key] = value.replace(/\/([A-Za-z0-9_-]{10,})(\.\w+)?$/, (m, k, ext) => `/${mapMediaKey(k)}${ext ?? ''}`);
      } else if (key === 'url' || key === 'expanded_url') {
        const tco = /t\.co\/(\w+)/.exec(value);
        out[key] = tco
          ? value.replace(tco[1], mapTco(tco[1]))
          : /^https?:/.test(value)
            ? 'https://example.com/link'
            : value;
      } else if (key === 'display_url') {
        // X's display form has no scheme (`news.example.xyz/?utm…`), so a
        // scheme test would let a real hostname straight through.
        out[key] = value.includes('t.co/')
          ? value.replace(/t\.co\/(\w+)/, (m, c) => `t.co/${mapTco(c)}`)
          : 'example.com/link';
      } else if (key === 'value' && /^[A-Za-z0-9+/=_-]{20,}$/.test(value)) {
        out[key] = 'SYNTHETIC-CURSOR-VALUE';
      } else {
        out[key] = value;
      }
      continue;
    }
    out[key] = walk(value, key);
  }
  return out;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/anonymise-fixture.mjs <pruned.json> <out.json>');
  process.exit(1);
}

const raw = JSON.parse(await readFile(input, 'utf8'));
await writeFile(output, JSON.stringify(walk(raw), null, 2) + '\n');

console.log(`${basename(output)}: ${handles.size} handles, ${tweetIds.size} tweet ids, ` +
  `${mediaKeys.size} media keys, ${tcoCodes.size} t.co codes replaced`);
