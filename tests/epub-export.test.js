import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
    md5Hex,
    wereadE,
    sortedQuery,
    wereadSign,
    buildContentParams,
    checkedBody,
    decodePayload,
    decodeContentShards,
    parseReaderState,
    extractInitialState,
    createEbookExport,
    normalizeCatalog,
    selectExportableChapters,
    imageExtensionAndType,
    collectImageSources,
    finalizeChapterSource,
    extractBody,
    makeChapterXhtml,
    buildEpub,
    sanitizeFilename
} from '../chrome-extension/lib/epub-export.js';

// Reference vectors
// Generated with finlater/weread.koplugin on 2026-08-30 using the local script
// .scratch/epub-export/ref/fetch_weread_epub.py to detect changes in the protocol.

const GOLDEN_E = {
    '43208843': 'c9c321c07293508bc9c79df',
    '42': 'a1d32a6022aa1d0c6e83eb4',
    '0': 'cfc32da010cfcd208495488',
    '1756500000': '4bd32a307a7834d0g010930',
    '12345678901': 'bfd32730775bcd15g011abd',
    '1000000001': '404327f075f5e100g011f8e',
    'abc123': 'e9942030c6162633132334b4',
    '\u5c01\u9762': '41242b1085c019762412b2f'
};

const GOLDEN_QUERY = 'b=c9c321c07293508bc9c79df&c=a1d32a6022aa1d0c6e83eb4&ct=1756500000'
    + '&pc=4bd32a307a7834d0g010930&prevChapter=false&ps=4bd32a307a7834d0g010930&r=9801&sc=1&st=0';
const GOLDEN_SIGN = 'e01b786e';

const GOLDEN_PARAMS = {
    b: 'c9c321c07293508bc9c79df',
    c: 'a1d32a6022aa1d0c6e83eb4',
    r: '9801',
    ct: '1756500000',
    ps: 'abc',
    pc: '4bd32a307a7834d0g010930',
    sc: 1,
    prevChapter: false,
    st: 0,
    s: '961407fa'
};

const GOLDEN_PARAMS_COLLISION = {
    b: 'c9c321c07293508bc9c79df',
    c: 'a1d32a6022aa1d0c6e83eb4',
    r: '9801',
    ct: '1756500001',
    ps: '4bd32a307a7834d0g010930',
    pc: '973328007a7834d0g011ec5',
    sc: 1,
    prevChapter: false,
    st: 0,
    s: '8ead6a96'
};

const DECODE_PARA = '<p>\u7b2c\u4e00\u6bb5\uff1a\u4e2d\u6587\u4e0e ASCII \u6df7\u6392 mixed 123\u3002</p><p>\u7b2c\u4e8c\u6bb5 <b>\u52a0\u7c97</b> \u4e0e <i>\u659c\u4f53</i>\u3002</p>';
const GOLDEN_DECODED = DECODE_PARA.repeat(8) + '<p>\uFFFF</p>'.repeat(8);


const GOLDEN_SHARDS = [
    'A21735CEF482C7C8BFE32DE72A6E90CFZPHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHlz56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A_PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwva',
    '38526522324D96A9EE0030763CB91A94T7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5p7-5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeyA-wvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPua',
    '762972A1179F63BFE1DAFE8533D80427WnOS9kzwvaT7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A-PHA-56ys5LiA5q6177ya5Lit5paH5LiOIEFTQ0lJIOa3t-aOkiBtaXhlZCAxMjPjgII8L3A-PHA-56ys5LqM5q61IDxiPuWKoOeylzwvYj4g5LiOIDxpPuaWnOS9kzwvaT7jgII8L3A-PHA-7aH_PC9wPjxwPu-_vzwvcD48cD7vv788L3A-PHA-77--PC9wPjxwPu-_vzwvcD48cD7vv788L3A-PHA-77-_PC9wPjxwPu-_vzwvcD4='
];

// Derive the payload from the shards to avoid duplicating a long fixture.
// Each shard's MD5 prefix checks its transcription.
const GOLDEN_PAYLOAD = GOLDEN_SHARDS.map((shard) => shard.slice(32)).join('');

// ---- MD5 ----

test('md5Hex matches known vectors and Node crypto', () => {
    assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    for (const sample of ['Unicode \u2603', 'x'.repeat(500) + '\u2603' + 'y'.repeat(130)]) {
        const expected = crypto.createHash('md5').update(sample, 'utf8').digest('hex');
        assert.equal(md5Hex(sample), expected);
    }
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const expected = crypto.createHash('md5').update(bytes).digest('hex');
    assert.equal(md5Hex(bytes), expected);
});

// b/c encoding

test('wereadE matches reference vectors for numeric, multi-block, and Unicode input', () => {
    for (const [input, expected] of Object.entries(GOLDEN_E)) {
        assert.equal(wereadE(input), expected, input);
    }
});

// Request signing

test('sortedQuery sorts parameters by key', () => {
    const params = {
        st: 0, r: '9801', sc: 1, prevChapter: false,
        ps: '4bd32a307a7834d0g010930', pc: '4bd32a307a7834d0g010930',
        ct: '1756500000', c: 'a1d32a6022aa1d0c6e83eb4', b: 'c9c321c07293508bc9c79df'
    };
    assert.equal(sortedQuery(params), GOLDEN_QUERY);
});

test('wereadSign matches the reference signature', () => {
    assert.equal(wereadSign(GOLDEN_QUERY), GOLDEN_SIGN);
});

// Shard request parameters

test('buildContentParams matches the reference with fixed time and randomness', () => {
    const params = buildContentParams({
        bookId: '43208843', chapterUid: 42, psvts: 'abc',
        now: 1756500000000, random: 0.0099
    });
    assert.deepEqual(params, GOLDEN_PARAMS);
});

test('buildContentParams increments ct when its encoding matches psvts', () => {
    const params = buildContentParams({
        bookId: '43208843', chapterUid: 42,
        psvts: wereadE('1756500000'),
        now: 1756500000000, random: 0.0099
    });
    assert.deepEqual(params, GOLDEN_PARAMS_COLLISION);
});

test('buildContentParams sets st to 1 for CSS shards', () => {
    const params = buildContentParams({
        bookId: '43208843', chapterUid: 42, psvts: 'abc',
        now: 1756500000000, random: 0.0099, style: true
    });
    assert.equal(params.st, 1);
});

// Response validation and decoding

test('checkedBody verifies checksums and treats short responses as empty', () => {
    const body = 'hello-shard-body';
    const prefix = md5Hex(body).toUpperCase();
    assert.equal(checkedBody(prefix + body), body);

    const badPrefix = prefix.slice(0, 31) + (prefix.endsWith('0') ? '1' : '0');
    assert.throws(() => checkedBody(badPrefix + body), /MD5 mismatch/);

    assert.equal(checkedBody('short'), '');
    assert.equal(checkedBody('x'.repeat(32)), '');
});

test('decodePayload decodes the base64url reference payload with UTF-8 text', () => {
    assert.equal(decodePayload(GOLDEN_PAYLOAD), GOLDEN_DECODED);
});

test('decodeContentShards joins three shards before decoding', () => {
    assert.equal(decodeContentShards(GOLDEN_SHARDS[0], GOLDEN_SHARDS[1], GOLDEN_SHARDS[2]), GOLDEN_DECODED);
});

test('prefix-only shards decode to an empty string', () => {
    const empty = md5Hex('').toUpperCase();
    assert.equal(decodeContentShards(empty, empty, empty), '');
});

// Reader state

test('parseReaderState extracts book metadata and psvts', () => {
    const state = parseReaderState({
        reader: { bookInfo: { bookId: '43208843', title: 'Continuous Delivery 2.0', author: 'Qiao Liang' }, psvts: 'ps-token' }
    });
    assert.deepEqual(state, { bookId: '43208843', title: 'Continuous Delivery 2.0', author: 'Qiao Liang', psvts: 'ps-token' });
});

test('parseReaderState requires a book ID and uses it as the fallback title', () => {
    assert.throws(() => parseReaderState({ reader: {} }), /bookId/);
    assert.throws(() => parseReaderState(null), /bookId/);
    const state = parseReaderState({ reader: { bookInfo: { bookId: '42' }, psvts: '' } });
    assert.equal(state.title, '42');
});

// Catalog normalization and chapter selection

test('normalizeCatalog accepts data, books, and unwrapped lists', () => {
    const chapters = [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }];
    assert.deepEqual(normalizeCatalog({ data: [{ bookId: '42', updated: chapters }] }, '42'), chapters);
    assert.deepEqual(normalizeCatalog({ books: [{ book: { bookId: '42' }, chapterInfos: chapters }] }, '42'), chapters);
    assert.deepEqual(normalizeCatalog([{ bookId: 'other' }, { bookId: '42', updated: chapters }], '42'), chapters);
});

test('normalizeCatalog skips entries without a chapter UID and reports missing books', () => {
    const chapters = [{ chapterUid: 1 }, { title: 'Invalid entry' }, null];
    const result = normalizeCatalog({ data: [{ bookId: '42', updated: chapters }] }, '42');
    assert.deepEqual(result, [{ chapterUid: 1 }]);
    assert.throws(() => normalizeCatalog({ data: [{ bookId: 'other' }] }, '42'), /catalog/);
});

test('selectExportableChapters skips covers and chapters without words', () => {
    const chapters = [
        { chapterUid: 1, title: '\u5c01\u9762', wordCount: 500 },
        { chapterUid: 2, title: 'Chapter One', wordCount: 100 },
        { chapterUid: 3, title: 'Chapter Two', wordCount: 0 },
        { chapterUid: 4, title: 'Chapter Three' }
    ];
    const result = selectExportableChapters(chapters);
    assert.deepEqual(result.map((c) => c.chapterUid), [2]);
});

// Chapter content

// Image assets

test('imageExtensionAndType identifies images by their signatures', () => {
    assert.deepEqual(
        imageExtensionAndType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])),
        { ext: '.png', mediaType: 'image/png' }
    );
    assert.deepEqual(imageExtensionAndType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])), { ext: '.jpg', mediaType: 'image/jpeg' });
    assert.deepEqual(imageExtensionAndType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), { ext: '.gif', mediaType: 'image/gif' });
    assert.deepEqual(imageExtensionAndType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), { ext: '.gif', mediaType: 'image/gif' });
    assert.deepEqual(
        imageExtensionAndType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
        { ext: '.webp', mediaType: 'image/webp' }
    );
    assert.equal(imageExtensionAndType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
    assert.equal(imageExtensionAndType(new Uint8Array([0xff, 0xd8])), null, 'truncated data is rejected');
});

test('finalizeChapterSource uses EPUB paths and placeholders for missing images', () => {
    const srcMap = { 'https://res.weread.qq.com/wrepub/epub_1.jpg?a=1': '../images/epub_1.jpg' };
    const source = '<div class="bodyPic"><img src="https://res.weread.qq.com/wrepub/epub_1.jpg?a=1"/></div>'
        + '<p><img src="https://x/missing.png" alt="Diagram"/></p>'
        + '<p><img src="https://x/gone.png"/></p>';
    const out = finalizeChapterSource(source, srcMap);
    assert.ok(out.includes('src="../images/epub_1.jpg"'), 'downloaded images use EPUB paths');
    assert.ok(out.includes('[Illustration: Diagram]'), 'missing images retain their alternative text');
    assert.ok(out.includes('[Image]'), 'images without alternative text use a generic placeholder');
    assert.ok(!out.includes('res.weread.qq.com') && !out.includes('missing.png') && !out.includes('gone.png'),
        'remote image URLs are removed');
    assert.equal(finalizeChapterSource('<p>No images</p>', srcMap), '<p>No images</p>');
    // An empty asset map produces placeholders for all images.
    assert.ok(finalizeChapterSource('<img src="https://x/a.jpg"/>', {}).includes('[Image]'));
});

test('collectImageSources and finalizeChapterSource preserve lazy-loading attributes', () => {
    const source = '<img data-src="https://a/lazy.jpg" src="https://a/real.jpg"/>';
    assert.deepEqual(collectImageSources(source), ['https://a/real.jpg']);
    const out = finalizeChapterSource(source, { 'https://a/real.jpg': '../images/r.jpg' });
    assert.ok(out.includes('src="../images/r.jpg"'), 'the src attribute is rewritten');
    assert.ok(out.includes('data-src="https://a/lazy.jpg"'), 'the lazy-loading attribute is preserved');
});

test('finalizeChapterSource matches the full image URL before rewriting it', () => {
    const src = 'https://res.weread.qq.com/wrepub/epub_1.jpg?a=1';
    const srcMap = { [src]: '../images/ch0001_img001.jpg' };
    const source = '<div class="bodyPic"><img src="' + src + '"/></div>'
        + '<p><img src="https://x/missing.png" alt="Diagram"/></p>'
        + '<p><img src="https://x/gone.png"/></p>';
    const out = finalizeChapterSource(source, srcMap);
    assert.ok(out.includes('src="../images/ch0001_img001.jpg"'), 'the full URL maps to its EPUB path');
    assert.ok(out.includes('[Illustration: Diagram]'), 'missing images retain their alternative text');
    assert.ok(out.includes('[Image]'), 'images without alternative text use a generic placeholder');
    assert.ok(!out.includes('res.weread.qq.com') && !out.includes('missing.png') && !out.includes('gone.png'),
        'remote image URLs are removed');
    assert.equal(finalizeChapterSource('<p>No images</p>', {}), '<p>No images</p>');
    assert.ok(finalizeChapterSource('<img src="https://x/a.jpg"/>', {}).includes('[Image]'));
});

test('collectImageSources deduplicates image URLs in source order', () => {
    const source = '<div><img src="https://a/1.jpg"/></div>'
        + '<p><img src="https://a/1.jpg"/></p>'
        + '<p><img src="https://a/2.png?x=1"/></p>'
        + '<p><img class="c"/></p>';
    assert.deepEqual(collectImageSources(source), ['https://a/1.jpg', 'https://a/2.png?x=1']);
});

test('extractBody extracts the body or escapes the source as a fallback', () => {
    assert.equal(extractBody('<html><body><p>x</p></body></html>'), '<p>x</p>');
    assert.equal(extractBody('plain\ntext<next>'), '<p>plain<br/>text&lt;next&gt;</p>');
});

test('makeChapterXhtml includes the title, stylesheet link, and chapter body', () => {
    const xhtml = makeChapterXhtml('First <chapter>', '<html><body><p>Chapter text</p></body></html>');
    assert.ok(xhtml.includes('<title>First &lt;chapter&gt;</title>'));
    assert.ok(xhtml.includes('<h1>First &lt;chapter&gt;</h1>'));
    assert.ok(xhtml.includes('href="../styles/weread.css"'));
    assert.ok(xhtml.includes('<p>Chapter text</p>'));
});

// EPUB packaging

function readZipEntries(archive) {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let eocd = -1;
    for (let i = archive.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    assert.notEqual(eocd, -1, 'missing end of central directory');
    assert.equal(view.getUint32(eocd, true), 0x06054b50, 'end of central directory signature');
    assert.equal(view.getUint16(eocd + 4, true), 0, 'disk number is zero');
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory signature');
        const method = view.getUint16(at + 10, true);
        const compSize = view.getUint32(at + 20, true);
        const uncompSize = view.getUint32(at + 24, true);
        const nameLen = view.getUint16(at + 28, true);
        const extraLen = view.getUint16(at + 30, true);
        const commentLen = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        const name = new TextDecoder().decode(archive.slice(at + 46, at + 46 + nameLen));

        const l = localOffset;
        assert.equal(view.getUint32(l, true), 0x04034b50, 'local file header signature: ' + name);
        const lNameLen = view.getUint16(l + 26, true);
        const lExtraLen = view.getUint16(l + 28, true);
        const dataStart = l + 30 + lNameLen + lExtraLen;
        const raw = archive.slice(dataStart, dataStart + compSize);
        const data = method === 0 ? raw : new Uint8Array(zlib.inflateRawSync(raw));
        assert.equal(data.length, uncompSize, 'uncompressed size: ' + name);
        entries.set(name, { method, text: () => new TextDecoder().decode(data) });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

test('buildEpub produces an EPUB readable as a standard ZIP archive', async () => {
    const archive = await buildEpub({
        title: 'Test Book',
        author: 'Test Author',
        chapters: [
            { title: 'Chapter One', source: '<html><body><p>First chapter text</p></body></html>' },
            { title: 'Second <chapter>', source: '<html><body><p>Second chapter text</p><p>[Illustration: Figure A]</p></body></html>' }
        ],
        css: 'p{margin:0}',
        now: 1756500000000
    });

    const entries = readZipEntries(archive);
    assert.deepEqual(
        [...entries.keys()],
        [
            'mimetype',
            'META-INF/container.xml',
            'OEBPS/content.opf',
            'OEBPS/toc.ncx',
            'OEBPS/nav.xhtml',
            'OEBPS/styles/weread.css',
            'OEBPS/text/chapter_0001.xhtml',
            'OEBPS/text/chapter_0002.xhtml'
        ]
    );

    assert.equal(entries.get('mimetype').method, 0, 'mimetype must be stored without compression');
    assert.equal(entries.get('mimetype').text(), 'application/epub+zip');

    const chapter1 = entries.get('OEBPS/text/chapter_0001.xhtml').text();
    assert.ok(chapter1.includes('<title>Chapter One</title>'));
    assert.ok(chapter1.includes('<p>First chapter text</p>'));

    const chapter2 = entries.get('OEBPS/text/chapter_0002.xhtml').text();
    assert.ok(chapter2.includes('[Illustration: Figure A]'), 'placeholder text is preserved');
    assert.ok(!chapter2.includes('<img'));
    assert.ok(chapter2.includes('<title>Second &lt;chapter&gt;</title>'));

    const opf = entries.get('OEBPS/content.opf').text();
    assert.ok(opf.includes('<dc:title>Test Book</dc:title>'));
    assert.ok(opf.includes('<dc:creator>Test Author</dc:creator>'));
    assert.ok(opf.includes('<dc:language>zh-CN</dc:language>'));
    assert.ok(opf.includes('dcterms:modified'));
    assert.ok(opf.includes('href="text/chapter_0002.xhtml"'));

    const nav = entries.get('OEBPS/nav.xhtml').text();
    assert.ok(nav.includes('href="text/chapter_0001.xhtml">Chapter One</a>'));

    const ncx = entries.get('OEBPS/toc.ncx').text();
    assert.ok(ncx.includes('<text>Chapter One</text>'));

    assert.equal(entries.get('OEBPS/styles/weread.css').text(), 'p{margin:0}');
});

test('buildEpub supplies a fallback stylesheet', async () => {
    const archive = await buildEpub({
        title: 'Book', author: '', chapters: [{ title: 'Chapter', source: '<p>x</p>' }], css: '', now: 0
    });
    const entries = readZipEntries(archive);
    assert.ok(entries.get('OEBPS/styles/weread.css').text().includes('line-height'));
});

test('buildEpub stores images without compression and lists them in the manifest', async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    const archive = await buildEpub({
        title: 'Book',
        author: '',
        now: 0,
        chapters: [{
            title: 'Chapter',
            source: '<html><body><p>x</p><div class="bodyPic"><img src="../images/pic.jpg"/></div></body></html>',
            assets: [{ key: 'pic.jpg', filename: 'pic.jpg', href: 'images/pic.jpg', mediaType: 'image/jpeg', data: jpg }]
        }],
        css: ''
    });
    const entries = readZipEntries(archive);
    assert.ok([...entries.keys()].includes('OEBPS/images/pic.jpg'), 'the image entry exists');
    assert.equal(entries.get('OEBPS/images/pic.jpg').method, 0, 'the image is stored without recompression');
    assert.ok(
        entries.get('OEBPS/content.opf').text().includes('href="images/pic.jpg" media-type="image/jpeg"'),
        'the manifest lists the asset'
    );
    assert.ok(entries.get('OEBPS/text/chapter_0001.xhtml').text().includes('src="../images/pic.jpg"'));
});

test('extractInitialState extracts state JSON from the reader HTML', () => {
    const html = '<!DOCTYPE html><script>window.__INITIAL_STATE__  ='
        + ' {"reader":{"bookInfo":{"bookId":"43208843"},"psvts":"ps","meta":[1,2]}};(function(){})();</script>';
    const state = extractInitialState(html);
    assert.equal(state.reader.bookInfo.bookId, '43208843');
    assert.equal(state.reader.psvts, 'ps');
});

test('extractInitialState reports missing or malformed state', () => {
    assert.throws(() => extractInitialState('<html><body>Reader layout changed</body></html>'), /__INITIAL_STATE__/);
    assert.throws(
        () => extractInitialState('<script>window.__INITIAL_STATE__ = {broken};(function(){});</script>'),
        /Could not parse/
    );
});

// The isolated content script must fetch the reader HTML to obtain the book ID.
test('createEbookExport reads the page source before requesting the catalog', async () => {
    const readerHtml = '<script>window.__INITIAL_STATE__ ='
        + ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
    const catalog = JSON.stringify({
        data: [{ bookId: '43208843', updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }] }]
    });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, method: init.method || 'GET', body: init.body });
        if (init.method === 'POST' && u.includes('chapterInfos')) {
            return { ok: true, text: async () => catalog };
        }
        if (init.method === 'POST') return { ok: true, text: async () => '{}' };
        return { ok: true, text: async () => readerHtml };
    };
    try {
        const win = { location: { href: 'https://weread.qq.com/web/reader/abc', pathname: '/web/reader/abc' } };
        const ex = createEbookExport({
            doc: {},
            win,
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1]
        });
        assert.equal(ex.viewState().disabled, false, 'the reader URL enables the export button');
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.deepEqual(calls[0], {
            url: 'https://weread.qq.com/web/reader/abc',
            method: 'GET',
            body: undefined
        }, 'the first request retrieves the page source');
        assert.equal(JSON.parse(calls[1].body).bookIds[0], '43208843', 'the book ID comes from the page source');
        assert.ok(ex.viewState().title.includes('e_0'), 'the export stops on an empty shard: ' + ex.viewState().title);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createEbookExport renews and retries empty shards and explains how to recover', async () => {
    const readerHtml = '<script>window.__INITIAL_STATE__ ='
        + ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
    const catalog = JSON.stringify({
        data: [{ bookId: '43208843', updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }] }]
    });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (init.method === 'POST' && u.includes('renewal')) {
            calls.push('renewal');
            return { ok: true, text: async () => '{"succ":1}' };
        }
        if (init.method === 'POST' && u.includes('e_0')) {
            calls.push('e_0');
            return { ok: true, text: async () => '{}' };
        }
        if (init.method === 'POST' && u.includes('chapterInfos')) {
            calls.push('catalog');
            return { ok: true, text: async () => catalog };
        }
        calls.push('other');
        return { ok: true, text: async () => readerHtml };
    };
    try {
        const ex = createEbookExport({
            doc: {},
            win: { location: { href: 'https://weread.qq.com/web/reader/abc', pathname: '/web/reader/abc' } },
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            imageDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1]
        });
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(calls.filter((c) => c === 'e_0').length, 3, 'e_0 is requested three times');
        assert.equal(calls.filter((c) => c === 'renewal').length, 2, 'the session is renewed before each retry');
        assert.ok(ex.viewState().title.includes('Your session may have expired or WeRead may be limiting requests'), 'the error explains how to recover: ' + ex.viewState().title);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createEbookExport reports non-JSON chapterInfos responses', async () => {
    const readerHtml = '<script>window.__INITIAL_STATE__ ='
        + ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps"}};(function(){});</script>';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && String(url).includes('chapterInfos')) {
            return { ok: true, text: async () => '<html>Blocked by gateway</html>' };
        }
        return { ok: true, text: async () => readerHtml };
    };
    try {
        const ex = createEbookExport({
            doc: {},
            win: { location: { href: 'https://weread.qq.com/web/reader/abc', pathname: '/web/reader/abc' } },
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1]
        });
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(ex.viewState().title.includes('Could not parse the chapterInfos response'), 'error message: ' + ex.viewState().title);
        assert.ok(ex.viewState().title.includes('Blocked by gateway'), 'includes a response excerpt');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// Filenames

test('sanitizeFilename removes invalid filename characters', () => {
    assert.equal(sanitizeFilename('a/b:c*d?"<>|'), 'abcd');
    assert.equal(sanitizeFilename('  Continuous Delivery 2.0 '), 'Continuous Delivery 2.0');
    assert.equal(sanitizeFilename('???'), 'bookexport');
});
