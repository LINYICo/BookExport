export function validXmlText(source: string) {
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

export function languageTag(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
        return Intl.getCanonicalLocales(value)[0];
    } catch {
        return undefined;
    }
}
