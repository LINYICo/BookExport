import { escapeXml, makeChapterXhtml } from './document.ts';
import { buildZip, type ZipEntry } from './zip.ts';

export interface EpubImage {
    href: string;
    mediaType: string;
    data: Uint8Array<ArrayBuffer>;
}
interface EpubChapter {
    title: string;
    source: string;
    assets?: EpubImage[];
}

function chapterFileName(index: number) {
    return 'text/chapter_' + String(index).padStart(4, '0') + '.xhtml';
}

// Each chapter contains a title, XHTML source, and optional image assets.
// Image references in the source already point to EPUB paths or have been replaced with placeholders.
export async function buildEpub({
    title,
    author,
    chapters,
    css,
    now,
    signal,
    assets = [],
}: {
    title: string;
    author?: string | undefined;
    chapters: EpubChapter[];
    css: string;
    now: number;
    signal?: AbortSignal;
    assets?: EpubImage[];
}) {
    const encoder = new TextEncoder();
    const text = (value: string) => encoder.encode(value);
    const bookUuid = 'urn:uuid:' + crypto.randomUUID();
    const modified = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const creator = String(author ?? '').trim();

    const navItems = chapters
        .map(
            (ch, i) =>
                '      <li><a href="' +
                chapterFileName(i + 1) +
                '">' +
                escapeXml(ch.title) +
                '</a></li>',
        )
        .join('\n');
    const nav =
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n' +
        '<head><meta charset="utf-8"/><title>Table of Contents</title></head>\n' +
        '<body>\n  <nav epub:type="toc" id="toc">\n    <h1>Table of Contents</h1>\n    <ol>\n' +
        navItems +
        '\n    </ol>\n  </nav>\n</body>\n</html>\n';

    const manifestChapters = chapters
        .map(
            (ch, i) =>
                '    <item id="chapter_' +
                String(i + 1).padStart(4, '0') +
                '" href="' +
                chapterFileName(i + 1) +
                '" media-type="application/xhtml+xml"/>',
        )
        .join('\n');

    const allAssets: EpubImage[] = [...assets];
    const seenHrefs = new Set(assets.map((asset) => asset.href));
    chapters.forEach((ch) =>
        (ch.assets || []).forEach((asset) => {
            if (!seenHrefs.has(asset.href)) {
                seenHrefs.add(asset.href);
                allAssets.push(asset);
            }
        }),
    );
    const manifestAssets = allAssets
        .map(
            (asset, i) =>
                '    <item id="asset_' +
                String(i + 1).padStart(4, '0') +
                '" href="' +
                escapeXml(asset.href) +
                '" media-type="' +
                escapeXml(asset.mediaType) +
                '"/>',
        )
        .join('\n');
    const spineChapters = chapters
        .map((ch, i) => '    <itemref idref="chapter_' + String(i + 1).padStart(4, '0') + '"/>')
        .join('\n');
    const opf =
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
        '    <dc:identifier id="bookid">' +
        escapeXml(bookUuid) +
        '</dc:identifier>\n' +
        '    <dc:title>' +
        escapeXml(title) +
        '</dc:title>\n' +
        (creator ? '    <dc:creator>' + escapeXml(creator) + '</dc:creator>\n' : '') +
        '    <dc:language>zh-CN</dc:language>\n' +
        '    <meta property="dcterms:modified">' +
        modified +
        '</meta>\n' +
        '  </metadata>\n' +
        '  <manifest>\n' +
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
        '    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
        '    <item id="style" href="styles/weread.css" media-type="text/css"/>\n' +
        manifestChapters +
        '\n' +
        (allAssets.length ? manifestAssets + '\n' : '') +
        '  </manifest>\n' +
        '  <spine toc="toc">\n' +
        spineChapters +
        '\n  </spine>\n' +
        '</package>\n';

    const ncxPoints = chapters
        .map(
            (ch, i) =>
                '    <navPoint id="navPoint-' +
                (i + 1) +
                '" playOrder="' +
                (i + 1) +
                '">\n' +
                '      <navLabel><text>' +
                escapeXml(ch.title) +
                '</text></navLabel>\n' +
                '      <content src="' +
                chapterFileName(i + 1) +
                '"/>\n' +
                '    </navPoint>',
        )
        .join('\n');

    const ncx =
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
        '  <head>\n' +
        '    <meta name="dtb:uid" content="' +
        escapeXml(bookUuid) +
        '"/>\n' +
        '    <meta name="dtb:depth" content="1"/>\n' +
        '    <meta name="dtb:totalPageCount" content="0"/>\n' +
        '    <meta name="dtb:maxPageNumber" content="0"/>\n' +
        '  </head>\n' +
        '  <docTitle><text>' +
        escapeXml(title) +
        '</text></docTitle>\n' +
        '  <navMap>\n' +
        ncxPoints +
        '\n  </navMap>\n' +
        '</ncx>\n';

    const container =
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
        '  <rootfiles>\n' +
        '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
        '  </rootfiles>\n' +
        '</container>\n';

    const entries: ZipEntry[] = [
        { name: 'mimetype', data: text('application/epub+zip'), compress: false },
        { name: 'META-INF/container.xml', data: text(container) },
        { name: 'OEBPS/content.opf', data: text(opf) },
        { name: 'OEBPS/toc.ncx', data: text(ncx) },
        { name: 'OEBPS/nav.xhtml', data: text(nav) },
        { name: 'OEBPS/styles/weread.css', data: text(css || 'body { line-height: 1.6; }\n') },
    ];
    allAssets.forEach((asset) => {
        // Store compressed images directly in the ZIP archive.
        entries.push({ name: 'OEBPS/' + asset.href, data: asset.data, compress: false });
    });
    chapters.forEach((ch, i) => {
        entries.push({
            name: 'OEBPS/' + chapterFileName(i + 1),
            data: text(makeChapterXhtml(ch.title, ch.source)),
        });
    });
    const archive = await buildZip(entries, now, signal);
    return archive;
}

export function sanitizeFilename(name: unknown) {
    return (
        String(name)
            .replace(/[\\/:*?"<>|]/g, '')
            .trim() || 'bookexport'
    );
}
