# BookExport

BookExport downloads WeRead books as EPUB files with chapters, a table of contents, and available illustrations. It uses your signed-in WeRead session and packages files locally.

## Install

1. Download and extract the BookExport ZIP from [GitHub Releases](https://github.com/LINYICo/BookExport/releases).
2. In the latest stable Chrome, open **Extensions**, enable **Developer mode**, and choose **Load unpacked**.
3. Select the extracted folder containing `manifest.json`.

## Download a book

Sign in to WeRead, open a book, and click **BookExport** in the toolbar. Select **Download EPUB**. You can close the panel and reopen it to check progress or cancel. Keep the reader tab open until the EPUB is sent to the browser's downloads.

BookExport supports EPUB-format books. It reports unavailable resources and shows placeholders for missing images. It downloads resources directly from supported WeRead and CDN hosts and skips redirects. Export only books you have permission to save.

## Development

- **Latest stable** Chrome, Node.js Current, pnpm, OpenJDK GA, and EPUBCheck
- **Latest** TypeScript, Rolldown, Oxlint, and Oxfmt
- Native Manifest V3 and Web APIs, ESNext, and EPUB 3

```sh
pnpm install
pnpm dev
pnpm build
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:chrome
pnpm check
pnpm release
```

Load `extension/` to test the build. Watch mode rebuilds source and copies changes to the manifest and icons. Unit and Chrome tests validate the EPUB files they produce with EPUBCheck. The Chrome test uses a temporary profile, synthetic reader responses, and an OpenSSL-backed local HTTPS server to exercise real resource requests. Packaging uses `zip` and `unzip`. Set `CHROME_BIN` or `EPUBCHECK_BIN` to override their executable paths. Use [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) in an isolated stable Chrome profile for interactive debugging.

Run `pnpm test:chrome --stress` to verify the full-book resource budget. Run `pnpm benchmark` for the shared-image benchmark or `pnpm benchmark --stress` for the large-image sample. Set `BOOKEXPORT_EXTENSION` to an extracted release directory to compare builds with the same fixtures. The benchmark samples page JavaScript heap and sums Chrome process RSS, which can count shared memory more than once.

Run `pnpm check` before publishing. Run `pnpm release` to build the extension and replace `BookExport.zip` in the project root. Update the version in `package.json` and record changes in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
