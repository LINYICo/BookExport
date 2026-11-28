import { execFileSync } from 'node:child_process';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { GOLDEN_SHARDS } from '../fixtures/shards.ts';
import {
    md5Hex,
    wereadE,
    sortedQuery,
    wereadSign,
    buildContentParams,
    checkedBody,
    decodePayload,
    decodeContentShards,
} from '../../src/weread/protocol.ts';
import {
    parseReaderState,
    createWeReadClient,
    extractInitialState,
    normalizeCatalog,
    selectExportableChapters,
} from '../../src/weread/client.ts';
import { makeChapterXhtml } from '../../src/epub/document.ts';
import { buildEpub, sanitizeFilename } from '../../src/epub/builder.ts';
import { createEbookExport } from '../../src/export.ts';
import { buildZip } from '../../src/epub/zip.ts';

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
    abc123: 'e9942030c6162633132334b4',
    '\u5c01\u9762': '41242b1085c019762412b2f',
};

const GOLDEN_QUERY =
    'b=c9c321c07293508bc9c79df&c=a1d32a6022aa1d0c6e83eb4&ct=1756500000' +
    '&pc=4bd32a307a7834d0g010930&prevChapter=false&ps=4bd32a307a7834d0g010930&r=9801&sc=1&st=0';
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
    s: '961407fa',
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
    s: '8ead6a96',
};

const DECODE_PARA =
    '<p>\u7b2c\u4e00\u6bb5\uff1a\u4e2d\u6587\u4e0e ASCII \u6df7\u6392 mixed 123\u3002</p><p>\u7b2c\u4e8c\u6bb5 <b>\u52a0\u7c97</b> \u4e0e <i>\u659c\u4f53</i>\u3002</p>';
const GOLDEN_DECODED = DECODE_PARA.repeat(8) + '<p>\uFFFF</p>'.repeat(8);

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
        st: 0,
        r: '9801',
        sc: 1,
        prevChapter: false,
        ps: '4bd32a307a7834d0g010930',
        pc: '4bd32a307a7834d0g010930',
        ct: '1756500000',
        c: 'a1d32a6022aa1d0c6e83eb4',
        b: 'c9c321c07293508bc9c79df',
    };
    assert.equal(sortedQuery(params), GOLDEN_QUERY);
});

test('wereadSign matches the reference signature', () => {
    assert.equal(wereadSign(GOLDEN_QUERY), GOLDEN_SIGN);
});

// Shard request parameters

test('buildContentParams matches the reference with fixed time and randomness', () => {
    const params = buildContentParams({
        bookId: '43208843',
        chapterUid: 42,
        psvts: 'abc',
        now: 1756500000000,
        random: 0.0099,
    });
    assert.deepEqual(params, GOLDEN_PARAMS);
});

test('buildContentParams increments ct when its encoding matches psvts', () => {
    const params = buildContentParams({
        bookId: '43208843',
        chapterUid: 42,
        psvts: wereadE('1756500000'),
        now: 1756500000000,
        random: 0.0099,
    });
    assert.deepEqual(params, GOLDEN_PARAMS_COLLISION);
});

test('buildContentParams sets st to 1 for CSS shards', () => {
    const params = buildContentParams({
        bookId: '43208843',
        chapterUid: 42,
        psvts: 'abc',
        now: 1756500000000,
        random: 0.0099,
        style: true,
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

test('decodePayload accepts the original Base64 alphabets and ignores payload separators', () => {
    assert.equal(decodePayload('ZVsSGbG8?'), 'Hello');
    assert.equal(decodePayload('ZC/4K'), '\u083f');
    assert.equal(decodePayload('ZC_4K'), '\u083f');
    assert.equal(decodePayload('ZA'), '');
});

test('decodeContentShards joins three shards before decoding', () => {
    assert.equal(
        decodeContentShards(GOLDEN_SHARDS[0], GOLDEN_SHARDS[1], GOLDEN_SHARDS[2]),
        GOLDEN_DECODED,
    );
});

test('prefix-only shards decode to an empty string', () => {
    const empty = md5Hex('').toUpperCase();
    assert.equal(decodeContentShards(empty, empty, empty), '');
});

// Reader state

test('parseReaderState extracts book metadata and psvts', () => {
    const state = parseReaderState({
        reader: {
            bookInfo: {
                bookId: '43208843',
                title: 'Continuous Delivery 2.0',
                author: 'Qiao Liang',
            },
            psvts: 'ps-token',
        },
    });
    assert.deepEqual(state, {
        bookId: '43208843',
        title: 'Continuous Delivery 2.0',
        author: 'Qiao Liang',
        psvts: 'ps-token',
    });
});

test('parseReaderState requires a book ID and uses it as the fallback title', () => {
    assert.throws(() => parseReaderState({ reader: {} }), /Open a book/);
    assert.throws(() => parseReaderState(null), /Open a book/);
    const state = parseReaderState({ reader: { bookInfo: { bookId: '42' }, psvts: '' } });
    assert.equal(state.title, '42');
});

// Catalog normalization and chapter selection

test('normalizeCatalog accepts data, books, and unwrapped lists', () => {
    const chapters = [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }];
    assert.deepEqual(
        normalizeCatalog({ data: [{ bookId: '42', updated: chapters }] }, '42'),
        chapters,
    );
    assert.deepEqual(
        normalizeCatalog({ books: [{ book: { bookId: '42' }, chapterInfos: chapters }] }, '42'),
        chapters,
    );
    assert.deepEqual(
        normalizeCatalog([{ bookId: 'other' }, { bookId: '42', updated: chapters }], '42'),
        chapters,
    );
});

test('normalizeCatalog skips entries without a chapter UID and reports missing books', () => {
    const chapters = [{ chapterUid: 1 }, { title: 'Invalid entry' }, null];
    const result = normalizeCatalog({ data: [{ bookId: '42', updated: chapters }] }, '42');
    assert.deepEqual(result, [{ chapterUid: 1 }]);
    assert.throws(() => normalizeCatalog({ data: [{ bookId: 'other' }] }, '42'), /catalog/);
});

test('normalizeCatalog validates fields and excludes untrusted metadata', () => {
    const chapters = [
        { chapterUid: 1, title: 'Valid', wordCount: '0', parentChapterUid: 2, href: 'a.xhtml' },
        {
            chapterUid: '3',
            href: 42,
            parentChapterUid: {},
            sections: [{ id: 2, title: 'Ignored' }],
        },
        { chapterUid: 4, title: 42 },
        { chapterUid: 5, wordCount: false },
        { chapterUid: true },
    ];
    assert.deepEqual(normalizeCatalog({ bookId: '42', chapters }, '42'), [
        { chapterUid: 1, title: 'Valid', wordCount: '0', parentChapterUid: '2', href: 'a.xhtml' },
        { chapterUid: '3' },
    ]);
});

test('chapter selection keeps image and front-matter leaves and preserves group ancestry', () => {
    const chapters = [
        { chapterUid: 20, title: 'Part One', wordCount: 0 },
        { chapterUid: 21, title: 'Illustrations', parentChapterUid: '20', wordCount: 0 },
        { chapterUid: 22, title: 'Copyright', parentChapterUid: '20' },
        { chapterUid: '021', title: 'Duplicate entry', wordCount: 200 },
        { chapterUid: 23, title: '\u5c01\u9762', wordCount: 2 },
        { chapterUid: -1, title: 'Invalid ID' },
        { chapterUid: 'NaN', title: 'Invalid ID' },
    ];
    const result = selectExportableChapters(chapters);
    assert.deepEqual(
        result.map((chapter) => chapter.chapterUid),
        [21, 22],
    );
    assert.deepEqual(result[0]?.sections, [{ id: 20, title: 'Part One' }]);
    assert.deepEqual(result[1]?.sections, [{ id: 20, title: 'Part One' }]);
});

test('makeChapterXhtml includes the title, stylesheet link, and chapter body', () => {
    const xhtml = makeChapterXhtml('First <chapter>', '<p>Chapter text</p>');
    assert.ok(xhtml.includes('<title>First &lt;chapter&gt;</title>'));
    assert.ok(xhtml.includes('<h1>First &lt;chapter&gt;</h1>'));
    assert.ok(xhtml.includes('href="../styles/weread.css"'));
    assert.ok(xhtml.includes('<p>Chapter text</p>'));
});

// EPUB packaging

function readZipEntries(archive: Uint8Array<ArrayBuffer>) {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let eocd = -1;
    for (let i = archive.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    assert.notEqual(eocd, -1, 'missing end of central directory');
    assert.equal(view.getUint32(eocd, true), 0x06054b50, 'end of central directory signature');
    assert.equal(view.getUint16(eocd + 4, true), 0, 'disk number is zero');
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const entries = new Map<string, { method: number; text: () => string }>();
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
        assert.equal(view.getUint32(at + 16, true), zlib.crc32(data), 'CRC32: ' + name);
        assert.equal(data.length, uncompSize, 'uncompressed size: ' + name);
        entries.set(name, { method, text: () => new TextDecoder().decode(data) });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function validatedEpub(options: Parameters<typeof buildEpub>[0]) {
    const archive = await buildEpub(options);
    await using temp = await mkdtempDisposable(join(tmpdir(), 'bookexport-unit-'));
    const file = join(temp.path, 'fixture.epub');
    await writeFile(file, new Uint8Array(await archive.arrayBuffer()));
    execFileSync(process.env.EPUBCHECK_BIN || 'epubcheck', ['--failonwarnings', file], {
        timeout: 20000,
    });
    return archive;
}

test('buildEpub produces an EPUB readable as a standard ZIP archive', async () => {
    const archive = await validatedEpub({
        title: 'Test Book',
        author: 'Test Author',
        language: 'zh-cn',
        chapters: [
            { title: 'Chapter One', source: '<p>First chapter text</p>' },
            {
                title: 'Second <chapter>',
                source: '<p>Second chapter text</p><p>[Illustration: Figure A]</p>',
            },
        ],
        css: 'p{margin:0}',
        now: 1756500000000,
    });

    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));
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
            'OEBPS/text/chapter_0002.xhtml',
        ],
    );

    assert.equal(entries.get('mimetype')?.method, 0, 'mimetype must be stored without compression');
    assert.equal(entries.get('mimetype')?.text(), 'application/epub+zip');

    const chapter1 = entries.get('OEBPS/text/chapter_0001.xhtml')?.text();
    assert.ok(chapter1?.includes('<title>Chapter One</title>'));
    assert.ok(chapter1?.includes('<p>First chapter text</p>'));

    const chapter2 = entries.get('OEBPS/text/chapter_0002.xhtml')?.text();
    assert.ok(chapter2?.includes('[Illustration: Figure A]'), 'placeholder text is preserved');
    assert.ok(chapter2 && !chapter2.includes('<img'));
    assert.ok(chapter2?.includes('<title>Second &lt;chapter&gt;</title>'));

    const opf = entries.get('OEBPS/content.opf')?.text();
    assert.ok(opf?.includes('<dc:title>Test Book</dc:title>'));
    assert.ok(opf?.includes('<dc:creator>Test Author</dc:creator>'));
    assert.ok(opf?.includes('<dc:language>zh-CN</dc:language>'));
    assert.ok(opf?.includes('dcterms:modified'));
    assert.ok(opf?.includes('href="text/chapter_0002.xhtml"'));

    const nav = entries.get('OEBPS/nav.xhtml')?.text();
    assert.ok(nav?.includes('href="text/chapter_0001.xhtml">Chapter One</a>'));

    const ncx = entries.get('OEBPS/toc.ncx')?.text();
    assert.ok(ncx?.includes('<text>Chapter One</text>'));

    assert.equal(entries.get('OEBPS/styles/weread.css')?.text(), 'p{margin:0}');
});

test('buildEpub supplies a fallback stylesheet', async () => {
    const archive = await validatedEpub({
        title: 'Book',
        author: '',
        chapters: [{ title: 'Chapter', source: '<p>x</p>' }],
        css: '',
        now: 1756500000000,
    });
    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));
    assert.ok(entries.get('OEBPS/styles/weread.css')?.text().includes('line-height'));
});

test('buildEpub omits the creator when the author is missing or blank', async () => {
    for (const author of [undefined, '', '  ']) {
        const archive = await validatedEpub({
            title: 'Book',
            author,
            chapters: [{ title: 'Chapter', source: '<p>x</p>' }],
            css: '',
            now: 1756500000000,
        });
        const opf = readZipEntries(new Uint8Array(await archive.arrayBuffer()))
            .get('OEBPS/content.opf')
            ?.text();
        assert.ok(opf);
        assert.doesNotMatch(opf, /<dc:creator\b/);
    }
});

test('buildEpub stores images without compression and lists them in the manifest', async () => {
    const png = await readFile('public/icons/icon48.png');
    const archive = await validatedEpub({
        title: 'Book',
        author: '',
        now: 1756500000000,
        assets: [{ href: 'images/pic.png', mediaType: 'image/png', data: png }],
        chapters: [
            {
                title: 'Chapter',
                source: '<p>x</p><div class="bodyPic"><img src="../images/pic.png" alt="Sample"/></div>',
            },
        ],
        css: '',
    });
    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));
    assert.ok([...entries.keys()].includes('OEBPS/images/pic.png'), 'the image entry exists');
    assert.equal(
        entries.get('OEBPS/images/pic.png')?.method,
        0,
        'the image is stored without recompression',
    );
    assert.ok(
        entries
            .get('OEBPS/content.opf')
            ?.text()
            .includes('href="images/pic.png" media-type="image/png"'),
        'the manifest lists the asset',
    );
    assert.ok(
        entries.get('OEBPS/text/chapter_0001.xhtml')?.text().includes('src="../images/pic.png"'),
    );
});

test('extractInitialState extracts state JSON from the reader HTML', () => {
    const html =
        '<!DOCTYPE html><script>window.__INITIAL_STATE__  =' +
        ' {"reader":{"bookInfo":{"bookId":"43208843"},"psvts":"ps","meta":[1,2]}};(function(){})();</script>';
    const state = parseReaderState(extractInitialState(html));
    assert.equal(state.bookId, '43208843');
    assert.equal(state.psvts, 'ps');
});

test('extractInitialState reports missing or malformed state', () => {
    assert.throws(
        () => extractInitialState('<html><body>Reader layout changed</body></html>'),
        /book details/,
    );
    assert.throws(
        () =>
            extractInitialState(
                '<script>window.__INITIAL_STATE__ = {broken};(function(){});</script>',
            ),
        /invalid book details/,
    );
});

// The isolated content script must fetch the reader HTML to obtain the book ID.
test('createEbookExport reads the page source before requesting the catalog', async () => {
    const readerHtml =
        '<script>window.__INITIAL_STATE__ =' +
        ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
    const catalog = JSON.stringify({
        data: [
            {
                bookId: '43208843',
                updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }],
            },
        ],
    });
    const calls: {
        url: string;
        method: string;
        body: BodyInit | null | undefined;
        credentials: RequestCredentials | undefined;
    }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({
            url: u,
            method: init.method || 'GET',
            body: init.body,
            credentials: init.credentials,
        });
        if (init.method === 'POST' && u.includes('chapterInfos')) {
            return new Response(catalog);
        }
        if (init.method === 'POST') return new Response('{}');
        return new Response(readerHtml);
    };
    try {
        const win = {
            location: { href: 'https://weread.qq.com/web/reader/abc', pathname: '/web/reader/abc' },
        };
        const ex = createEbookExport({
            win,
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1],
        });
        assert.equal(ex.viewState().disabled, false, 'the reader URL enables the export button');
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.deepEqual(
            calls[0],
            {
                url: 'https://weread.qq.com/web/reader/abc',
                method: 'GET',
                body: undefined,
                credentials: 'same-origin',
            },
            'the first request retrieves the page source',
        );
        assert.ok(calls.every((call) => call.credentials === 'same-origin'));
        assert.equal(
            JSON.parse(String(calls[1]?.body)).bookIds[0],
            '43208843',
            'the book ID comes from the page source',
        );
        assert.ok(
            ex.viewState().message.includes('e_0'),
            'the export stops on an empty shard: ' + ex.viewState().message,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createEbookExport renews and retries empty shards and explains how to recover', async () => {
    const readerHtml =
        '<script>window.__INITIAL_STATE__ =' +
        ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
    const catalog = JSON.stringify({
        data: [
            {
                bookId: '43208843',
                updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }],
            },
        ],
    });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (init.method === 'POST' && u.includes('renewal')) {
            calls.push('renewal');
            return new Response('{"succ":1}');
        }
        if (init.method === 'POST' && u.includes('e_0')) {
            calls.push('e_0');
            return new Response('{}');
        }
        if (init.method === 'POST' && u.includes('chapterInfos')) {
            calls.push('catalog');
            return new Response(catalog);
        }
        calls.push('other');
        return new Response(readerHtml);
    };
    try {
        const ex = createEbookExport({
            win: {
                location: {
                    href: 'https://weread.qq.com/web/reader/abc',
                    pathname: '/web/reader/abc',
                },
            },
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            resourceDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1],
        });
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(calls.filter((c) => c === 'e_0').length, 3, 'e_0 is requested three times');
        assert.equal(
            calls.filter((c) => c === 'renewal').length,
            2,
            'the session is renewed before each retry',
        );
        assert.ok(
            ex
                .viewState()
                .message.includes(
                    'Your session may have expired or WeRead may be limiting requests',
                ),
            'the error explains how to recover: ' + ex.viewState().message,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createEbookExport reports non-JSON chapterInfos responses', async () => {
    const readerHtml =
        '<script>window.__INITIAL_STATE__ =' +
        ' {"reader":{"bookInfo":{"bookId":"43208843","title":"Test Book"},"psvts":"ps"}};(function(){});</script>';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && String(url).includes('chapterInfos')) {
            return new Response('<html>Blocked by gateway</html>');
        }
        return new Response(readerHtml);
    };
    try {
        const ex = createEbookExport({
            win: {
                location: {
                    href: 'https://weread.qq.com/web/reader/abc',
                    pathname: '/web/reader/abc',
                },
            },
            chapterDelayMs: () => 0,
            shardDelayMs: () => 0,
            emptyRetryDelaysMs: [1, 1],
        });
        ex.toggle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(
            ex.viewState().message.includes('Could not parse the chapterInfos response'),
            'error message: ' + ex.viewState().message,
        );
        assert.doesNotMatch(ex.viewState().message, /Blocked by gateway/);
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

test(
    'cancelling during shard backoff finishes without renewing the session',
    { timeout: 1500 },
    async (t) => {
        const readerHtml =
            '<script>window.__INITIAL_STATE__ = ' +
            '{"reader":{"bookInfo":{"bookId":"42","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
        const catalog = JSON.stringify({
            data: [
                {
                    bookId: '42',
                    updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }],
                },
            ],
        });
        const calls: string[] = [];
        const firstShard = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        t.mock.method(globalThis, 'fetch', async (url: string) => {
            calls.push(url);
            if (url.endsWith('/e_0')) {
                firstShard.resolve();
                return new Response('{}');
            }
            return new Response(url.endsWith('/chapterInfos') ? catalog : readerHtml);
        });

        const exporter = createEbookExport({
            win: {
                location: {
                    href: 'https://weread.qq.com/web/reader/42',
                    pathname: '/web/reader/42',
                },
            },
            emptyRetryDelaysMs: [1000],
            onStateChange: () => {
                if (!exporter.viewState().running) finished.resolve();
            },
        });
        exporter.toggle();
        await firstShard.promise;
        await new Promise((resolve) => setImmediate(resolve));
        exporter.toggle();
        await finished.promise;
        assert.equal(exporter.viewState().message, 'Export cancelled');
        assert.equal(calls.length, 3);
        assert.ok(calls.at(-1)?.endsWith('/e_0'));
    },
);

for (const step of ['reader request', 'chapter response body']) {
    test(
        'timeouts abort the ' + step + ' and leave the download available',
        { timeout: 1500 },
        async (t) => {
            const readerURL = 'https://weread.qq.com/web/reader/42';
            const readerHtml =
                '<script>window.__INITIAL_STATE__ = ' +
                '{"reader":{"bookInfo":{"bookId":"42","title":"Test Book"},"psvts":"ps-token"}};(function(){});</script>';
            const catalog = JSON.stringify({
                data: [
                    {
                        bookId: '42',
                        updated: [{ chapterUid: 1, title: 'Chapter One', wordCount: 100 }],
                    },
                ],
            });
            const finished =
                Promise.withResolvers<
                    ReturnType<ReturnType<typeof createEbookExport>['viewState']>
                >();
            const pendingSignals: AbortSignal[] = [];
            function waitForAbort(signal: AbortSignal) {
                pendingSignals.push(signal);
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            t.mock.method(
                globalThis,
                'fetch',
                async (url: string, { signal }: { signal: AbortSignal }) => {
                    if (url === readerURL) {
                        if (step === 'reader request') return waitForAbort(signal);
                        return new Response(readerHtml);
                    }
                    if (url.endsWith('/chapterInfos')) return new Response(catalog);
                    assert.ok(url.endsWith('/e_0'));
                    pendingSignals.push(signal);
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode('first chunk'));
                            },
                        }),
                    );
                },
            );

            const exporter = createEbookExport({
                win: { location: { href: readerURL, pathname: '/web/reader/42' } },
                requestTimeoutMs: 30,
                onStateChange: () => {
                    if (!exporter.viewState().running) finished.resolve(exporter.viewState());
                },
            });
            exporter.toggle();
            const keepAlive = setTimeout(() => {}, 1500);
            const result = await finished.promise.finally(() => clearTimeout(keepAlive));
            assert.equal(pendingSignals[0]?.aborted, true);
            assert.equal(result.disabled, false);
            assert.equal(result.stage, 'failed');
            assert.equal(result.done, 0);
            assert.equal(result.total, step === 'reader request' ? 0 : 1);
            assert.match(result.message, /did not respond in time.*Retry download/);
        },
    );
}

test('ZIP rejects overflow and respects cancellation', async () => {
    const entry = { name: 'mimetype', data: new Uint8Array() };
    await assert.rejects(
        buildZip(
            Array.from({ length: 65535 }, () => entry),
            Date.now(),
        ),
        /Too many files/,
    );
    await assert.rejects(
        buildZip([{ ...entry, name: 'a'.repeat(65536) }], Date.now()),
        /ZIP size limit/,
    );
    await assert.rejects(buildZip([entry], Date.now(), AbortSignal.abort()), {
        name: 'AbortError',
    });
});

test('ZIP rejects duplicate and unsafe paths before writing an archive', async () => {
    const entry = { name: 'a.txt', data: new Uint8Array() };
    await assert.rejects(buildZip([entry, entry], Date.now()), /Duplicate ZIP entry/);
    for (const name of ['../x', 'a/../../x', '/x', 'a\\b', 'c:x', 'a//b']) {
        await assert.rejects(buildZip([{ ...entry, name }], Date.now()), /Invalid ZIP entry/);
    }
});

test('filenames handle reserved names, extensions, and Unicode byte boundaries', () => {
    assert.equal(sanitizeFilename('CON.epub'), '_CON');
    assert.equal(sanitizeFilename('COM1 .note'), '_COM1 .note');
    assert.equal(sanitizeFilename('Name...  '), 'Name');
    assert.equal(sanitizeFilename('Name.EPUB.epub'), 'Name');
    const long = sanitizeFilename('\u{1f4d6}'.repeat(100));
    assert.equal(Buffer.byteLength(long), 248);
    assert.equal(Array.from(long).length, 62);
});

test('ZIP cancels while compressing a large entry', async () => {
    const job = new AbortController();
    const bytes = new Uint8Array(24 * 1024 * 1024);
    const archive = buildZip([{ name: 'chapter.xhtml', data: bytes }], Date.now(), job.signal);
    setImmediate(() => job.abort());
    await assert.rejects(archive, { name: 'AbortError' });
});

test('access errors distinguish signing in from book permission without exposing response details', async (t) => {
    const exporter = createWeReadClient(new AbortController().signal, 1000, [], () => 0);
    let status = 401;
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('private response text', { status }),
    );
    await assert.rejects(
        exporter.reader('https://weread.qq.com/web/reader/sample'),
        (error: unknown) =>
            error instanceof Error &&
            /session expired/.test(error.message) &&
            !error.message.includes('private response text'),
    );
    status = 403;
    await assert.rejects(
        exporter.reader('https://weread.qq.com/web/reader/sample'),
        (error: unknown) =>
            error instanceof Error &&
            /denied access/.test(error.message) &&
            !error.message.includes('private response text'),
    );
});

test('stylesheet requests distinguish empty styles, retrieval failures, bad checksums and cancellation', async (t) => {
    const controller = new AbortController();
    const client = createWeReadClient(controller.signal, 1000, [], () => 0);
    const book = { bookId: '42', title: 'Test', author: '', psvts: '1' };
    const chapter = { chapterUid: 1 };
    let response = new Response('');
    t.mock.method(globalThis, 'fetch', async () => response);
    assert.deepEqual(await client.css(book, chapter), { status: 'ok', css: '' });
    response = new Response('private response', { status: 503 });
    assert.deepEqual(await client.css(book, chapter), { status: 'request' });
    response = new Response('x'.repeat(33));
    assert.deepEqual(await client.css(book, chapter), { status: 'decode' });
    controller.abort();
    await assert.rejects(client.css(book, chapter), { name: 'AbortError' });
});
