import { chapterFileName, escapeXml, languageTag, makeChapterXhtml } from './document.ts';
import { buildZip, type ZipEntry } from './zip.ts';

export interface EpubAsset {
    href: string;
    mediaType: string;
    data: Uint8Array<ArrayBuffer>;
}

export interface EpubChapter {
    title: string;
    source: string;
    properties?: readonly ('svg' | 'mathml')[];
    embeddedCss?: string;
    language?: string;
    attributes?: Record<string, string>;
    hasHeading?: boolean;
    parent?: number;
    sections?: readonly { id: number; title: string }[];
}

function chapterTree(chapters: EpubChapter[]) {
    interface Node {
        index?: number;
        section?: number;
        title: string;
        children: Node[];
    }
    const roots: Node[] = [];
    const ancestors: Node[] = [];
    let maxDepth = 1;
    for (const [index, chapter] of chapters.entries()) {
        const depth = ancestors.findLastIndex((node) => node.index === chapter.parent);
        ancestors.length = depth + 1;
        let siblings = ancestors.at(-1)?.children ?? roots;
        // Group headings remain in the EPUB 3 navigation without pointing at imaginary content.
        for (const { id, title } of chapter.sections?.slice(0, 64 - ancestors.length) ?? []) {
            let section = siblings.at(-1);
            if (section?.section !== id) {
                section = { section: id, title, children: [] };
                siblings.push(section);
            }
            siblings = section.children;
        }
        const node = { index, title: chapter.title, children: [] };
        siblings.push(node);
        maxDepth = Math.max(maxDepth, ancestors.length + 1);
        if (ancestors.length < 64) ancestors.push(node);
    }
    function nav(nodes: Node[]): string {
        return (
            '<ol>' +
            nodes
                .map(({ index, title, children }) => {
                    const label = escapeXml(title);
                    const destination =
                        index === undefined
                            ? '<span>' + label + '</span>'
                            : '<a href="' + chapterFileName(index + 1) + '">' + label + '</a>';
                    return '<li>' + destination + (children.length ? nav(children) : '') + '</li>';
                })
                .join('\n') +
            '</ol>'
        );
    }
    function ncx(nodes: Node[]): string {
        return nodes
            .map(({ index, title, children }) =>
                index === undefined
                    ? ncx(children)
                    : '<navPoint id="navPoint-' +
                      (index + 1) +
                      '" playOrder="' +
                      (index + 1) +
                      '">' +
                      '<navLabel><text>' +
                      escapeXml(title) +
                      '</text></navLabel>' +
                      '<content src="' +
                      chapterFileName(index + 1) +
                      '"/>' +
                      ncx(children) +
                      '</navPoint>',
            )
            .join('\n');
    }
    return { nav: nav(roots), ncx: ncx(roots), maxDepth };
}

export async function buildEpub({
    title,
    author,
    language,
    chapters,
    css,
    now,
    signal,
    assets = [],
}: {
    title: string;
    author?: string | undefined;
    language?: string;
    chapters: EpubChapter[];
    css: string;
    now: number;
    signal?: AbortSignal;
    assets?: EpubAsset[];
}) {
    const encoder = new TextEncoder();
    const bookUuid = 'urn:uuid:' + crypto.randomUUID();
    const modified = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const creator = String(author ?? '').trim();
    const lang = languageTag(language) ?? 'und';
    const toc = chapterTree(chapters);
    const xml = '<?xml version="1.0" encoding="utf-8"?>';
    const nav = `${xml}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8"/><title>Table of Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Table of Contents</h1>${toc.nav}</nav></body>
</html>`;
    const chapterItems = chapters
        .map((chapter, i) => {
            const properties = chapter.properties?.length
                ? ` properties="${chapter.properties.join(' ')}"`
                : '';
            return `<item id="chapter_${i + 1}" href="${chapterFileName(i + 1)}" media-type="application/xhtml+xml"${properties}/>`;
        })
        .join('\n');
    const assetItems = Array.from(
        assets,
        (asset, i) =>
            `<item id="asset_${i + 1}" href="${escapeXml(asset.href)}" media-type="${escapeXml(asset.mediaType)}"/>`,
    ).join('\n');
    const spine = chapters.map((_, i) => `<itemref idref="chapter_${i + 1}"/>`).join('\n');
    const opf = `${xml}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${bookUuid}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
${creator ? `<dc:creator>${escapeXml(creator)}</dc:creator>` : ''}
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="styles/weread.css" media-type="text/css"/>
${chapterItems}
${assetItems}
</manifest>
<spine toc="toc">${spine}</spine>
</package>`;
    const ncx = `${xml}
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${bookUuid}"/>
<meta name="dtb:depth" content="${toc.maxDepth}"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>${toc.ncx}</navMap>
</ncx>`;
    const container = `${xml}
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
    function* entries(): Iterable<ZipEntry> {
        yield { name: 'mimetype', data: encoder.encode('application/epub+zip'), compress: false };
        yield { name: 'META-INF/container.xml', data: encoder.encode(container) };
        yield { name: 'OEBPS/content.opf', data: encoder.encode(opf) };
        yield { name: 'OEBPS/toc.ncx', data: encoder.encode(ncx) };
        yield { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) };
        yield {
            name: 'OEBPS/styles/weread.css',
            data: encoder.encode(css || 'body { line-height: 1.6; }\n'),
        };
        for (const { href, data } of assets) yield { name: 'OEBPS/' + href, data, compress: false };
        for (const [i, chapter] of chapters.entries()) {
            signal?.throwIfAborted();
            const source = makeChapterXhtml(chapter.title, chapter.source, chapter.embeddedCss, {
                language: chapter.language ?? lang,
                ...(chapter.attributes ? { attributes: chapter.attributes } : {}),
                ...(chapter.hasHeading !== undefined ? { hasHeading: chapter.hasHeading } : {}),
            });
            yield { name: 'OEBPS/' + chapterFileName(i + 1), data: encoder.encode(source) };
        }
    }
    return buildZip(entries(), now, signal);
}

export function sanitizeFilename(name: unknown) {
    const normalized = String(name)
        .replace(/[\p{Cc}\\/:*?"<>|]/gu, '')
        .trim()
        .replace(/[. ]+$/, '')
        .replace(/(?:\.epub)+$/i, '')
        .replace(/[. ]+$/, '');
    const safe = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?= *(?:\.|$))/i.test(normalized)
        ? '_' + normalized
        : normalized;
    const encoder = new TextEncoder();
    const bytes = new Uint8Array(250);
    const { read } = encoder.encodeInto(safe, bytes);
    return safe.slice(0, read).replace(/[. ]+$/, '') || 'bookexport';
}
