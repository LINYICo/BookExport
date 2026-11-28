import { buildContentParams, decodeContentShards, decodeStyleShard } from './protocol.ts';

export interface Chapter {
    chapterUid: string | number;
    title?: string;
    wordCount?: number | string;
}
export interface Book {
    bookId: string;
    title: string;
    author: string;
    psvts: string;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value))
        : {};
}

export function extractInitialState(html: string): unknown {
    const json = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function/)?.[1];
    if (!json)
        throw new Error(
            'Could not find __INITIAL_STATE__ in the reader HTML. The page layout may have changed.',
        );
    try {
        return JSON.parse(json);
    } catch (error) {
        throw new Error('Could not parse __INITIAL_STATE__: ' + error);
    }
}

export function parseReaderState(state: unknown): Book {
    const reader = record(record(state).reader);
    const info = record(reader.bookInfo);
    const bookId = String(info.bookId || '');
    if (!bookId)
        throw new Error('Missing reader.bookInfo.bookId. Open a book in the WeRead reader.');
    return {
        bookId,
        title: typeof info.title === 'string' && info.title ? info.title : bookId,
        author: typeof info.author === 'string' ? info.author : '',
        psvts: typeof reader.psvts === 'string' ? reader.psvts : '',
    };
}

function isChapter(value: unknown): value is Chapter {
    const item = record(value);
    return (
        !!item.chapterUid &&
        (typeof item.chapterUid === 'string' || typeof item.chapterUid === 'number') &&
        (item.title === undefined || typeof item.title === 'string') &&
        (item.wordCount === undefined ||
            typeof item.wordCount === 'number' ||
            typeof item.wordCount === 'string')
    );
}

export function normalizeCatalog(payload: unknown, bookId: string): Chapter[] {
    if (!payload || typeof payload !== 'object')
        throw new Error('Unexpected chapterInfos response format');
    const data = record(payload);
    const candidates: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray(data.data)
          ? data.data
          : Array.isArray(data.books)
            ? data.books
            : [payload];
    for (const candidate of candidates) {
        const item = record(candidate);
        if (String(item.bookId || record(item.book).bookId || '') !== bookId) continue;
        const chapters = item.updated ?? item.chapterInfos ?? item.chapters ?? [];
        if (!Array.isArray(chapters)) throw new Error('Unexpected chapterInfos response format');
        return chapters.filter(isChapter);
    }
    throw new Error('No catalog found for book ID ' + bookId);
}

export function selectExportableChapters(chapters: Chapter[]) {
    return chapters.filter((ch) => Number(ch.wordCount || 0) > 0 && ch.title !== '\u5c01\u9762');
}

export function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
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

class ShardError extends Error {
    kind: 'empty' | 'auth';
    constructor(message: string, kind: 'empty' | 'auth') {
        super(message);
        this.kind = kind;
    }
}

export function createWeReadClient(
    signal: AbortSignal,
    requestTimeoutMs: number,
    retryDelays: number[],
    shardDelay: () => number,
) {
    async function request(url: string, body?: object) {
        const deadline = AbortSignal.timeout(requestTimeoutMs);
        const requestSignal = AbortSignal.any([signal, deadline]);
        const options: RequestInit = { signal: requestSignal };
        if (body) {
            options.method = 'POST';
            options.headers = { 'Content-Type': 'application/json;charset=UTF-8' };
            options.body = JSON.stringify(body);
        }
        try {
            const response = await fetch(url, options);
            if (!response.ok)
                throw new Error('WeRead request failed with HTTP ' + response.status + ': ' + url);
            return await response.text();
        } catch (error) {
            signal.throwIfAborted();
            if (deadline.aborted)
                throw new Error(
                    'WeRead did not respond in time. Click Download EPUB to try again.',
                );
            throw error;
        }
    }

    async function shard(path: string, body: object) {
        const text = await request(path, body);
        if (text === '{}') throw new ShardError('returned an empty response', 'empty');
        if (text.includes('"errcode"')) {
            let code = '';
            try {
                code = String(record(JSON.parse(text)).errcode || '');
            } catch {
                /* Report the raw response. */
            }
            if (code === '-2012') throw new ShardError('Session expired (-2012)', 'auth');
            throw new Error('API error' + (code ? ' ' + code : '') + ': ' + text.slice(0, 120));
        }
        return text;
    }

    async function chapterShard(path: string, params: object) {
        let failure: ShardError | undefined;
        for (const delay of [0, ...retryDelays]) {
            if (failure) {
                await wait(delay, signal);
                try {
                    await request('/web/login/renewal', { rq: '%2Fweb%2Fbook%2Fread', ql: false });
                } catch {
                    signal.throwIfAborted();
                }
            }
            try {
                return await shard(path, params);
            } catch (error) {
                if (!(error instanceof ShardError)) throw error;
                failure = error;
            }
        }
        if (failure?.kind === 'auth')
            throw new Error(path + ' ' + failure.message + '. Refresh the page and sign in again.');
        throw new Error(
            path +
                ' returned an empty response after ' +
                retryDelays.length +
                ' retries. Your session may have expired or WeRead may be limiting requests. Refresh the page, sign in again, and retry in a few minutes.',
        );
    }

    function params(book: Book, chapter: Chapter, style = false) {
        return buildContentParams({
            bookId: book.bookId,
            chapterUid: chapter.chapterUid,
            psvts: book.psvts,
            now: Date.now(),
            random: Math.random(),
            style,
        });
    }

    return {
        async reader(url: string) {
            return parseReaderState(extractInitialState(await request(url)));
        },
        async catalog(bookId: string) {
            const text = await request('/web/book/chapterInfos', { bookIds: [bookId] });
            let payload: unknown;
            try {
                payload = JSON.parse(text);
            } catch {
                throw new Error('Could not parse the chapterInfos response: ' + text.slice(0, 120));
            }
            return selectExportableChapters(normalizeCatalog(payload, bookId));
        },
        async chapter(book: Book, chapter: Chapter) {
            const first = await chapterShard('/web/book/chapter/e_0', params(book, chapter));
            if (first.startsWith('{') && first.includes('"bookId"'))
                throw new Error('Export is unavailable for TXT-format web novels.');
            await wait(shardDelay(), signal);
            const second = await chapterShard('/web/book/chapter/e_1', params(book, chapter));
            await wait(shardDelay(), signal);
            const last = await chapterShard('/web/book/chapter/e_3', params(book, chapter));
            return decodeContentShards(first, second, last);
        },
        async css(book: Book, chapter: Chapter) {
            try {
                return decodeStyleShard(
                    await shard('/web/book/chapter/e_2', params(book, chapter, true)),
                );
            } catch {
                signal.throwIfAborted();
                return '';
            }
        },
    };
}
