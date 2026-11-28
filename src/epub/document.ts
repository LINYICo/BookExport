import { httpsURL } from '../resource.ts';
import { escapeXml, languageTag, validXmlText } from '../text.ts';
import { rewriteCss, type ResolveResource } from './css.ts';

export function parseChapter(source: string, readerUrl: string, catalogHref?: string) {
    const clean = validXmlText(source);
    const template = document.createElement('template');
    const inert = template.content.ownerDocument;
    const docBody = inert.createElement('body');

    // WeRead uses an external XHTML 1.1 doctype and XML-only syntax in these chapters.
    // Remove a plain external declaration before parsing, without resolving it or its entities.
    const externalDoctype =
        /^(\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*)<!DOCTYPE\s+html\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+|SYSTEM\s+)(?:"[^"]*"|'[^']*')\s*>/i;
    const xmlSource = clean.replace(externalDoctype, '$1');
    const externalXml = /<\?xml-stylesheet\b|<!DOCTYPE[^>]*(?:\bSYSTEM\b|\bPUBLIC\b|\[)/i;
    const xml = externalXml.test(xmlSource)
        ? undefined
        : new DOMParser().parseFromString(xmlSource, 'application/xhtml+xml');
    const xmlBody = xml?.querySelector('parsererror') ? undefined : xml?.querySelector('body');

    let root: Element;
    let body: Element | null;
    if (xml && xmlBody?.namespaceURI === docBody.namespaceURI) {
        root = xml.documentElement;
        body = xmlBody;
    } else {
        // An HTML-context fragment preserves the head and body on an inert template document.
        root = inert.createElement('html');
        root.innerHTML = xmlSource;
        body = root.querySelector('body');
        // The fragment algorithm ignores the outer html tag. Read its attributes separately.
        const opening = clean.match(
            /^\s*(?:(?:<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[\s\S]*?\?>)\s*)*<html(?=[\s>])((?:[^>"']|"[^"]*"|'[^']*')*)>/i,
        )?.[1];
        if (opening) {
            template.innerHTML = '<div' + opening + '></div>';
            for (const name of ['lang', 'xml:lang', 'xml:base']) {
                const value = template.content.firstElementChild?.getAttribute(name);
                if (value !== null && value !== undefined) root.setAttribute(name, value);
            }
        }
    }
    const embeddedCss = Array.from(
        root.querySelectorAll('style'),
        (element) => element.textContent,
    ).join('\n');
    const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const href = httpsURL(catalogHref ?? '', readerUrl) ?? httpsURL(canonical ?? '', readerUrl);
    const sourceBase =
        root.querySelector('base[href]')?.getAttribute('href') ??
        body?.getAttribute('xml:base') ??
        root.getAttribute('xml:base');
    const base = httpsURL(sourceBase ?? '', href?.href ?? readerUrl) ?? href ?? new URL(readerUrl);
    if (body) {
        for (const name of ['class', 'id', 'style']) {
            const value = body.getAttribute(name);
            if (value !== null) docBody.setAttribute(name, value);
        }
        const direction = body.getAttribute('dir')?.toLowerCase();
        if (direction === 'ltr' || direction === 'rtl' || direction === 'auto')
            docBody.dir = direction;
        const language = languageTag(body.getAttribute('lang') ?? body.getAttribute('xml:lang'));
        if (language) docBody.lang = language;
        for (const node of body.childNodes) docBody.append(inert.importNode(node, true));
    }
    docBody
        .querySelectorAll(
            'script, iframe, frame, object, embed, link, base, meta, form, audio, video, source, style, foreignObject, animate, animateMotion, animateTransform, set, discard, template',
        )
        .forEach((element) => element.remove());
    for (const element of docBody.querySelectorAll('*')) {
        for (const attribute of Array.from(element.attributes)) {
            const { name, value, namespaceURI, localName } = attribute;
            if (
                name.toLowerCase().startsWith('on') ||
                ['srcset', 'data-src', 'poster', 'ping', 'background', 'xml:base'].includes(name)
            ) {
                element.removeAttributeNode(attribute);
                continue;
            }
            const xlink = namespaceURI === 'http://www.w3.org/1999/xlink' && localName === 'href';
            if (name === 'href' || xlink) {
                const permitted =
                    value.startsWith('#') ||
                    (['a', 'image'].includes(element.localName) && httpsURL(value, base.href));
                if (!permitted || (xlink && ['a', 'image'].includes(element.localName))) {
                    element.removeAttributeNode(attribute);
                    if (permitted && !element.hasAttribute('href'))
                        element.setAttribute('href', value);
                }
            }
            if (name === 'src' && element.localName !== 'img')
                element.removeAttributeNode(attribute);
        }
        const anchorName = element.localName === 'a' && element.getAttribute('name');
        if (anchorName && !element.id) element.id = anchorName;
    }
    const properties = [
        ...(docBody.querySelector('svg') ? ['svg' as const] : []),
        ...(docBody.querySelector('math') ? ['mathml' as const] : []),
    ];
    return {
        body: docBody,
        base: base.href,
        href: href?.href,
        properties,
        embeddedCss,
        language: languageTag(
            body?.getAttribute('lang') ||
                body?.getAttribute('xml:lang') ||
                root.getAttribute('xml:lang') ||
                root.getAttribute('lang'),
        ),
    };
}

type ParsedChapter = ReturnType<typeof parseChapter>;
export type ChapterDocument = Omit<ParsedChapter, 'body'> & {
    markup: string;
    anchors: Set<string>;
    title: string;
};

export function chapterResources(
    body: Element,
    css: string,
    resolve: ResolveResource,
    use: (path: string) => void,
) {
    for (const image of body.querySelectorAll('img, svg image')) {
        const html = image.localName === 'img';
        const attribute = html ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
        const src = image.getAttribute(attribute);
        const href = resolve(src ?? '', 'image');
        if (!html && attribute === 'href') image.removeAttribute('xlink:href');
        if (href) {
            image.setAttribute(attribute, href);
            use(href);
            if (html && !image.hasAttribute('alt')) image.setAttribute('alt', '');
        } else if (html) {
            const alt = image.getAttribute('alt');
            const label = alt ? '[Illustration: ' + alt + ']' : '[Image]';
            if (!image.id) image.replaceWith(label);
            else {
                const placeholder = body.ownerDocument.createElementNS(
                    'http://www.w3.org/1999/xhtml',
                    'span',
                );
                placeholder.id = image.id;
                placeholder.textContent = label;
                image.replaceWith(placeholder);
            }
        } else if (image.id) {
            const placeholder = body.ownerDocument.createElementNS(image.namespaceURI, 'g');
            placeholder.id = image.id;
            image.replaceWith(placeholder);
        } else image.remove();
    }

    const styled = body.hasAttribute('style')
        ? [body, ...body.querySelectorAll('[style]')]
        : body.querySelectorAll('[style]');
    for (const element of styled) {
        const text = element.getAttribute('style') ?? '';
        const style = rewriteCss(text, resolve, true, use);
        element.setAttribute('style', style);
    }
    for (const element of body.querySelectorAll('svg, svg *')) {
        for (const { name, value } of Array.from(element.attributes)) {
            if (name === 'style') continue;
            const escapedPresentation =
                value.includes('\\') &&
                /^(?:fill|stroke|clip-path|mask|filter|cursor|color-profile|marker(?:-start|-mid|-end)?)$/i.test(
                    name,
                );
            if (!escapedPresentation && !/url\s*\(/i.test(value)) continue;
            // Presentation attributes can reference symbols in the same chapter.
            if (/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value.trim())) continue;
            element.removeAttribute(name);
            resolve('');
        }
    }
    return rewriteCss(css, resolve, false, use);
}

export function chapterIndex(chapters: ChapterDocument[]) {
    const documents = new Map<string, number[]>();
    for (const [index, chapter] of chapters.entries()) {
        if (!chapter.href) continue;
        const url = new URL(chapter.href);
        url.hash = '';
        const entries = documents.get(url.href);
        if (entries) entries.push(index);
        else documents.set(url.href, [index]);
    }
    return documents;
}

export function rewriteChapterLinks(
    body: Element,
    index: number,
    chapters: ChapterDocument[],
    documents: Map<string, number[]>,
) {
    const chapter = chapters[index];
    if (!chapter) return;
    for (const anchor of body.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href') ?? '';
        const url = httpsURL(href, chapter.base);
        if (!url) {
            anchor.removeAttribute('href');
            continue;
        }
        let fragment = url.hash;
        const fullHref = url.href;
        url.hash = '';
        let id = '';
        try {
            id = decodeURIComponent(fragment.slice(1));
        } catch {
            fragment = '';
        }
        const candidates = documents.get(url.href) ?? [];
        const target = href.startsWith('#')
            ? index
            : (candidates.find((candidate) => chapters[candidate]?.href === fullHref) ??
              (id
                  ? candidates.find((candidate) => chapters[candidate]?.anchors.has(id))
                  : undefined) ??
              (candidates.length === 1 || !fragment ? candidates[0] : undefined));
        if (target !== undefined) {
            if (fragment && !chapters[target]?.anchors.has(id)) fragment = '';
            if (target === index && !fragment && href.startsWith('#')) {
                anchor.removeAttribute('href');
                continue;
            }
            const filename =
                target === index && fragment
                    ? ''
                    : chapterFileName(target + 1).slice('text/'.length);
            anchor.setAttribute('href', filename + fragment);
        } else if (candidates.length || !/^https:\/\//i.test(href)) anchor.removeAttribute('href');
    }
}

export function chapterFileName(index: number) {
    return 'text/chapter_' + String(index).padStart(4, '0') + '.xhtml';
}

export function makeChapterXhtml(
    title: string,
    source: string,
    css = '',
    options: {
        language?: string;
        attributes?: Readonly<Record<string, string>>;
        hasHeading?: boolean;
    } = {},
) {
    const language = languageTag(options.language) ?? 'und';
    const attributes = Object.entries(options.attributes ?? {})
        .filter(([name]) => ['class', 'id', 'dir', 'lang', 'style'].includes(name))
        .map(([name, value]) => ' ' + name + '="' + escapeXml(value) + '"')
        .join('');
    const heading = options.hasHeading ? '' : '<h1>' + escapeXml(title) + '</h1>';
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/weread.css"/>${css ? '<style>' + escapeXml(css) + '</style>' : ''}</head>
<body${attributes}>${heading}${source}</body></html>`;
}
