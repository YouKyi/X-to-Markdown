// Prune a captured GraphQL payload down to the fields the parser actually reads.
//
//   node tools/prune-fixture.mjs <captured-dump.json> [outfile.json] [--index N]
//
// Two reasons this exists, both important:
//
//   Privacy. A raw TweetDetail response carries relationship_perspectives for
//   every participant — whether *you* follow, are followed by, block, mute or
//   can DM each of them — plus other session-adjacent state. None of it is
//   parser input, and none of it belongs in a public repository.
//
//   Reviewability. Raw responses are 1–5 MB. Pruned ones are 5–40 KB and can be
//   read in a diff, which is the only way a fixture change is ever meaningfully
//   reviewed.
//
// The allowlist below is the contract: if the parser starts reading a new field,
// add it here and re-capture. Unpruned payloads are deliberately never kept.

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Keys kept wherever they appear. Everything else is dropped. */
const KEEP = new Set([
  // envelope
  'data', 'threaded_conversation_with_injections_v2', 'instructions', 'type', 'entries',
  'entryId', 'content', 'entryType', 'displayType', 'itemContent', 'itemType', 'items',
  'item', 'tweet_results', 'result', 'value', 'cursorType',
  'tweetResult', 'tweetResults', 'user', 'timeline', 'timeline_v2',
  // a "show more replies" answer arrives as moduleItems, not entries
  'moduleItems', 'moduleEntryId', 'entry',
  // promoted content markers: without these a fixture cannot exercise ad filtering
  'promotedMetadata', 'promoted_metadata', 'disclosureType', 'advertiser_results',
  'bookmark_timeline_v2', 'search_by_raw_query', 'search_timeline', 'home', 'home_timeline_urt',

  // tweet
  '__typename', 'rest_id', 'tweet', 'legacy', 'note_tweet', 'note_tweet_results',
  'quoted_status_result', 'views', 'count', 'tombstone',
  'created_at', 'conversation_id_str', 'in_reply_to_status_id_str', 'in_reply_to_screen_name',
  'full_text', 'display_text_range', 'lang', 'is_quote_status', 'id_str',
  'favorite_count', 'retweet_count', 'reply_count', 'quote_count', 'bookmark_count',

  // entities
  'entities', 'extended_entities', 'entity_set', 'urls', 'url', 'expanded_url', 'display_url',
  'hashtags', 'user_mentions', 'text',

  // media
  'media', 'media_url_https', 'ext_alt_text', 'original_info', 'width', 'height',
  'video_info', 'duration_millis', 'variants', 'bitrate', 'content_type',

  // author — both schema eras
  'core', 'user_results', 'screen_name', 'name', 'is_blue_verified', 'verified',
  'avatar', 'image_url', 'profile_image_url_https',
]);

function prune(node) {
  if (Array.isArray(node)) return node.map(prune);
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEEP.has(key)) continue;
    out[key] = prune(value);
  }
  return out;
}

const [input, output, ...rest] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/prune-fixture.mjs <captured-dump.json> [out.json] [--index N]');
  process.exit(1);
}

const indexFlag = rest.indexOf('--index');
const wanted = indexFlag === -1 ? null : Number(rest[indexFlag + 1]);

const raw = JSON.parse(await readFile(input, 'utf8'));

// Accept either the extension's dump wrapper or a bare payload.
const payloads = Array.isArray(raw?.payloads)
  ? raw.payloads.map((p) => ({ url: p.url, json: p.json }))
  : [{ url: input, json: raw }];

const conversations = payloads.filter((p) => {
  const json = JSON.stringify(p.json);
  return json.includes('threaded_conversation_with_injections_v2') || json.includes('tweet_results');
});

if (conversations.length === 0) {
  console.error(`no tweet-bearing payload found in ${basename(input)}`);
  console.error(`  ${payloads.length} payload(s) present; capture again with a thread open`);
  process.exit(2);
}

if (wanted === null && conversations.length > 1) {
  console.error(`${conversations.length} tweet-bearing payloads; pick one with --index:`);
  conversations.forEach((p, i) => {
    const size = JSON.stringify(p.json).length;
    console.error(`  [${i}] ${(size / 1024).toFixed(0)} KB  ${p.url}`);
  });
  process.exit(3);
}

const chosen = conversations[wanted ?? 0];
if (!chosen) {
  console.error(`--index ${wanted} is out of range (0..${conversations.length - 1})`);
  process.exit(4);
}

const pruned = prune(chosen.json);
const text = JSON.stringify(pruned, null, 2) + '\n';
const before = JSON.stringify(chosen.json).length;

if (output) {
  await writeFile(output, text);
  console.log(
    `${basename(output)}: ${(before / 1024).toFixed(0)} KB -> ${(text.length / 1024).toFixed(0)} KB`,
  );
  console.log(`source: ${chosen.url}`);
  console.log('Record the source URL and capture date in test/fixtures/README.md.');
} else {
  process.stdout.write(text);
}
