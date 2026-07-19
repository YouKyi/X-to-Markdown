# Build instructions

For AMO reviewers, and for anyone verifying that a published package matches
this source.

## Requirements

- **Node 24 or later** — not optional. `build.mjs` and the test suite run `.ts`
  files directly through Node's native type stripping, which earlier versions do
  not have.
- **pnpm 11** — `corepack enable && corepack prepare pnpm@11.11.0 --activate`

Tested on macOS 15 and on `node:24-alpine`.

## Build

```sh
pnpm install --frozen-lockfile
pnpm build
```

Output appears in `dist/`. That directory *is* the extension: the submitted
archive is `dist/` zipped by `web-ext build`, with nothing added or removed.

To rebuild the archive itself:

```sh
pnpm package        # → artifacts/x_thread_markdown-<version>.zip
```

## Verifying against a published package

```sh
unzip -o x_thread_markdown-0.1.0.zip -d /tmp/published
pnpm install --frozen-lockfile && pnpm build
diff -r dist /tmp/published
```

This should report no differences. The build is deterministic — running it twice
produces byte-identical output — and the version string is the only value
injected, taken from `package.json`.

## What the build does

`build.mjs` runs esbuild over four entry points and copies three static files.
There is no code generation, no template engine, and **no minification**:

| Entry point | Output |
|---|---|
| `src/main-world/interceptor.ts` | `dist/main-world.js` |
| `src/content/index.ts` | `dist/content.js` |
| `src/background/index.ts` | `dist/background.js` |
| `src/options/options.ts` | `dist/options/options.js` |

esbuild is used only to strip TypeScript types and bundle the module graph into
one file per entry point. Output is `iife`, targeted at `firefox140`, with
`minify: false` and `legalComments: 'inline'`, so the shipped JavaScript reads
as ordinary source and maps onto the files under `src/`.

`src/manifest.json` is copied with `version` substituted from `package.json` so
there is a single source of truth for the version number. `src/icons/` and
`src/options/options.html` are copied unchanged.

`src/content/ui.css` is imported as a text string (esbuild's `text` loader) and
injected into a shadow root, which is why no CSS file ships and the extension
declares no `web_accessible_resources`.

## Dependencies

**There are no runtime dependencies.** `package.json` has an empty
`dependencies` field, and nothing third-party is bundled into `dist/`. Every
declared package is build- or test-time only:

| Package | Used for |
|---|---|
| `esbuild` | bundling, at build time |
| `typescript` | `tsc --noEmit` only; it emits nothing |
| `@types/node` | types for the test and tooling configs |
| `web-ext` | packaging, linting and signing |
| `yaml` | tests only — round-trips the hand-written frontmatter emitter through a real parser |
| `linkedom` | tests only — a DOM for the fallback scraper and the auto-click filter |

## Tests

```sh
pnpm check     # typecheck + tests + build + web-ext lint
```

227 tests, no browser required. `pnpm check` is the gate that must pass before
any release, and it is what CI runs.
