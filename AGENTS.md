# BookExport

BookExport is a Manifest V3 extension that exports EPUB books from WeRead. Use English for UI text, comments, tests, documentation, and commit messages. Write commits as `type: description`.

- `src/background.ts` handles the toolbar action and cross-origin resources.
- `src/content.ts` owns the reader tab and panel lifecycle. `src/export.ts` owns each download.
- `src/assets.ts` manages the per-export resource queue. `src/resource.ts` owns resource formats, URL validation, and response policy.
- `src/io.ts` provides cancellable I/O primitives. `src/text.ts` provides shared text and language normalization.
- `src/weread/` contains the WeRead client and protocol. Preserve the reference vectors and signed request behavior.
- `src/epub/` handles XHTML, CSS resource rewriting, metadata, and ZIP packaging. `src/ui/` contains the native download panel.
- `public/` holds the manifest and icons. Rolldown assembles the installable extension in `extension/`.

Use the latest stable Node.js, pnpm, and Chromium. Keep strict TypeScript and zero third-party runtime dependencies. Check CDN host permissions when changing resource sources. Follow [CLEAN-CODE.md](CLEAN-CODE.md) and run `pnpm check` before publishing.
