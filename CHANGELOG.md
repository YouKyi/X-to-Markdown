# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dependency bumps are managed by [Renovate](https://docs.renovatebot.com/) and
listed by CI in the Dependencies section of each release, one line per
dependency at its latest version.

## [Unreleased]

## [0.3.1] - 2026-11-07

### Fixed

- CI installs pnpm through npm: corepack no longer ships with Node 25 and later.

### Security

- AMO credentials reach only the `sign` job (environment `amo`), no longer every
  job of protected refs.

### Dependencies

- [@types/node to v26.6.6](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/f5df482d) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/50))
- [esbuild to v0.28.2](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/37c9b4c8) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/9))
- [linkedom to v0.18.15](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/49203462) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/52))
- [lock file maintenance](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/0d139c32) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/51))
- [node.js to 8996bb5](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/71d18bb0) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/58))
- [web-ext to v10.8.0](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/939ab5d9) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/38))
- [yaml to v2.9.1](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/afa4791e) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/19))
- [youkyi-hq/platform/ci/ci-catalog to v4](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/2efa6027) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/60))
- [youkyi-infra/ci-infrastructure/ci-catalog to v3](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/commit/b61e4a1d) ([merge request](https://gitlab.int.youkyi.net/youkyi-hq/labs/x-to-markdown/-/merge_requests/44))

## [0.3.0] - 2026-07-25

### Added

- X Articles exported as the article, not as the link to it.

### Fixed

- @mentions linked in an article body.
- Debug payloads evicted by content; ads no longer flagged as drift.

## [0.2.1] - 2026-07-25

### Fixed

- CI installs git before the check job.

## [0.2.0] - 2026-07-25

First release: X thread to Markdown, a Firefox extension.

### Added

- Export of the author's thread alone, without replies.
- Collapsed reply branches reported; timeline roots found by shape.

### Fixed

- A capture is no longer destroyed on SPA navigation.
- A collapsed branch marks the capture as incomplete.
- The drift signal is not spent on timelines that are not conversations.
- Fixed-position UI moved onto a body-level host; the options menu is no longer
  clipped by the tweet action bar.
- Known shapes no longer reported as unrecognised.
