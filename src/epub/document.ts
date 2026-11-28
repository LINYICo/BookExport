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

export function escapeXml(value: unknown) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export function parseChapter(source: string) {
    // XML 1.0 excludes these characters even when the reader can display them.
    const clean = Array.from(source, (character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 9 ||
            code === 10 ||
            code === 13 ||
            (code >= 32 && code <= 0xd7ff) ||
            (code >= 0xe000 && code <= 0xfffd) ||
            code >= 0x10000
            ? character
            : '\ufffd';
    }).join('');
    const parser = new DOMParser();
    const xml = parser.parseFromString(clean, 'application/xhtml+xml');
    const doc = parser.parseFromString('', 'text/html');
    const body = xml.querySelector('body');
    if (body) {
        for (const node of body.childNodes) doc.body.append(doc.importNode(node, true));
    } else {
        // Template contents stay inert while parsing fragments and non-XML HTML.
        const template = doc.createElement('template');
        template.innerHTML = clean;
        doc.body.append(template.content);
    }
    doc.body
        .querySelectorAll(
            'script, iframe, frame, object, embed, link, base, meta, form, audio, video, source, foreignObject',
        )
        .forEach((element) => element.remove());
    for (const element of doc.body.querySelectorAll('*')) {
        for (const { name, value } of Array.from(element.attributes)) {
            if (
                name.startsWith('on') ||
                ['srcset', 'data-src', 'poster', 'ping', 'background'].includes(name)
            )
                element.removeAttribute(name);
            if (
                (name === 'href' || name === 'xlink:href') &&
                !value.startsWith('#') &&
                !(element.localName === 'a' && /^https?:\/\//i.test(value))
            )
                element.removeAttribute(name);
            if (name === 'src' && element.localName !== 'img') element.removeAttribute(name);
            if (name === 'style') element.setAttribute(name, localCss(value));
        }
        if (element.localName === 'style') element.textContent = localCss(element.textContent);
    }
    return doc.body;
}

export function localCss(css: string) {
    return css
        .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, '')
        .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match: string, _quote: string, target: string) =>
            target.startsWith('#') ? match : 'none',
        );
}

export function makeChapterXhtml(title: string, source: string) {
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">' +
        '<head><meta charset="utf-8"/><title>' +
        escapeXml(title) +
        '</title>' +
        '<link rel="stylesheet" type="text/css" href="../styles/weread.css"/></head>' +
        '<body><h1>' +
        escapeXml(title) +
        '</h1>' +
        source +
        '</body></html>'
    );
}
