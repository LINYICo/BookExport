# Changelog

## v0.4.5 - 2026-11-28

### Fixed

- Preserve chapter bodies in WeRead XHTML with external doctypes. Stop exports when a chapter with a positive word count has no usable content.
- Let the popup grow for long book titles and show red errors directly below the title.
- Replace the close button's blue focus ring with a neutral keyboard focus indicator.

### Changed

- Set the popup to 300 px wide and at least 280 px tall, with an 18 px wordmark and 14 px spacing.

## v0.4.4 - 2026-11-28

### Fixed

- Surface actionable export errors while keeping the download panel compact. Explain how to retry when WeRead returns no catalog.
- Keep HTML fallback parsing inert and retain document language, base URLs, and body attributes.
- Export valid zero-word and image-only chapters, retain section headings, and resolve shared chapter URLs by fragment.
- Release incompatible resource bytes promptly and retain usable CSS layers and font sources.

### Tests

- Verify parsing and redirects against a controlled HTTPS server in Chrome.
- Stress the resource budget with an incompatible response and add a two-tab benchmark.

## v0.4.3 - 2026-11-28

### Changed

- Use a bundled Teko wordmark in a narrower download panel.
- Show progress without chapter-count text and use in-place completion and retry states.
- Skip the final resource cooldown once every request has started.

## v0.4.2 - 2026-11-28

### Fixed

- Preserve the contents and language of HTML chapters when XHTML parsing fails.
- Preserve links to unavailable illustrations and retain working CSS image candidates.
- Include only referenced resources in the exported EPUB.

### Changed

- Build to `extension/` and replace the root `BookExport.zip` on each release.
- Consolidate project history in this changelog.
- Yield during large ZIP checksums and assemble large entries incrementally.

### Tests

- Exercise simultaneous tabs, Service Worker termination, packaging cancellation, and the full-book resource limit in Chrome.
- Add repeatable Chrome benchmarks for shared and large image resources.

## v0.4.1 - 2026-11-28

### Changed

- Download chapter resources in parallel through a bounded queue and reuse resources across chapters.
- Release chapter documents sooner and bound memory used by chapter text and downloaded resources.
- Preserve EPUB language, nested contents, internal links, SVG, and MathML.
- Report unavailable resources when handing the EPUB off to Chrome.

### Fixed

- Cancel pending and active work when a download is cancelled or the reader navigates.
- Normalize filenames and validate EPUB ZIP entries.

### Security

- Allow direct requests to approved resource hosts without credentials and reject redirects.
- Enforce response size limits and remove unsafe markup and styles.

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
