// Protocol reference: finlater/weread.koplugin. Preserve the tested wire format.
// MD5 (RFC 1321)
// The API uses MD5 for integrity checks and b/c encoding. Web Crypto does not provide it.

const MD5_SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

function md5Digest(bytes: Uint8Array) {
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    padded[padded.length - 8] = bitLength & 0xff;
    padded[padded.length - 7] = (bitLength >>> 8) & 0xff;
    padded[padded.length - 6] = (bitLength >>> 16) & 0xff;
    padded[padded.length - 5] = (bitLength >>> 24) & 0xff;

    let a0 = 0x67452301,
        b0 = 0xefcdab89,
        c0 = 0x98badcfe,
        d0 = 0x10325476;
    const words = new DataView(padded.buffer);
    for (let offset = 0; offset < padded.length; offset += 64) {
        let a = a0,
            b = b0,
            c = c0,
            d = d0;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const sum = (a + f + (MD5_K[i] ?? 0) + words.getUint32(offset + g * 4, true)) | 0;
            const oldD = d;
            d = c;
            c = b;
            const shift = MD5_SHIFT[i] ?? 0;
            b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
            a = oldD;
        }
        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
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

export function md5Hex(input: string | Uint8Array) {
    return md5Digest(typeof input === 'string' ? new TextEncoder().encode(input) : input).toHex();
}

// b/c encoding
// Encode a book ID, chapter UID, or timestamp using the reader URL hash format.

export function wereadE(value: string | number) {
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
        for (const ch of s) joined += (ch.codePointAt(0) ?? 0).toString(16);
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

function jsString(value: unknown) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === null || value === undefined) return 'null';
    return String(value);
}

// Match Python's urllib.parse.quote(safe='') by also escaping !'()*.
function quoteParam(value: unknown) {
    return encodeURIComponent(jsString(value)).replace(
        /[!'()*]/g,
        (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
    );
}

export function sortedQuery(params: Record<string, unknown>) {
    return Object.keys(params)
        .sort()
        .map((key) => key + '=' + quoteParam(params[key]))
        .join('&');
}

export function wereadSign(query: string) {
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
export function buildContentParams({
    bookId,
    chapterUid,
    psvts,
    now,
    random,
    style = false,
    sc = 1,
}: {
    bookId: string;
    chapterUid: string | number;
    psvts: string;
    now: number;
    random: number;
    style?: boolean;
    sc?: number;
}) {
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
        st: style ? 1 : 0,
    };
    return { ...params, s: wereadSign(sortedQuery(params)) };
}

// Response validation and decoding
// Each shard has a 32-character uppercase MD5 prefix. Undo the swaps before decoding base64url.

export function checkedBody(responseText: string) {
    if (responseText.length <= 32) return '';
    const expected = responseText.slice(0, 32);
    const body = responseText.slice(32);
    const actual = md5Hex(body).toUpperCase();
    if (actual !== expected) {
        throw new Error('Shard MD5 mismatch: expected=' + expected + ', actual=' + actual);
    }
    return body;
}

export function swapPositions(encoded: string) {
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

function reverseSwaps(encoded: string, positions: number[]) {
    const chars = encoded.split('');
    for (let i = positions.length - 1; i >= 0; i -= 2) {
        for (const k of [1, 0]) {
            const left = (positions[i] ?? 0) + k;
            const right = (positions[i - 1] ?? 0) + k;
            const swap = chars[left] ?? '';
            chars[left] = chars[right] ?? '';
            chars[right] = swap;
        }
    }
    return chars.join('');
}

export function decodePayload(encodedPayload: string) {
    if (!encodedPayload) return '';
    const payload = encodedPayload.slice(1);
    const reordered = reverseSwaps(payload, swapPositions(payload));
    const bytes = Uint8Array.fromBase64(reordered, { alphabet: 'base64url' });
    return new TextDecoder('utf-8').decode(bytes);
}

export function decodeContentShards(e0: string, e1: string, e3: string) {
    return decodePayload(checkedBody(e0) + checkedBody(e1) + checkedBody(e3));
}

export function decodeStyleShard(e2: string) {
    return decodePayload(checkedBody(e2));
}
