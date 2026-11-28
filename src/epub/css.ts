import type { ResourceKind } from '../resource.ts';

export type ResolveResource = (url: string, kind?: ResourceKind) => string | undefined;

export function rewriteCss(
    css: string,
    resolve: ResolveResource,
    inline: boolean,
    use: (path: string) => void,
) {
    const declarations = (style: CSSStyleDeclaration, font = false) => {
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
            const layered = property === 'background-image' || property === 'mask-image';
            const fontSources = font && property === 'src';
            const direct = original.replace(imageSets, '');
            const external = [...direct.matchAll(urlTokens)].filter(
                ([, target]) => !target?.startsWith('#'),
            );
            // Keep local SVG fragment references and skip composite functions we cannot safely repair.
            const ambiguous = external.length && /\b(?:image-set|cross-fade)\s*\(/i.test(direct);
            if (ambiguous || (external.length > 1 && !layered && !fontSources)) {
                resolve('');
                style.removeProperty(property);
                continue;
            }
            const mappedPaths = new Set<string>();
            const missing = 'url("")';
            let value = original
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
                    const mapped = resolve(decoded, fontSources ? 'font' : 'image');
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
            if (value.includes(missing) && layered) value = value.replaceAll(missing, 'none');
            if (value.includes(missing) && fontSources) {
                const sources = /(?:"(?:[^"\\]|\\.)*"|[^,])+/g;
                value = (value.match(sources) ?? [])
                    .filter((part) => !part.includes(missing))
                    .join(',');
            }
            const priority = style.getPropertyPriority(property);
            style.removeProperty(property);
            if (!value || value.includes(missing)) continue;
            style.setProperty(property, value, priority);
            if (mappedPaths.size)
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
                declarations(rule.style, rule instanceof CSSFontFaceRule);
            if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList)
                rewriteRules(rule.cssRules);
        }
    }
    rewriteRules(sheet.cssRules);
    return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}
