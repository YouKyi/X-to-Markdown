# X Thread to Markdown

A Firefox extension that exports an x.com thread — the post, the author's
self-thread, quoted tweets and the reply tree — to Markdown, in one click.

Built because handing an authenticated x.com session to a closed-source
extension is a bad trade. Everything runs locally, nothing is sent anywhere, and
the shipped bundle is unminified so you can read what you installed.
[SECURITY.md](SECURITY.md) documents the data flow and what each permission can
actually reach.

## Install

From [addons.mozilla.org](https://addons.mozilla.org). Requires Firefox 140 or
later.

## Use

On any `x.com/*/status/*` page, click **Markdown** in the post's action bar.

- **Click** — scroll the conversation to load the rest, then export.
- **Alt+click** — export what is already loaded, immediately.
- **Cancel** in the toast stops collecting and exports what was gathered.

Defaults to clipboard *and* a `.md` download. Change that in the extension's
options, along with the filename template, tags and collection limits.

## What you get

Below is `test/golden/simple-thread.md`, produced by the test suite — so this
example cannot drift away from the real output format.

````markdown
---
url: https://x.com/robin/status/20
tweet_id: "20"
conversation_id: "20"
author: Robin Novak
handle: "@robin"
author_url: https://x.com/robin
date: 2006-03-21
posted_at: "2006-03-21T20:50:14Z"
captured: "2026-07-19T14:03:11Z"
likes: 12345
retweets: 678
replies: 1
quotes: 12
views: 3400000
metrics_reliable: true
thread_length: 2
replies_captured: 1
source: graphql
collection: unknown
exporter: x-thread-md/0.1.0
tags:
  - tweet
  - x-export
---

# @robin — 2006-03-21

first note in the new system

![A desk with a laptop and a coffee mug](https://pbs.twimg.com/media/ABC123.jpg?format=jpg&name=orig)

[permalink](https://x.com/robin/status/20) · ♥ 12,345 · ↺ 678 · 💬 1 · 2006-03-21T20:50:14Z

---

follow-up: here's the writeup → [example.com/system-notes](https://example.com/system-notes)

[permalink](https://x.com/robin/status/21) · ♥ 402 · ↺ 31 · 2006-03-21T20:52:00Z

## Replies

> **[@alice](https://x.com/alice)** · [2006-03-21T21:00:00Z](https://x.com/alice/status/22)
>
> congrats — this is going to be big
>
> ♥ 3
````

Frontmatter is flat and typed, so Obsidian reads it as sortable properties rather
than plain text. Long-form posts come out in full, images at original resolution
with their alt text, and `t.co` links expanded to their real destination.

## Honesty about gaps

The principle throughout: **a partial result you know about beats a truncated one
you believe is complete.**

- `collection: complete | partial | unknown` — whether collecting reached the
  end. `unknown` is a real answer: after an Alt+click there was no collection
  pass, so the export genuinely cannot vouch for completeness.
- `replies_not_captured: N` — replies X's own counters say exist but that were
  never loaded. Reported rather than treated as failure, because it also covers
  deleted, hidden and muted replies no amount of scrolling would reach.
- `*… N more replies dropped by a collection limit*` — we had these and cut them.
  Distinct from `*… X reports N more replies here, not captured*`, which means we
  never got them.
- `warnings:` — orphaned replies, mixed sources, suspected schema drift.

Ads injected into conversations are dropped. They are not replies, and their own
reply counts would otherwise swamp these figures.

## How it works

It reads the GraphQL responses x.com's app requests for itself, rather than
scraping the rendered page or calling the API directly.

That choice is load-bearing. Query ids, bearer and CSRF tokens all rotate every
few weeks, so anything that originates requests breaks constantly. And the DOM
does not contain what you want: a long-form post is **truncated behind a "Show
more" control**, `t.co` links are never expanded, and engagement counts exist
only as localised, abbreviated `aria-label` text.

```
main-world/interceptor.ts   patches fetch + XHR in x.com's realm, forwards bodies
content/bridge.ts           receives them, treats every byte as untrusted
parse/                      GraphQL → a normalised Tweet, defensively
thread/assemble.ts          Tweet[] → a reply tree (pure, no DOM)
thread/paginate.ts          scrolls and expands to collect the rest
render/                     ThreadDoc → Markdown
```

A DOM scraper exists as a last resort. It produces the same `Tweet` shape so the
renderer keeps one input contract, and everything it emits is flagged
`source: dom` and `partial: true`, because it is worse in ways no effort can fix.

## Build

```sh
./build.sh
```

Requires **Node 24 or later** (the build and tests run `.ts` directly through
native type stripping) and pnpm 11, which corepack provides. Output lands in
`dist/`, which is the extension itself — the published archive is that directory
zipped, nothing added or removed. The build is deterministic: two runs produce
byte-identical output.

[BUILD.md](BUILD.md) has the full detail — environment requirements, how to
install Node and pnpm, what each step does, and how to verify a published
package against this source.

## Development

```sh
pnpm check        # typecheck + tests + build + web-ext lint — the gate
pnpm dev          # throwaway Firefox with the extension loaded
pnpm test         # node:test, no test framework dependency
pnpm package      # build the archive for submission
```

[AGENTS.md](AGENTS.md) covers the invariants and the traps. Read it before
changing anything under `src/`.

**After a rebuild, reload the x.com page.** Firefox does not re-inject content
scripts into already-open tabs; the old instance retires itself, leaving no
button until you refresh.

Tests run `.ts` directly — Node 24 strips types natively, so there is no test
framework and no transpile step. There are **zero runtime dependencies**: the
build and test tools never enter the package.

Fixtures are captured from live sessions and then anonymised, so the repository
contains nobody else's posts. See [test/fixtures](test/fixtures/README.md).

## Licence

[MIT](LICENSE).
