function bytesStartWith(data: Uint8Array, magic: number[]) {
    if (data.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (data[i] !== magic[i]) return false;
    }
    return true;
}

export function imageExtensionAndType(data: Uint8Array) {
    if (bytesStartWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return { ext: '.png', mediaType: 'image/png' };
    if (bytesStartWith(data, [0xff, 0xd8, 0xff])) return { ext: '.jpg', mediaType: 'image/jpeg' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))
        return { ext: '.gif', mediaType: 'image/gif' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
        return { ext: '.gif', mediaType: 'image/gif' };
    if (
        bytesStartWith(data, [0x52, 0x49, 0x46, 0x46]) &&
        bytesStartWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])
    )
        return { ext: '.webp', mediaType: 'image/webp' };
    return null;
}

function validXmlText(source: string) {
    return source.replace(/[\p{Cc}\uD800-\uDFFF\uFFFE\uFFFF]/gu, (character) => {
        const code = character.charCodeAt(0);
        return '\t\n\r'.includes(character) || (code >= 127 && code <= 159) ? character : '\ufffd';
    });
}

export function escapeXml(value: unknown) {
    return validXmlText(String(value))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export function parseChapter(source: string, readerUrl: string, catalogHref?: string) {
    const clean = validXmlText(source);
    const parser = new DOMParser();
    const xml = parser.parseFromString(clean, 'application/xhtml+xml');
    const doc = parser.parseFromString('', 'text/html');
    // Chromium can insert its own <body> around XML errors.
    const xmlBody = xml.querySelector('parsererror') ? undefined : xml.querySelector('body');
    const sourceRoot = xmlBody ? xml : parser.parseFromString(clean, 'text/html');
    const body = xmlBody ?? sourceRoot.body;
    const embeddedCss = Array.from(
        sourceRoot.querySelectorAll('style'),
        (element) => element.textContent,
    ).join('\n');
    const canonical = sourceRoot.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const href = httpsURL(catalogHref ?? '', readerUrl) ?? httpsURL(canonical ?? '', readerUrl);
    const sourceBase =
        sourceRoot.querySelector('base[href]')?.getAttribute('href') ??
        body?.getAttribute('xml:base') ??
        sourceRoot.documentElement.getAttribute('xml:base');
    const base = httpsURL(sourceBase ?? '', href?.href ?? readerUrl) ?? href ?? new URL(readerUrl);
    if (body) {
        for (const name of ['class', 'id', 'style']) {
            const value = body.getAttribute(name);
            if (value !== null) doc.body.setAttribute(name, value);
        }
        const direction = body.getAttribute('dir')?.toLowerCase();
        if (direction === 'ltr' || direction === 'rtl' || direction === 'auto')
            doc.body.dir = direction;
        const language = languageTag(body.getAttribute('lang') ?? body.getAttribute('xml:lang'));
        if (language) doc.body.lang = language;
        for (const node of body.childNodes) doc.body.append(doc.importNode(node, true));
    }
    doc.body
        .querySelectorAll(
            'script, iframe, frame, object, embed, link, base, meta, form, audio, video, source, style, foreignObject, animate, animateMotion, animateTransform, set, discard, template',
        )
        .forEach((element) => element.remove());
    for (const element of doc.body.querySelectorAll('*')) {
        for (const { name, value } of Array.from(element.attributes)) {
            if (
                name.toLowerCase().startsWith('on') ||
                ['srcset', 'data-src', 'poster', 'ping', 'background', 'xml:base'].includes(name)
            )
                element.removeAttribute(name);
            if (
                (name === 'href' || name === 'xlink:href') &&
                !value.startsWith('#') &&
                !(['a', 'image'].includes(element.localName) && httpsURL(value, base.href))
            )
                element.removeAttribute(name);
            if (name === 'src' && element.localName !== 'img') element.removeAttribute(name);
        }
        const anchorName = element.localName === 'a' && element.getAttribute('name');
        if (anchorName && !element.id) element.id = anchorName;
    }
    const properties = [
        ...(doc.body.querySelector('svg') ? ['svg' as const] : []),
        ...(doc.body.querySelector('math') ? ['mathml' as const] : []),
    ];
    return {
        body: doc.body,
        base: base.href,
        href: href?.href,
        properties,
        embeddedCss,
        language: languageTag(
            body?.getAttribute('lang') ||
                body?.getAttribute('xml:lang') ||
                sourceRoot.documentElement.getAttribute('xml:lang') ||
                sourceRoot.documentElement.getAttribute('lang'),
        ),
    };
}

export function httpsURL(value: string, base: string) {
    if (!value.trim()) return undefined;
    try {
        const url = new URL(value, base);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url;
    } catch {
        return undefined;
    }
}

export function rewriteCss(
    css: string,
    resolve: (url: string) => string | undefined,
    inline = false,
    use?: (path: string) => void,
) {
    const declarations = (style: CSSStyleDeclaration) => {
        for (const property of Array.from(style)) {
            const urlTokens = /url\("((?:[^"\\]|\\.)*)"\)/gi;
            // CSSOM normalizes straightforward candidates to quoted strings or url().
            const imageSets =
                /\bimage-set\(((?:(?:url|type)\("(?:[^"\\]|\\.)*"\)|"(?:[^"\\]|\\.)*"|[^()'"])+)\)/gi;
            const candidates = /(?:(?:url|type)\("(?:[^"\\]|\\.)*"\)|"(?:[^"\\]|\\.)*"|[^,])+/gi;
            const original = style
                .getPropertyValue(property)
                .replace(
                    imageSets,
                    (_, list: string) =>
                        'image-set(' +
                        (list.match(candidates) ?? [])
                            .map((item) => item.trim().replace(/^("(?:[^"\\]|\\.)*")/, 'url($1)'))
                            .join(', ') +
                        ')',
                );
            const raw = original
                .replace(urlTokens, '')
                .replace(/\btype\("(?:[^"\\]|\\.)*"\)/gi, '');
            // Unresolved variables and custom properties can contain unparsed URL tokens.
            if (
                (property.startsWith('--') &&
                    /["'\\]|\b(?:url|image|image-set|src)\s*\(/i.test(original)) ||
                /\burl\s*\(/i.test(raw) ||
                (/\b(?:image-set|image|src)\s*\(/i.test(raw) && /["'\\]/.test(raw)) ||
                (/\bvar\s*\(/i.test(raw) && raw.includes('\\'))
            ) {
                resolve('');
                style.removeProperty(property);
                continue;
            }
            const mappedPaths = new Set<string>();
            const missing = 'url("")';
            const value = original
                .replace(urlTokens, (whole: string, target: string) => {
                    if (target.startsWith('#')) return whole;
                    const decoded = target.replace(
                        /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/gi,
                        (_, hex: string | undefined, escaped: string | undefined) => {
                            if (!hex) return escaped ?? '';
                            const codePoint = Number.parseInt(hex, 16);
                            return codePoint > 0 && codePoint <= 0x10ffff
                                ? String.fromCodePoint(codePoint)
                                : '\ufffd';
                        },
                    );
                    const mapped = resolve(decoded);
                    if (!mapped) return missing;
                    mappedPaths.add(mapped);
                    return 'url(' + JSON.stringify(mapped) + ')';
                })
                .replace(imageSets, (_, list: string) => {
                    const kept = (list.match(candidates) ?? []).filter(
                        (item) => !item.includes(missing),
                    );
                    return kept.length ? 'image-set(' + kept.join(',') + ')' : missing;
                });
            const priority = style.getPropertyPriority(property);
            style.removeProperty(property);
            if (value.includes(missing)) continue;
            style.setProperty(property, value, priority);
            if (use && mappedPaths.size)
                for (const [, path] of style.getPropertyValue(property).matchAll(urlTokens))
                    if (path && mappedPaths.has(path)) use(path);
        }
    };
    if (inline) {
        const style = document.createElement('span').style;
        style.cssText = css;
        declarations(style);
        return style.cssText;
    }
    // Constructable stylesheets discard imports without exposing them through CSSOM.
    const tokens =
        /\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|@import(?=[^a-z0-9_-]|$)/gi;
    for (const [token] of css.matchAll(tokens)) {
        if (token.toLowerCase() === '@import') resolve('');
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    function rewriteRules(rules: CSSRuleList) {
        for (const rule of rules) {
            if ('style' in rule && rule.style instanceof CSSStyleDeclaration)
                declarations(rule.style);
            if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList)
                rewriteRules(rule.cssRules);
        }
    }
    rewriteRules(sheet.cssRules);
    return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}

export function languageTag(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
        return Intl.getCanonicalLocales(value)[0];
    } catch {
        return undefined;
    }
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
    resolve: (url: string, imageOnly?: boolean) => string | undefined,
    use?: (path: string) => void,
) {
    for (const image of body.querySelectorAll('img, svg image')) {
        const html = image.localName === 'img';
        const attribute = html ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
        const src = image.getAttribute(attribute);
        const href = resolve(src ?? '', true);
        if (!use) continue;
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
        if (use) element.setAttribute('style', style);
    }
    for (const element of body.querySelectorAll('svg, svg *')) {
        for (const { name, value } of Array.from(element.attributes)) {
            if (!/url\s*\(/i.test(value) || name === 'style') continue;
            // Presentation attributes can reference symbols in the same chapter.
            if (/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value.trim())) continue;
            if (use) element.removeAttribute(name);
            else resolve('');
        }
    }
    return rewriteCss(css, resolve, false, use);
}

export function chapterIndex(chapters: ChapterDocument[]) {
    const documents = new Map<string, number>();
    for (const [index, chapter] of chapters.entries()) {
        if (!chapter.href) continue;
        const url = new URL(chapter.href);
        url.hash = '';
        documents.set(url.href, index);
    }
    return documents;
}

export function rewriteChapterLinks(
    body: Element,
    index: number,
    chapters: ChapterDocument[],
    documents: Map<string, number>,
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
        url.hash = '';
        const target = href.startsWith('#') ? index : documents.get(url.href);
        if (target !== undefined) {
            if (fragment) {
                try {
                    if (!chapters[target]?.anchors.has(decodeURIComponent(fragment.slice(1))))
                        fragment = '';
                } catch {
                    fragment = '';
                }
            }
            if (target === index && !fragment && href.startsWith('#')) {
                anchor.removeAttribute('href');
                continue;
            }
            const filename =
                target === index && fragment
                    ? ''
                    : chapterFileName(target + 1).slice('text/'.length);
            anchor.setAttribute('href', filename + fragment);
        } else if (!/^https:\/\//i.test(href)) anchor.removeAttribute('href');
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
