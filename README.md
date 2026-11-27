# BookExport

BookExport is a browser extension that downloads WeRead books as EPUB files. It uses your existing WeRead session and packages chapters, a table of contents, and available illustrations locally.

## Install

1. Download the BookExport ZIP from GitHub Releases and extract it.
2. Open the extensions page in Chrome 110 or later, or in a version of Dia with Manifest V3 support.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.

When installing from a source checkout, select `chrome-extension/`.

## Download a book

1. Sign in to [WeRead](https://weread.qq.com/) and open a book you can read.
2. Click **BookExport** in the browser toolbar, then click **Download EPUB**.
3. Follow progress in the panel. You can close it and reopen it while the reader tab stays open.
4. Find the EPUB in your browser's downloads. Use **Cancel download** to stop an export in progress.

BookExport supports EPUB-format books. TXT-format web novels are unsupported. If an illustration fails to download, the EPUB includes a placeholder. Export only books you have permission to save.

## Development

Use the latest Node.js LTS (minimum 24) and the latest pnpm. The extension loads directly from source and has no third-party npm dependencies.

```sh
pnpm test
pnpm test:chrome
```

The Chrome smoke test uses a clean profile and a local WeRead fixture. Set `CHROME_BIN` if Chrome is installed at a custom path. GitHub Actions runs both test suites.

## License

[MIT](LICENSE)
