# Release history

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

**Full changelog** · [v0.1.0…v0.2.0](https://github.com/LINYICo/BookExport/compare/v0.1.0...v0.2.0)

## v0.1.0 - 2026-11-27

- Released BookExport as a WeRead EPUB download extension with no third-party npm dependencies.
- Added a toolbar download interface with chapter progress and cancellation.
