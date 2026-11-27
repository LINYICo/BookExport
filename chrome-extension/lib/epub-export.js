// WeRead chapter API, EPUB packaging, and browser integration.
// Protocol reference: finlater/weread.koplugin, examined on 2026-08-30.
// See the signing and decoding tests when WeRead changes its reader.
// Pure functions run without browser globals. The factory supplies browser dependencies.

// MD5 (RFC 1321)
// The API uses MD5 for integrity checks and b/c encoding. Web Crypto does not provide it.

const MD5_SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

function md5Digest(bytes) {
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    padded[padded.length - 8] = bitLength & 0xff;
    padded[padded.length - 7] = (bitLength >>> 8) & 0xff;
    padded[padded.length - 6] = (bitLength >>> 16) & 0xff;
    padded[padded.length - 5] = (bitLength >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const words = new Uint32Array(16);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const at = offset + i * 4;
            words[i] = padded[at] | (padded[at + 1] << 8) | (padded[at + 2] << 16) | (padded[at + 3] << 24);
        }
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            const sum = (a + f + MD5_K[i] + words[g]) | 0;
            const oldD = d;
            d = c;
            c = b;
            b = (b + ((sum << MD5_SHIFT[i]) | (sum >>> (32 - MD5_SHIFT[i])))) | 0;
            a = oldD;
        }
        a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }

    const digest = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((word, i) => {
        digest[i * 4] = word & 0xff;
        digest[i * 4 + 1] = (word >>> 8) & 0xff;
        digest[i * 4 + 2] = (word >>> 16) & 0xff;
        digest[i * 4 + 3] = (word >>> 24) & 0xff;
    });
    return digest;
}

const HEX = '0123456789abcdef';

export function md5Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = md5Digest(bytes);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += HEX[digest[i] >> 4] + HEX[digest[i] & 15];
    return hex;
}

// b/c encoding
// Encode a book ID, chapter UID, or timestamp using the reader URL hash format.

export function wereadE(value) {
    const s = String(value);
    const hash = md5Hex(s);
    let result = hash.slice(0, 3);

    let chunks;
    let typeFlag;
    if (/^[0-9]+$/.test(s)) {
        chunks = [];
        for (let i = 0; i < s.length; i += 9) chunks.push(Number(s.slice(i, i + 9)).toString(16));
        typeFlag = '3';
    } else {
        let joined = '';
        for (const ch of s) joined += ch.codePointAt(0).toString(16);
        chunks = [joined];
        typeFlag = '4';
    }

    result += typeFlag + '2' + hash.slice(-2);
    chunks.forEach((chunk, index) => {
        result += chunk.length.toString(16).padStart(2, '0') + chunk;
        if (index < chunks.length - 1) result += 'g';
    });
    if (result.length < 20) result += hash.slice(0, 20 - result.length);
    result += md5Hex(result).slice(0, 3);
    return result;
}

// Request signing

function jsString(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === null || value === undefined) return 'null';
    return String(value);
}

// Match Python's urllib.parse.quote(safe='') by also escaping !'()*.
function quoteParam(value) {
    return encodeURIComponent(jsString(value))
        .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function sortedQuery(params) {
    return Object.keys(params).sort()
        .map((key) => key + '=' + quoteParam(params[key]))
        .join('&');
}

export function wereadSign(query) {
    let a = 0x15051505;
    let b = 0x15051505;
    const length = query.length;
    let i = length - 1;
    while (i > 0) {
        a = (a ^ (query.charCodeAt(i) << ((length - i) % 30))) & 0x7fffffff;
        b = (b ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
        i -= 2;
    }
    return (a + b).toString(16);
}

// Inject time in milliseconds and a random number in [0, 1) for deterministic requests.
export function buildContentParams({ bookId, chapterUid, psvts, now, random, style = false, sc = 1 }) {
    let ctValue = Math.floor(now / 1000);
    let ct = String(ctValue);
    if (wereadE(ct) === psvts) {
        ctValue += 1;
        ct = String(ctValue);
    }
    const params = {
        b: wereadE(bookId),
        c: wereadE(chapterUid),
        r: String(Math.floor(random * 10000) ** 2),
        ct,
        ps: psvts,
        pc: wereadE(ct),
        sc,
        prevChapter: false,
        st: style ? 1 : 0
    };
    params.s = wereadSign(sortedQuery(params));
    return params;
}

// Response validation and decoding
// Each shard has a 32-character uppercase MD5 prefix. Undo the swaps before decoding base64url.

export function checkedBody(responseText) {
    if (responseText.length <= 32) return '';
    const expected = responseText.slice(0, 32);
    const body = responseText.slice(32);
    const actual = md5Hex(body).toUpperCase();
    if (actual !== expected) {
        throw new Error('Shard MD5 mismatch: expected=' + expected + ', actual=' + actual);
    }
    return body;
}

export function swapPositions(encoded) {
    const length = encoded.length;
    if (length < 4) return [];
    if (length < 11) return [0, 2];

    const n = Math.min(4, Math.floor((length + 9) / 10));
    let tmp = '';
    for (let i = length - 1; i >= length - n; i--) {
        // The reference implementation interprets the binary digits in base four.
        tmp += parseInt(encoded.charCodeAt(i).toString(2), 4);
    }

    const positions = [];
    const m = length - n - 2;
    const step = String(m).length;
    let i = 0;
    while (positions.length < 10 && i + step < tmp.length) {
        positions.push(parseInt(tmp.slice(i, i + step), 10) % m);
        positions.push(parseInt(tmp.slice(i + 1, i + 1 + step), 10) % m);
        i += step;
    }
    return positions;
}

function reverseSwaps(encoded, positions) {
    const chars = encoded.split('');
    for (let i = positions.length - 1; i >= 0; i -= 2) {
        for (const k of [1, 0]) {
            const left = positions[i] + k;
            const right = positions[i - 1] + k;
            const swap = chars[left];
            chars[left] = chars[right];
            chars[right] = swap;
        }
    }
    return chars.join('');
}

function base64Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    const padding = '='.repeat((4 - (clean.length % 4)) % 4);
    const normalized = (clean + padding).replace(/=/g, 'A');
    const bytes = [];
    for (let i = 0; i < normalized.length; i += 4) {
        const packed = (alphabet.indexOf(normalized[i]) << 18)
            | (alphabet.indexOf(normalized[i + 1]) << 12)
            | (alphabet.indexOf(normalized[i + 2]) << 6)
            | alphabet.indexOf(normalized[i + 3]);
        bytes.push((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff);
    }
    return new Uint8Array(bytes.slice(0, bytes.length - padding.length));
}

export function decodePayload(encodedPayload) {
    if (!encodedPayload) return '';
    const payload = encodedPayload.slice(1);
    const reordered = reverseSwaps(payload, swapPositions(payload));
    const bytes = base64Decode(reordered);
    return new TextDecoder('utf-8').decode(bytes);
}

export function decodeContentShards(e0, e1, e3) {
    return decodePayload(checkedBody(e0) + checkedBody(e1) + checkedBody(e3));
}

export function decodeStyleShard(e2) {
    return decodePayload(checkedBody(e2));
}

// Reader state

// The isolated content script cannot read the page's JavaScript globals.
// Fetch the reader HTML to extract and parse the initial state.
export function extractInitialState(readerHtml) {
    const match = readerHtml.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function/);
    if (!match) throw new Error('Could not find __INITIAL_STATE__ in the reader HTML. The page layout may have changed.');
    let state;
    try {
        state = JSON.parse(match[1]);
    } catch (err) {
        throw new Error('Could not parse __INITIAL_STATE__: ' + err.message);
    }
    return state;
}

export function parseReaderState(initialState) {
    const reader = (initialState && initialState.reader) || {};
    const bookInfo = reader.bookInfo || {};
    const bookId = String(bookInfo.bookId || '');
    if (!bookId) throw new Error('Missing reader.bookInfo.bookId. Open a book in the WeRead reader.');
    return {
        bookId,
        title: bookInfo.title || bookId,
        author: bookInfo.author || '',
        psvts: reader.psvts || ''
    };
}

// Catalog normalization and chapter selection

export function normalizeCatalog(payload, bookId) {
    let candidates;
    if (Array.isArray(payload)) {
        candidates = payload;
    } else if (payload && typeof payload === 'object') {
        if (Array.isArray(payload.data)) candidates = payload.data;
        else if (Array.isArray(payload.books)) candidates = payload.books;
        else candidates = [payload];
    } else {
        throw new Error('Unexpected chapterInfos response format');
    }

    for (const item of candidates) {
        if (!item || typeof item !== 'object') continue;
        const itemBookId = String((item.bookId || (item.book && item.book.bookId)) || '');
        if (itemBookId === String(bookId)) {
            const chapters = item.updated || item.chapterInfos || item.chapters || [];
            return chapters.filter((ch) => ch && typeof ch === 'object' && ch.chapterUid);
        }
    }
    throw new Error('No catalog found for book ID ' + bookId);
}

export function selectExportableChapters(chapters) {
    // WeRead uses this localized title for the cover entry.
    return chapters.filter((ch) => Number(ch.wordCount || 0) > 0 && String(ch.title || '') !== '\u5c01\u9762');
}

// Chapter content

// Image assets
// Chapter images, including images of code listings, are embedded in the EPUB when available.
// Use the image's alternative text as a placeholder if the download fails.

function bytesStartWith(data, magic) {
    if (data.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (data[i] !== magic[i]) return false;
    }
    return true;
}

export function imageExtensionAndType(data) {
    if (bytesStartWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: '.png', mediaType: 'image/png' };
    if (bytesStartWith(data, [0xff, 0xd8, 0xff])) return { ext: '.jpg', mediaType: 'image/jpeg' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return { ext: '.gif', mediaType: 'image/gif' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return { ext: '.gif', mediaType: 'image/gif' };
    if (bytesStartWith(data, [0x52, 0x49, 0x46, 0x46])
        && bytesStartWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])) return { ext: '.webp', mediaType: 'image/webp' };
    return null;
}

// Collect unique image URLs in document order. The full CDN URL identifies each image.
export function collectImageSources(source) {
    const out = [];
    const seen = new Set();
    source.replace(/<img\b[^>]*>/gi, (tag) => {
        const m = tag.match(/(?<![\w-])src=(["'])([\s\S]*?)\1/i);
        if (m) {
            const src = decodeXmlEntities(m[2]);
            if (!seen.has(src)) {
                seen.add(src);
                out.push(src);
            }
        }
        return tag;
    });
    return out;
}

function decodeXmlEntities(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'");
}

// Replace each downloaded image URL with its EPUB path.
// Use a text placeholder when an image is missing or the server returns another file type.
export function finalizeChapterSource(source, srcMap) {
    return source.replace(/<img\b[^>]*>/gi, (tag) => {
        const srcMatch = tag.match(/(?<![\w-])src=(["'])([\s\S]*?)\1/i);
        if (srcMatch) {
            const src = decodeXmlEntities(srcMatch[2]);
            const href = srcMap[src];
            if (href) return tag.replace(srcMatch[0], 'src=' + srcMatch[1] + href + srcMatch[1]);
        }
        const alt = tag.match(/\balt=(["'])(.*?)\1/i);
        return alt && alt[2] ? '[Illustration: ' + alt[2] + ']' : '[Image]';
    });
}

export function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export function extractBody(source) {
    const match = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (match) return match[1];
    const escaped = escapeXml(source).replace(/\n/g, '<br/>');
    return '<p>' + escaped + '</p>';
}

export function makeChapterXhtml(title, source, cssHref = '../styles/weread.css') {
    const body = extractBody(source);
    return '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<!DOCTYPE html>\n'
        + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n'
        + '<head>\n'
        + '  <meta charset="utf-8"/>\n'
        + '  <title>' + escapeXml(title) + '</title>\n'
        + '  <link rel="stylesheet" type="text/css" href="' + escapeXml(cssHref) + '"/>\n'
        + '</head>\n'
        + '<body>\n'
        + '  <h1>' + escapeXml(title) + '</h1>\n'
        + '  ' + body + '\n'
        + '</body>\n'
        + '</html>\n';
}

// EPUB packaging

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buffer = await new Response(stream.readable).arrayBuffer();
    return new Uint8Array(buffer);
}

function writeUint16LE(target, value, at) {
    target[at] = value & 0xff;
    target[at + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target, value, at) {
    target[at] = value & 0xff;
    target[at + 1] = (value >>> 8) & 0xff;
    target[at + 2] = (value >>> 16) & 0xff;
    target[at + 3] = (value >>> 24) & 0xff;
}

// Minimal ZIP writer with stored and deflated entries and UTF-8 filenames.
export async function buildZip(entries, { now }) {
    const encoder = new TextEncoder();
    const date = new Date(now);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    const chunks = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const checksum = crc32(entry.data);
        let method = 0;
        let fileData = entry.data;
        if (entry.compress !== false && entry.data.length > 0) {
            method = 8;
            fileData = await deflateRaw(entry.data);
        }

        const local = new Uint8Array(30 + nameBytes.length + fileData.length);
        writeUint32LE(local, 0x04034b50, 0);
        writeUint16LE(local, 20, 4);
        writeUint16LE(local, 0x0800, 6);
        writeUint16LE(local, method, 8);
        writeUint16LE(local, dosTime, 10);
        writeUint16LE(local, dosDate, 12);
        writeUint32LE(local, checksum, 14);
        writeUint32LE(local, fileData.length, 18);
        writeUint32LE(local, entry.data.length, 22);
        writeUint16LE(local, nameBytes.length, 26);
        local.set(nameBytes, 30);
        local.set(fileData, 30 + nameBytes.length);
        chunks.push(local);

        const central = new Uint8Array(46 + nameBytes.length);
        writeUint32LE(central, 0x02014b50, 0);
        writeUint16LE(central, 20, 4);
        writeUint16LE(central, 20, 6);
        writeUint16LE(central, 0x0800, 8);
        writeUint16LE(central, method, 10);
        writeUint16LE(central, dosTime, 12);
        writeUint16LE(central, dosDate, 14);
        writeUint32LE(central, checksum, 16);
        writeUint32LE(central, fileData.length, 20);
        writeUint32LE(central, entry.data.length, 24);
        writeUint16LE(central, nameBytes.length, 28);
        writeUint32LE(central, offset, 42);
        central.set(nameBytes, 46);
        centrals.push(central);

        offset += local.length;
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    writeUint32LE(eocd, 0x06054b50, 0);
    writeUint16LE(eocd, centrals.length, 8);
    writeUint16LE(eocd, centrals.length, 10);
    writeUint32LE(eocd, centralSize, 12);
    writeUint32LE(eocd, offset, 16);

    const total = offset + centralSize + 22;
    const archive = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks.concat(centrals, [eocd])) {
        archive.set(chunk, at);
        at += chunk.length;
    }
    return archive;
}

function uuid4() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function chapterFileName(index) {
    return 'text/chapter_' + String(index).padStart(4, '0') + '.xhtml';
}

// Each chapter contains a title, XHTML source, and optional image assets.
// Image references in the source already point to EPUB paths or have been replaced with placeholders.
export async function buildEpub({ title, author, chapters, css, now }) {
    const encoder = new TextEncoder();
    const text = (value) => encoder.encode(value);
    const bookUuid = 'urn:uuid:' + uuid4();
    const modified = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const navItems = chapters.map((ch, i) =>
        '      <li><a href="' + chapterFileName(i + 1) + '">' + escapeXml(ch.title) + '</a></li>'
    ).join('\n');
    const nav = '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<!DOCTYPE html>\n'
        + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n'
        + '<head><meta charset="utf-8"/><title>Table of Contents</title></head>\n'
        + '<body>\n  <nav epub:type="toc" id="toc">\n    <h1>Table of Contents</h1>\n    <ol>\n'
        + navItems + '\n    </ol>\n  </nav>\n</body>\n</html>\n';

    const manifestChapters = chapters.map((ch, i) =>
        '    <item id="chapter_' + String(i + 1).padStart(4, '0') + '" href="' + chapterFileName(i + 1)
        + '" media-type="application/xhtml+xml"/>'
    ).join('\n');

    const allAssets = [];
    const seenHrefs = new Set();
    chapters.forEach((ch) => (ch.assets || []).forEach((asset) => {
        if (!seenHrefs.has(asset.href)) {
            seenHrefs.add(asset.href);
            allAssets.push(asset);
        }
    }));
    const manifestAssets = allAssets.map((asset, i) =>
        '    <item id="asset_' + String(i + 1).padStart(4, '0') + '" href="' + escapeXml(asset.href)
        + '" media-type="' + escapeXml(asset.mediaType) + '"/>'
    ).join('\n');
    const spineChapters = chapters.map((ch, i) =>
        '    <itemref idref="chapter_' + String(i + 1).padStart(4, '0') + '"/>'
    ).join('\n');
    const opf = '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n'
        + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        + '    <dc:identifier id="bookid">' + escapeXml(bookUuid) + '</dc:identifier>\n'
        + '    <dc:title>' + escapeXml(title) + '</dc:title>\n'
        + '    <dc:creator>' + escapeXml(author) + '</dc:creator>\n'
        + '    <dc:language>zh-CN</dc:language>\n'
        + '    <meta property="dcterms:modified">' + modified + '</meta>\n'
        + '  </metadata>\n'
        + '  <manifest>\n'
        + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
        + '    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
        + '    <item id="style" href="styles/weread.css" media-type="text/css"/>\n'
        + manifestChapters + '\n'
        + (allAssets.length ? manifestAssets + '\n' : '')
        + '  </manifest>\n'
        + '  <spine toc="toc">\n' + spineChapters + '\n  </spine>\n'
        + '</package>\n';

    const ncxPoints = chapters.map((ch, i) =>
        '    <navPoint id="navPoint-' + (i + 1) + '" playOrder="' + (i + 1) + '">\n'
        + '      <navLabel><text>' + escapeXml(ch.title) + '</text></navLabel>\n'
        + '      <content src="' + chapterFileName(i + 1) + '"/>\n'
        + '    </navPoint>'
    ).join('\n');

    const ncx = '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        + '  <head>\n'
        + '    <meta name="dtb:uid" content="' + escapeXml(bookUuid) + '"/>\n'
        + '    <meta name="dtb:depth" content="1"/>\n'
        + '    <meta name="dtb:totalPageCount" content="0"/>\n'
        + '    <meta name="dtb:maxPageNumber" content="0"/>\n'
        + '  </head>\n'
        + '  <docTitle><text>' + escapeXml(title) + '</text></docTitle>\n'
        + '  <navMap>\n' + ncxPoints + '\n  </navMap>\n'
        + '</ncx>\n';

    const container = '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        + '  <rootfiles>\n'
        + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
        + '  </rootfiles>\n'
        + '</container>\n';

    const entries = [
        { name: 'mimetype', data: text('application/epub+zip'), compress: false },
        { name: 'META-INF/container.xml', data: text(container) },
        { name: 'OEBPS/content.opf', data: text(opf) },
        { name: 'OEBPS/toc.ncx', data: text(ncx) },
        { name: 'OEBPS/nav.xhtml', data: text(nav) },
        { name: 'OEBPS/styles/weread.css', data: text(css || 'body { line-height: 1.6; }\n') }
    ];
    allAssets.forEach((asset) => {
        // Store compressed images directly in the ZIP archive.
        entries.push({ name: 'OEBPS/' + asset.href, data: asset.data, compress: false });
    });
    chapters.forEach((ch, i) => {
        entries.push({
            name: 'OEBPS/' + chapterFileName(i + 1),
            data: text(makeChapterXhtml(ch.title, ch.source))
        });
    });
    const archive = await buildZip(entries, { now });
    return archive;
}

export function sanitizeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '').trim() || 'bookexport';
}

// Browser integration

class ExportCancelled extends Error {
    constructor() {
        super('Export cancelled');
        this.name = 'ExportCancelled';
    }
}

const defaultChapterDelayMs = () => 2000 + Math.floor(Math.random() * 2000);
const defaultShardDelayMs = () => 200 + Math.floor(Math.random() * 200);
const defaultImageDelayMs = () => 300 + Math.floor(Math.random() * 200);
const defaultImageConcurrency = 4;

export function createEbookExport({
    doc,
    win,
    onStateChange = () => {},
    chapterDelayMs = defaultChapterDelayMs,
    shardDelayMs = defaultShardDelayMs,
    imageDelayMs = defaultImageDelayMs,
    imageConcurrency = defaultImageConcurrency,
    emptyRetryDelaysMs = [3000, 8000],
    fetchAsset = () => Promise.reject(new Error('No image downloader is available'))
}) {
    const state = { phase: 'idle', done: 0, total: 0, message: '', stage: '' };
    let controller;

    function notify() {
        onStateChange();
    }

    function hasBookContext() {
        try {
            // The isolated content script can read the URL through the DOM.
            return /^\/web\/reader\//.test(win.location.pathname);
        } catch {
            return false;
        }
    }

    function viewState() {
        if (state.phase === 'running') {
            return {
                running: true,
                disabled: controller.signal.aborted,
                done: state.done,
                total: state.total,
                chapterProgress: state.stage === 'chapters',
                message: controller.signal.aborted ? 'Cancelling download…' : state.message
            };
        }
        return {
            running: false,
            disabled: !hasBookContext(),
            message: state.message,
            title: state.message || 'Save a personal copy of this book as an EPUB'
        };
    }

    function sleep(ms, signal = controller.signal) {
        return new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', cancel);
                resolve();
            }, ms);
            function cancel() {
                clearTimeout(timer);
                reject(signal.reason);
            }
            signal.addEventListener('abort', cancel, { once: true });
        });
    }

    async function postText(path, body) {
        const resp = await fetch(path, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error('API request failed with HTTP ' + resp.status + ': ' + path);
        return resp.text();
    }

    // Successful renewal updates wr_skey for subsequent same-origin requests.
    async function renewSession() {
        try {
            const text = await postText('/web/login/renewal', { rq: '%2Fweb%2Fbook%2Fread', ql: false });
            return JSON.parse(text).succ === 1;
        } catch {
            throwIfCancelled();
            return false;
        }
    }

    // An empty object can indicate invalid parameters, an expired session, or missing access.
    // Error -2012 indicates an expired session. postShard handles renewal and retries.
    async function postShardOnce(path, params) {
        const text = await postText(path, params);
        if (text.indexOf('"errcode"') !== -1) {
            let code = '';
            try { code = String(JSON.parse(text).errcode || ''); } catch { /* Use the raw response for the error message. */ }
            const err = new Error(code === '-2012'
                ? 'Session expired (-2012)'
                : 'API error' + (code ? ' ' + code : '') + ': ' + text.slice(0, 120));
            err.kind = code === '-2012' ? 'auth' : 'fatal';
            throw err;
        }
        if (text === '{}') {
            const err = new Error('returned an empty response');
            err.kind = 'empty';
            throw err;
        }
        return text;
    }

    // Back off and renew after an empty response or an expired session.
    // Other errors propagate immediately.
    async function postShard(path, params) {
        let lastError = null;
        for (let attempt = 0; attempt <= emptyRetryDelaysMs.length; attempt++) {
            if (attempt > 0) {
                await sleep(emptyRetryDelaysMs[attempt - 1]);
                throwIfCancelled(); // Skip renewal if cancelled during backoff.
                await renewSession();
            }
            try {
                return await postShardOnce(path, params);
            } catch (err) {
                if (err.kind !== 'empty' && err.kind !== 'auth') throw err;
                lastError = err;
            }
        }
        if (lastError.kind === 'auth') {
            throw new Error(path + ' ' + lastError.message + '. Session renewal did not resolve the error. Refresh the page and sign in again.');
        }
        throw new Error(path + ' ' + lastError.message + ' after ' + emptyRetryDelaysMs.length
            + ' retries. Your session may have expired or WeRead may be limiting requests. Refresh the page, sign in again, and retry in a few minutes.');
    }

    function throwIfCancelled() {
        controller.signal.throwIfAborted();
    }

    async function fetchChapterSource(book, chapter) {
        const shards = {};
        const e0 = await postShard('/web/book/chapter/e_0', buildContentParams({
            bookId: book.bookId, chapterUid: chapter.chapterUid, psvts: book.psvts,
            now: Date.now(), random: Math.random()
        }));
        if (e0.startsWith('{') && e0.indexOf('"bookId"') !== -1) {
            throw new Error('Export is unavailable for TXT-format web novels.');
        }
        shards.e0 = e0;
        throwIfCancelled();
        await sleep(shardDelayMs());
        shards.e1 = await postShard('/web/book/chapter/e_1', buildContentParams({
            bookId: book.bookId, chapterUid: chapter.chapterUid, psvts: book.psvts,
            now: Date.now(), random: Math.random()
        }));
        throwIfCancelled();
        await sleep(shardDelayMs());
        shards.e3 = await postShard('/web/book/chapter/e_3', buildContentParams({
            bookId: book.bookId, chapterUid: chapter.chapterUid, psvts: book.psvts,
            now: Date.now(), random: Math.random()
        }));
        return decodeContentShards(shards.e0, shards.e1, shards.e3);
    }

    // Download each unique image URL and use placeholders for individual failures.
    // Each chapter has its own worker pool. Assign filenames in source order.
    // Throughput depends on concurrency, request latency, and the delay between requests.
    async function fetchChapterImages(source, chapterIndex, signal) {
        const srcs = collectImageSources(source);
        const srcMap = {};
        const assets = [];
        let cursor = 0;
        const worker = async () => {
            while (true) {
                signal.throwIfAborted();
                const k = cursor;
                if (k >= srcs.length) return;
                cursor += 1;
                const src = srcs[k];
                try {
                    const bytes = await fetchAsset(src, signal);
                    signal.throwIfAborted();
                    const kind = imageExtensionAndType(bytes);
                    if (!kind) throw new Error('The response was not an image');
                    const href = 'images/ch' + String(chapterIndex + 1).padStart(4, '0')
                        + '_img' + String(k + 1).padStart(3, '0') + kind.ext;
                    srcMap[src] = '../' + href;
                    assets.push({ href, mediaType: kind.mediaType, data: bytes });
                } catch {
                    signal.throwIfAborted();
                    // Leave failed downloads unmapped so the chapter gets a placeholder.
                }
                if (cursor < srcs.length) await sleep(imageDelayMs(), signal);
            }
        };
        await Promise.all(Array.from({ length: Math.min(imageConcurrency, srcs.length) }, () => worker()));
        return { srcMap, assets };
    }

    async function fetchBookCss(book, chapter) {
        try {
            const e2 = await postShardOnce('/web/book/chapter/e_2', buildContentParams({
                bookId: book.bookId, chapterUid: chapter.chapterUid, psvts: book.psvts,
                now: Date.now(), random: Math.random(), style: true
            }));
            return decodeStyleShard(e2);
        } catch {
            throwIfCancelled();
            return ''; // Try a later chapter for CSS instead of retrying this one.
        }
    }

    function saveBlob(bytes, filename) {
        const blob = new Blob([bytes], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);
        const anchor = doc.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        doc.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function fetchReaderState() {
        const resp = await fetch(win.location.href, { signal: controller.signal });
        if (!resp.ok) throw new Error('Could not load the reader page: HTTP ' + resp.status);
        return parseReaderState(extractInitialState(await resp.text()));
    }

    // The page-scoped psvts token can expire during long exports.
    // Refresh it before each chapter because cookie renewal alone cannot refresh it.
    async function refreshPsvts(book) {
        try {
            const fresh = await fetchReaderState();
            if (fresh.bookId === book.bookId && fresh.psvts) book.psvts = fresh.psvts;
        } catch {
            throwIfCancelled();
            // Keep the previous token and let the shard retry logic handle failures.
        }
    }

    async function run() {
        controller = new AbortController();
        const { signal } = controller;
        state.phase = 'running';
        state.done = 0;
        state.total = 0;
        state.message = 'Preparing download…';
        state.stage = 'preparing';
        let failedChapter = null;
        notify();

        try {
            const book = await fetchReaderState();
            if (!book.psvts) throw new Error('Missing psvts token. Refresh the reader page and try again.');
            const catalogText = await postText('/web/book/chapterInfos', { bookIds: [book.bookId] });
            let catalog;
            try {
                catalog = JSON.parse(catalogText);
            } catch {
                throw new Error('Could not parse the chapterInfos response: ' + catalogText.slice(0, 120));
            }
            const chapters = selectExportableChapters(normalizeCatalog(catalog, book.bookId));
            if (!chapters.length) throw new Error('No chapters are available to export.');
            state.total = chapters.length;
            state.stage = 'chapters';
            state.message = 'Downloading chapters (0 of ' + state.total + ')';
            notify();

            let css = '';
            let imageCount = 0;
            const fetched = [];
            const pendingImages = [];
            for (let i = 0; i < chapters.length; i++) {
                throwIfCancelled();
                failedChapter = chapters[i];
                if (i > 0) {
                    await refreshPsvts(book);
                    throwIfCancelled();
                }
                const chapter = chapters[i];
                const source = await fetchChapterSource(book, chapter);
                // Start image downloads while subsequent chapters are being fetched.
                const pool = fetchChapterImages(source, i, signal);
                pool.catch(() => {}); // Handle early rejections until the pools are awaited.
                pendingImages.push({
                    chapterTitle: String(chapter.title || chapter.chapterUid),
                    source,
                    images: pool
                });
                if (!css) css = await fetchBookCss(book, chapter);
                state.done = i + 1;
                state.message = 'Downloading chapters (' + state.done + ' of ' + state.total + ')';
                notify();
                if (i < chapters.length - 1) {
                    await sleep(chapterDelayMs());
                }
            }

            state.stage = 'images';
            state.message = 'Finishing image downloads…';
            notify();
            // Wait for image downloads before rewriting URLs to EPUB paths.
            for (const pending of pendingImages) {
                throwIfCancelled();
                const { srcMap, assets } = await pending.images;
                imageCount += assets.length;
                fetched.push({
                    title: pending.chapterTitle,
                    source: finalizeChapterSource(pending.source, srcMap),
                    assets
                });
            }

            throwIfCancelled();
            state.stage = 'packaging';
            state.message = 'Packaging EPUB…';
            notify();
            const archive = await buildEpub({
                title: book.title,
                author: book.author,
                chapters: fetched,
                css,
                now: Date.now()
            });
            throwIfCancelled();
            saveBlob(archive, sanitizeFilename(book.title) + '.epub');
            state.message = 'EPUB sent to browser downloads. Chapters: ' + fetched.length + '. Images: ' + imageCount;
        } catch (err) {
            const where = failedChapter && failedChapter.title ? '"' + failedChapter.title + '": ' : '';
            state.message = signal.aborted || err.name === 'ExportCancelled'
                ? 'Export cancelled'
                : 'Export failed: ' + where + err.message;
        } finally {
            controller.abort(new ExportCancelled());
            controller = undefined;
            state.phase = 'idle';
            notify();
        }
    }

    function toggle() {
        if (state.phase === 'running') {
            controller.abort(new ExportCancelled());
            notify();
            return;
        }
        if (hasBookContext()) run();
    }

    return { toggle, viewState };
}
