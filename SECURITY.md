# Security

This extension exists because trusting a third party with an authenticated
x.com session is a bad trade. That reasoning only holds if this one is
auditable, so this document states exactly what it does, what it can reach, and
where the sharp edges are.

## Data flow

There is one, and it ends on your disk.

```
x.com  ──(responses X's own app requested)──▶  MAIN-world hook
                                                    │ window.postMessage
                                                    ▼
                                            content script (ISOLATED)
                                                    │
                                          parse → assemble → render
                                                    │
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                              clipboard                   background page
                                                                    │
                                                          downloads.download
                                                                    ▼
                                                            your Downloads
```

**No network requests are made by this extension.** Not to x.com, not anywhere.
It reads responses the page had already requested for itself. There is no
telemetry, no error reporting, no update ping beyond Firefox's own check against
the `update_url` you configure. `manifest.json` declares
`data_collection_permissions: { required: ["none"] }`.

You can verify the absence of outbound traffic yourself: the string `fetch(` and
`XMLHttpRequest` appear in `src/main-world/interceptor.ts` only as *patches over
the page's own functions*, never as calls. Nothing else in `src/` performs I/O.

## What it can reach

| Permission | Why | Blast radius |
|---|---|---|
| `host_permissions: https://x.com/*, https://twitter.com/*` | Inject the interceptor and the button | Full read access to those pages, including your session's content. Same as any x.com extension. |
| `downloads` | Write the `.md` file | Can write files to your Downloads directory. Filenames are sanitised (`src/render/filename.ts`): no absolute paths, no `..`, no path separators. |
| `clipboardWrite` | Copy without a user gesture | Required because auto-scrolling outlives the click's transient activation. Write-only; the extension never *reads* your clipboard. |
| `storage` | Settings | `storage.sync`, settings only. No captured content is ever persisted. |

Not requested, deliberately: `activeTab` (adds nothing over `host_permissions`),
`scripting` (everything is manifest-declared, nothing is injected dynamically),
`tabs` beyond messaging, and any host outside x.com.

## Where captured data lives

In memory, in the content script, for the lifetime of the page. It is dropped on
navigation (`store.reset()`) and on reload. Nothing is written to
`storage.local`, IndexedDB, or disk except the file you asked for.

The one exception is **Debug mode**, which retains the last five raw GraphQL
payloads in memory so they can be dumped as a fixture. Those payloads contain
your `viewer_results` and other session-adjacent state. If you dump one, prune
it with `tools/prune-fixture.mjs` before sharing it — that tool exists precisely
to strip everything the parser does not read.

## The MAIN-world script

`src/main-world/interceptor.ts` runs in x.com's own JavaScript realm, which is
the part worth understanding.

**It grants the page nothing it did not already have.** Everything it observes is
a response x.com requested for itself and already holds. The hook adds an
observer, not a capability.

**It must never break x.com.** That invariant ranks above capturing correctly:

- every hook body is wrapped, and the catch path leaves original behaviour intact
- the `fetch` patch returns the original promise synchronously and never awaits
- body reading happens on a detached `clone()` whose handlers all swallow, so a
  capture failure cannot surface as an unhandled rejection in the page
- XHR uses an added `load` listener, never `onreadystatechange`, which X may
  reassign
- per-request state lives in a `WeakMap`, so nothing observable is added to the
  page's objects

## The bridge trust model

MAIN → ISOLATED messages are validated on `event.source`, `event.origin` and an
envelope tag. **These checks are anti-confusion, not anti-attack.** A hostile
script already running on x.com could forge the envelope — but it is already on
x.com and already has this data, so nothing is gained by forging it.

The real requirement is that the ISOLATED side treats every bridged byte as
untrusted input:

- no `eval`, no `Function`, no remote code (also forbidden by the CSP)
- no `innerHTML` anywhere; the UI is built with `createElement` and `textContent`
- `JSON.parse` only inside `try/catch`
- all field access through `src/parse/accessors.ts`, which never throws and never
  merges into prototypes
- the ISOLATED side never posts back into the page

## The one thing that clicks on your behalf

Auto-scroll opens folded "show more replies" controls. X renders those rows and
"who to follow" modules with the same container, and the latter contain **Follow
buttons** — so a careless auto-click takes a real action on your account.

The filter is structural, not label-based (a label match would also simply fail
on a non-English UI). A control is clicked only when its cell contains no
article, no image, no user-cell or follow testid, and exactly one clickable, with
a multilingual forbidden-word list as a backstop. This is tested against real DOM
in `test/paginate.test.ts` rather than asserted in a comment.

Turn it off entirely with **Options → Collecting replies**.

## Reviewing a release

The shipped bundle is **not minified**, on purpose. Unzip a signed `.xpi` and the
JavaScript maps line-for-line onto this repository. There are **zero runtime
dependencies** — `esbuild`, `typescript`, `web-ext`, `yaml` and `linkedom` are
build- and test-time only, and none of them enter the package.

```sh
unzip -o x_thread_md-0.1.0.xpi -d /tmp/xpi && ls /tmp/xpi
pnpm build && diff -r dist /tmp/xpi   # modulo Mozilla's added signature
```

## Reporting

This is a personal tool with no support commitment. If you find something that
matters, open an issue on whatever remote this ends up on.
