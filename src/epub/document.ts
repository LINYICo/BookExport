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
    const body = xml.querySelector('body');
    // Template contents stay inert while parsing fragments and non-XML HTML.
    const template = doc.createElement('template');
    if (!body) template.innerHTML = clean;
    const sourceRoot = body ? xml : template.content;
    const embeddedCss = Array.from(
        sourceRoot.querySelectorAll('style'),
        (element) => element.textContent,
    ).join('\n');
    const canonical = sourceRoot.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const href = httpsURL(catalogHref ?? '', readerUrl) ?? httpsURL(canonical ?? '', readerUrl);
    const sourceBase =
        sourceRoot.querySelector('base[href]')?.getAttribute('href') ??
        (body ? xml.documentElement.getAttribute('xml:base') : null);
    const base = httpsURL(sourceBase ?? '', href?.href ?? readerUrl) ?? href ?? new URL(readerUrl);
    if (body) {
        for (const name of ['class', 'id', 'dir', 'lang', 'style']) {
            const value = body.getAttribute(name);
            if (value !== null) doc.body.setAttribute(name, value);
        }
        for (const node of body.childNodes) doc.body.append(doc.importNode(node, true));
    } else doc.body.append(template.content);
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
                xml.documentElement.getAttribute('xml:lang') ||
                xml.documentElement.getAttribute('lang'),
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
) {
    const declarations = (style: CSSStyleDeclaration) => {
        for (const property of Array.from(style)) {
            const original = style.getPropertyValue(property);
            const urlTokens = /url\("((?:[^"\\]|\\.)*)"\)/gi;
            const raw = original.replace(urlTokens, '');
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
            let unavailable = false;
            const value = original.replace(urlTokens, (whole: string, target: string) => {
                if (target.startsWith('#')) return whole;
                const mapped = resolve(target);
                if (mapped) return 'url(' + JSON.stringify(mapped) + ')';
                unavailable = true;
                return whole;
            });
            if (unavailable) style.removeProperty(property);
            else style.setProperty(property, value, style.getPropertyPriority(property));
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
    finalize = false,
) {
    for (const image of body.querySelectorAll('img, svg image')) {
        const html = image.localName === 'img';
        const attribute = html ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
        const src = image.getAttribute(attribute);
        const href = resolve(src ?? '', true);
        if (!finalize) continue;
        if (!html && attribute === 'href') image.removeAttribute('xlink:href');
        if (href) {
            image.setAttribute(attribute, href);
            if (html && !image.hasAttribute('alt')) image.setAttribute('alt', '');
        } else if (html) {
            const alt = image.getAttribute('alt');
            image.replaceWith(alt ? '[Illustration: ' + alt + ']' : '[Image]');
        } else image.remove();
    }

    const styled = body.hasAttribute('style')
        ? [body, ...body.querySelectorAll('[style]')]
        : body.querySelectorAll('[style]');
    for (const element of styled) {
        const text = element.getAttribute('style') ?? '';
        const style = rewriteCss(text, resolve, true);
        if (finalize) element.setAttribute('style', style);
    }
    for (const element of body.querySelectorAll('svg, svg *')) {
        for (const { name, value } of Array.from(element.attributes)) {
            if (!/url\s*\(/i.test(value) || name === 'style') continue;
            // Presentation attributes can reference symbols in the same chapter.
            if (/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value.trim())) continue;
            if (finalize) element.removeAttribute(name);
            else resolve('');
        }
    }
    return rewriteCss(css, resolve);
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
