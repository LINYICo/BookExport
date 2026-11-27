# Greenflame

Greenflame is an EPUB export extension for WeRead. Use English for interface text, commit messages, comments, tests, and project documentation. Write commit messages in the form `type: description`.

Load `chrome-extension/` directly in a browser that supports Manifest V3. The reader entry point, `content.js`, uses `chrome.runtime.getURL` to load `lib/epub-export.js` dynamically. The export module receives browser dependencies through a factory. Its pure functions can run in Node.js. The service worker in `background.js` downloads cross-origin images. When changing image sources, check that the manifest's host permissions cover the CDN redirect chain.

Follow the coding guidelines in `CLEAN-CODE.md`. Run the EPUB export tests with `pnpm test`.
