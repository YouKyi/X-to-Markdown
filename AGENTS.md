# Working on this codebase

A Firefox MV3 extension that exports x.com threads to Markdown by observing the
GraphQL responses the page already requested. [README.md](README.md) explains
what it does; this file covers what you would otherwise get wrong.

## Commands

```sh
pnpm check        # typecheck + tests + build + web-ext lint — the gate
pnpm test         # node:test, runs .ts directly (Node 24 type stripping)
pnpm dev          # web-ext run, throwaway Firefox
pnpm package      # build the .zip for AMO
```

`pnpm check` must be green before any commit. There is no CI shortcut around it —
the same command runs on GitLab.

## Measure, do not reason

**This is the rule that matters most here.** Every parser bug in this project's
history was found by capturing a payload and looking at it, after reasoning had
confidently pointed somewhere else:

- the like counter never parsed, because X writes "J'aime" with a typographic
  apostrophe (U+2019) and the pattern used the ASCII one
- "show more replies" answers were silently discarded, because they arrive as
  `TimelineAddToModule` with tweets under `moduleItems`, not `entries`
- ads were exported as replies, because they are items inside ordinary
  `conversationthread-*` entries — not the `promoted-*` entries twice guessed at

If something looks wrong with parsing, do not read the code harder. Turn on Debug
in the options, click the toolbar button, and inspect the JSON. Regexes in
particular: run them against real strings rather than reading them.

## Invariants

**The interceptor must never break x.com.** This ranks above capturing
correctly. `src/main-world/interceptor.ts` runs in the page's own realm: every
hook body is wrapped with a catch path that restores original behaviour, the
`fetch` patch returns the original promise synchronously without awaiting, body
reading happens on a detached `clone()` whose handlers swallow, and XHR uses an
added `load` listener rather than reassigning `onreadystatechange`. Do not
relax any of that.

**Capture registers first.** `src/content/index.ts` runs at `document_start` and
its ordering is load-bearing: the bridge listener is installed before anything
that can throw, because a payload arriving before we listen is gone and cannot be
retried. Everything touching the DOM waits for `document.body` — which does not
exist yet at `document_start` — and every UI call is wrapped, so a broken button
degrades to "no button" rather than a dead content script.

**One input contract.** `parse/tweet.ts` (GraphQL) and `parse/dom.ts` (fallback)
both produce exactly the `Tweet` shape in `types/model.ts`, and the renderer
accepts nothing else. `null` means unknown, never zero. `text` is never
Markdown-escaped by a parser — `render/escape.ts` is the only module that knows
about escaping.

**Nothing throws in `parse/`.** One malformed reply must not cost the other four
hundred. Failures degrade to a `partial` tweet or `null` and increment a counter.

**Be honest about gaps.** A partial result the reader knows about beats a
truncated one they believe is complete. `collection`, `replies_not_captured`,
`truncated` and `warnings` all exist for this. When adding a limit or a skip,
surface it — never drop content silently.

**One blockquote-depth function.** `render/markdown.ts` returns `string[]` from
every renderer and applies depth in exactly one place. A blank line inside a
blockquote must carry its `>` markers or the quote terminates. Do not concatenate
pre-formatted quoted strings anywhere else.

## Fixtures

`test/fixtures/real-*.json` are real captures and are the tests that matter —
they break first when X changes something. The synthetic ones pin edge cases the
real captures happen not to contain.

**Never commit an unpruned capture.** A raw payload carries
`relationship_perspectives` for every participant: whether the capturing user
follows, is followed by, blocks, mutes or can DM each of them. This repository is
public. Always run `tools/prune-fixture.mjs`, and verify:

```sh
grep -c relationship_perspectives test/fixtures/real-*.json   # must be 0
```

If the parser starts reading a field the pruner drops, add it to that allowlist
and **re-capture** — unpruned originals are deliberately not kept.

## Testing

`node:test` with no framework. Assertions are hand-written per case rather than
snapshots: a snapshot that "just changed" teaches nothing.

Two devDependencies exist for specific claims, and neither ships: `yaml`
round-trips the hand-rolled frontmatter emitter through a real parser (its
failure mode is silent corruption of someone's notes), and `linkedom` tests that
the auto-click filter can never land on a Follow button (its failure mode is a
real action on the user's account).

When a test and the code disagree, check which one is wrong. Several times here
the test's expectation was the defect — asserting `quiescence` where `cursor` was
equally correct, or asserting a YAML parser behaviour that YAML 1.2 does not
have.

## Browser work

**After any rebuild, reload the x.com page.** Firefox does not re-inject content
scripts into open tabs. The old instance is orphaned — its `browser.*` calls fail
— and retires itself after a couple of seconds, leaving no button until you
refresh. Two separate sessions were lost to diagnosing this.

The DOM-facing code (`content/ui.ts`, `parse/dom.ts`, the expansion clicker) is
the least stable part of the project and is verified by hand. Selectors prefer
semantic markup (`[role="group"]`) over `data-testid`, which X renames.

## Style

Match the surrounding code. Comments explain *why*, especially where a choice
looks arbitrary but is defending against something specific — most non-obvious
lines here already carry that reasoning, and it is the main thing keeping the
code auditable. Commit messages state the problem and the reasoning, not a
changelog of edits.
