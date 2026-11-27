# BookExport

BookExport exports EPUB books you can read with your WeRead account. The downloaded file includes the chapters, a table of contents, and any illustrations the extension can retrieve.

## Installation and use

1. Open the extensions page in Chrome 110 or later, or in a version of Dia that supports Manifest V3. Enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension` directory.
2. Sign in to WeRead and open a book. Left-click the **BookExport** toolbar icon and click **Download EPUB**. The popup shows progress and lets you cancel. Reopen it at any time to check the download while the reader tab stays open.
3. Find the EPUB in your browser's downloads. If an illustration cannot be downloaded, the EPUB includes a placeholder. TXT-format web novels are currently unsupported.

The browser loads the extension directly from source. It uses your WeRead session to retrieve chapters, downloads illustrations through the extension's service worker, and packages the EPUB locally. Before exporting, make sure you have permission to save the book.

## Development environment

| Tool | Release channel |
| --- | --- |
| Node.js | Latest LTS (minimum supported version: 24) |
| pnpm | Latest (`pnpm@latest`) |

Run `pnpm test` to test the EPUB exporter. The project has no third-party npm dependencies. If you run `pnpm install`, pnpm will skip lockfile generation.

BookExport is derived from [WeRead Plus](https://github.com/EwenYoung/weread-plus) and is distributed under the [MIT license](LICENSE).
