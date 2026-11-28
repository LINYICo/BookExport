# Release history

## v0.4.0 - 2026-11-28

### Changed

- Build strict TypeScript with Rolldown and a reproducible pnpm lockfile.
- Use a native popover with system theme support and an accessible progress bar.
- Transfer image bytes directly, deduplicate images across chapters, and bound concurrent downloads.
- Package EPUBs as blobs with native compression and cancellation.

### Tests

- Check formatting, lint, and TypeScript in CI.
- Verify the built extension and validate the downloaded EPUB in Chrome.

## v0.3.0 - 2026-11-28

### Fixed

- Omit the creator field when WeRead provides no author.
- Time out stalled reader and chapter requests after 20 seconds and show how to retry the download.

### Tests

- Download a complete EPUB in Chrome and validate it with EPUBCheck in CI.
- Cover timeouts while waiting for the reader and while reading a chapter response.

## v0.2.0 - 2026-11-27

### Changed

- Open the download panel in the WeRead reader when the toolbar action is clicked.
- Keep downloads running when the panel closes. Reopen it to check progress or cancel.
- Show animated progress for chapter downloads and EPUB packaging. Remove the WeRead suffix from the displayed book title.

### Fixed

- Cancel in-flight reader and image requests and interrupt retry waits before restarting an export.

### Build and tests

- Run EPUB unit tests and a Chrome download smoke test in GitHub Actions.
- Publish an installable extension ZIP with the upstream MIT license.

## v0.1.0 - 2026-11-27

- Released BookExport as a WeRead EPUB download extension with no third-party npm dependencies.
- Added a toolbar download interface with chapter progress and cancellation.
