# Fixtures

Each fixture pins one specific parser behaviour.

## Two kinds, on purpose

`real-*.json` were **captured from live sessions and then anonymised**. They are
the ones that matter: they prove our reading of X's schema matches what X
actually sends, and `test/real.test.ts` is the first thing to break when X
changes something.

Anonymised means handles, display names, user and tweet ids, post text, media
keys and t.co codes are all synthetic, while the JSON structure is preserved to
the byte — including Snowflake ordering, line counts and list markers in text,
`note_tweet` length, promoted markers, and a display name carrying a pipe and an
emoji because that is a frontmatter test case. The structure is the entire value
of these files. Nobody needs a stranger's post republished in a public
repository to verify that `note_tweet` is preferred over a truncated
`full_text`.

The rest are **hand-built from the documented schema**, pinning edge cases the
real captures happen not to contain: visibility wrappers, tombstones, the 2025+
`core.*` author shape, video variant selection, quote-of-a-quote. They verify
internal consistency, not schema truth.

## Capturing a new one

1. Turn on **Debug** in the extension options.
2. Browse to a thread on x.com and let it load.
3. Click the toolbar button. The last few raw GraphQL payloads download as JSON.
4. `node tools/prune-fixture.mjs <downloaded.json> <pruned.json>`
5. `node tools/anonymise-fixture.mjs <pruned.json> test/fixtures/<name>.json`
6. Record what it pins in the table below.

**Both steps are mandatory. No unpruned or un-anonymised file is ever
committed.**

Pruning is about *you*. A raw `TweetDetail` response carries
`relationship_perspectives` for every participant — whether you follow, are
followed by, block, mute or can DM each of them — plus other session state. None
of it is parser input.

Anonymising is about *everyone else*. This repository is public, and the people
in a captured thread did not ask to be in it.

Verify before committing:

```sh
grep -c relationship_perspectives test/fixtures/real-*.json   # must be 0
```

and read the diff. Fixtures are 5–40 KB precisely so that reading them is
realistic.

If the parser starts reading a field the pruner drops, add it to that allowlist
and re-capture. Unpruned originals are deliberately never kept.

## Inventory

| File | Origin | Pins |
|---|---|---|
| `real-tweetdetail.json` | captured, anonymised | 25 tweets, a two-tweet self-thread, eight reply chains two levels deep, a 4200-character `note_tweet`, one photo, `views.count` delivered as a string |
| `real-big-thread.json` | captured, anonymised | Busy thread: promoted content as items inside ordinary `conversationthread-*` entries, deep reply chains, quoted tweets, a GIF. The only fixture exercising ad filtering — a test asserts it still contains ads, so it cannot start passing for the wrong reason |
| `addtomodule.json` | synthetic | `TimelineAddToModule` — what a "show more replies" click returns; tweets under `moduleItems`, not `entries` |
| `promoted.json` | synthetic | An ad as a top-level `promoted-*` entry, a shape X also uses |
| `tweetdetail-simple.json` | synthetic | Entry walking (`tweet-*`, `conversationthread-*`, `cursor-*`), legacy user shape, photo media, media t.co stripping, `display_text_range` |
| `tweetdetail-longform.json` | synthetic | `note_tweet` preferred over truncated `full_text`, the note's own `entity_set` |
| `tweetdetail-visibility.json` | synthetic | `TweetWithVisibilityResults` unwrap, tombstone skipping |
| `user-core-shape.json` | synthetic | 2025+ author fields under `core.user_results.result.core` |
| `media-video.json` | synthetic | Highest-bitrate mp4 selection, HLS variant rejection, `animated_gif`, alt text |
| `quoted-nested.json` | synthetic | Recursive `quoted_status_result`, quote-of-a-quote |
