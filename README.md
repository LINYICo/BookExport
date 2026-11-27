# Greenflame

Greenflame exports EPUB books you can read with your WeRead account. The downloaded file includes the chapters, a table of contents, and any illustrations the extension can retrieve.

## Installation and use

1. Install Node.js 24 or later and the pnpm version specified in `package.json`. Run `pnpm install --frozen-lockfile` in the project directory.
2. Open the extensions page in Chrome 110 or later, or in a version of Dia that supports Manifest V3. Enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension` directory.
3. Sign in to WeRead and open a book. Click **Export book** in the lower-right corner of the reader. The button shows progress. Click it again to cancel.
4. Find the EPUB in your browser's downloads. If an illustration cannot be downloaded, the EPUB includes a placeholder. TXT-format web novels are currently unsupported.

The browser loads the extension directly from source. It uses your WeRead session to retrieve chapters, downloads illustrations through the extension's service worker, and packages the EPUB locally. Before exporting, make sure you have permission to save the book.

Run `pnpm test` to test the EPUB exporter.

Greenflame is derived from [WeRead Plus](https://github.com/EwenYoung/weread-plus) and is distributed under the [MIT license](LICENSE).
