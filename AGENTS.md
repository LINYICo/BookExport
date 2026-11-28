# BookExport

BookExport is a Manifest V3 extension that exports EPUB books from WeRead. Use English for UI text, comments, tests, documentation, and commit messages. Write commits as `type: description`.

- `src/background.ts` handles the toolbar action and cross-origin images.
- `src/content.ts` owns the reader tab and panel lifecycle. `src/export.ts` owns each download.
- `src/weread/` contains the WeRead client and protocol. Preserve the reference vectors and signed request behavior.
- `src/epub/` handles XHTML, metadata, and ZIP packaging. `src/ui/` contains the native download panel.
- `public/` holds the manifest and icons. Rolldown assembles the installable extension in `dist/extension/`.

Use the latest stable Node.js, pnpm, and Chromium. Keep strict TypeScript and zero third-party runtime dependencies. Check CDN host permissions when changing image sources. Follow [CLEAN-CODE.md](CLEAN-CODE.md) and run `pnpm check` before publishing.
