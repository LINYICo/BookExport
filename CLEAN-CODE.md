# Coding guidelines

- Keep browser entry points small and keep WeRead protocol details in the client and protocol modules.
- Give each download one cancellation signal. Pass it to network requests, waits, image workers, and ZIP compression.
- Validate external data at its boundary. Preserve precise types after validation.
- Prefer native platform APIs and keep extension permissions scoped to the reader and image CDN.
- Keep the wire format stable. Test changes against the existing protocol fixtures.
- Keep build dependencies out of the extension. Run Oxfmt, Oxlint, strict TypeScript, Node tests, and the Chrome EPUBCheck workflow before release.
