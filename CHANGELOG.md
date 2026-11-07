# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dependency bumps are managed by [Renovate](https://docs.renovatebot.com/) and
listed by CI in the Dependencies section of each release, one line per
dependency at its latest version.

## [Unreleased]

### Fixed

- CI installs pnpm through npm: corepack no longer ships with Node 25 and later.

### Security

- AMO credentials reach only the `sign` job (environment `amo`), no longer every
  job of protected refs.

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
