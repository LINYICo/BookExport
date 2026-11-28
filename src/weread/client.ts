import { languageTag } from '../epub/document.ts';
import { ByteLimitError, readBounded } from '../io.ts';
import { buildContentParams, decodeContentShards, decodeStyleShard } from './protocol.ts';

export interface Chapter {
    chapterUid: string | number;
    title?: string;
    wordCount?: number | string;
    href?: string;
    parentChapterUid?: string;
    sections?: { id: number; title: string }[];
}
export class ExportError extends Error {}

export interface Book {
    bookId: string;
    title: string;
    author: string;
    psvts: string;
    language?: string;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value))
        : {};
}

export function extractInitialState(html: string): unknown {
    const json = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function/)?.[1];
    if (!json)
        throw new ExportError('WeRead did not provide book details. Refresh the reader and retry.');
    try {
        return JSON.parse(json);
    } catch {
        throw new ExportError(
            'WeRead returned invalid book details. Refresh the reader and retry.',
        );
    }
}

export function parseReaderState(state: unknown): Book {
    const reader = record(record(state).reader);
    const info = record(reader.bookInfo);
    const bookId = String(info.bookId || '');
    if (!bookId) throw new ExportError('Open a book in the WeRead reader and retry.');
    const language = languageTag(info.language ?? info.lang);
    return {
        bookId,
        ...(language ? { language } : {}),
        title: typeof info.title === 'string' && info.title ? info.title : bookId,
        author: typeof info.author === 'string' ? info.author : '',
        psvts: typeof reader.psvts === 'string' ? reader.psvts : '',
    };
}

function isChapter(value: unknown): value is Omit<Chapter, 'href' | 'parentChapterUid'> {
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
        throw new ExportError('Unexpected chapterInfos response format');
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
        if (!Array.isArray(chapters))
            throw new ExportError('Unexpected chapterInfos response format');
        return chapters.filter(isChapter).map(({ chapterUid, title, wordCount, ...source }) => {
            const { href, parentChapterUid } = record(source);
            return {
                chapterUid,
                ...(title !== undefined ? { title } : {}),
                ...(wordCount !== undefined ? { wordCount } : {}),
                ...(typeof href === 'string' ? { href } : {}),
                ...(typeof parentChapterUid === 'string' || typeof parentChapterUid === 'number'
                    ? { parentChapterUid: String(parentChapterUid) }
                    : {}),
            };
        });
    }
    throw new ExportError(
        'WeRead did not return a catalog. Sign in and check that you can read this book, then retry.',
    );
}

function chapterId(value: string | number | undefined) {
    const raw = String(value ?? '').trim();
    const id = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function selectExportableChapters(chapters: Chapter[]) {
    const entries = new Map<number, Chapter>();
    for (const chapter of chapters) {
        const id = chapterId(chapter.chapterUid);
        if (id !== undefined && !entries.has(id) && chapter.title?.trim() !== '\u5c01\u9762')
            entries.set(id, chapter);
    }
    const parents = new Set(
        Array.from(entries.values(), ({ parentChapterUid }) => chapterId(parentChapterUid)),
    );
    const sections = new Set(
        [...entries]
            .filter(
                ([id, chapter]) =>
                    parents.has(id) && !chapter.href?.trim() && !(Number(chapter.wordCount) > 0),
            )
            .map(([id]) => id),
    );
    const result: Chapter[] = [];
    for (const [id, chapter] of entries) {
        if (sections.has(id)) continue;
        const path: NonNullable<Chapter['sections']> = [];
        const visited = new Set([id]);
        let parent = chapterId(chapter.parentChapterUid);
        while (
            parent !== undefined &&
            sections.has(parent) &&
            !visited.has(parent) &&
            visited.size < 64
        ) {
            visited.add(parent);
            const section = entries.get(parent);
            if (section?.title?.trim()) path.unshift({ id: parent, title: section.title });
            parent = chapterId(section?.parentChapterUid);
        }
        const { parentChapterUid: _parent, ...rest } = chapter;
        result.push({
            ...rest,
            ...(parent !== undefined && !visited.has(parent) && entries.has(parent)
                ? { parentChapterUid: String(parent) }
                : {}),
            ...(path.length ? { sections: path } : {}),
        });
    }
    return result;
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
        const options: RequestInit = { credentials: 'same-origin', signal: requestSignal };
        if (body) {
            options.method = 'POST';
            options.headers = { 'Content-Type': 'application/json;charset=UTF-8' };
            options.body = JSON.stringify(body);
        }
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                if (response.status === 401)
                    throw new ExportError(
                        'Your WeRead session expired. Sign in again, then retry.',
                    );
                if (response.status === 403)
                    throw new ExportError(
                        'WeRead denied access. Check that you can read this book.',
                    );

                throw new ExportError('WeRead request failed with HTTP ' + response.status + '.');
            }
            return new TextDecoder().decode(
                await readBounded(response, 16 * 1024 * 1024, requestSignal),
            );
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ByteLimitError)
                throw new ExportError('The WeRead response exceeded the size limit.');
            if (deadline.aborted)
                throw new ExportError(
                    'WeRead did not respond in time. Choose Retry download to try again.',
                );
            if (error instanceof ExportError) throw error;
            throw new ExportError('Could not reach WeRead. Check your connection and retry.');
        }
    }

    async function shard(path: string, body: object) {
        const text = await request(path, body);
        if (text === '{}') throw new ShardError('returned an empty response', 'empty');
        if (text.includes('"errcode"')) {
            let code = '';
            try {
                code = String(record(JSON.parse(text)).errcode || '');
            } catch {}
            if (code === '-2012') throw new ShardError('Session expired (-2012)', 'auth');
            throw new ExportError(
                'WeRead rejected the chapter request' +
                    (/^-?\d+$/.test(code) ? ' (' + code + ')' : '') +
                    '.',
            );
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
            throw new ExportError(
                path + ' ' + failure.message + '. Refresh the page and sign in again.',
            );
        throw new ExportError(
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
                throw new ExportError(
                    'Could not parse the chapterInfos response. Refresh the reader page and try again.',
                );
            }
            return selectExportableChapters(normalizeCatalog(payload, bookId));
        },
        async chapter(book: Book, chapter: Chapter) {
            const first = await chapterShard('/web/book/chapter/e_0', params(book, chapter));
            if (first.startsWith('{') && first.includes('"bookId"'))
                throw new ExportError('Export is unavailable for TXT-format web novels.');
            await wait(shardDelay(), signal);
            const second = await chapterShard('/web/book/chapter/e_1', params(book, chapter));
            await wait(shardDelay(), signal);
            const last = await chapterShard('/web/book/chapter/e_3', params(book, chapter));
            try {
                return decodeContentShards(first, second, last);
            } catch {
                throw new ExportError('WeRead returned invalid chapter data. Retry the download.');
            }
        },
        async css(book: Book, chapter: Chapter) {
            let text: string;
            try {
                text = await shard('/web/book/chapter/e_2', params(book, chapter, true));
            } catch {
                signal.throwIfAborted();
                return { status: 'request' } as const;
            }
            try {
                return { status: 'ok', css: decodeStyleShard(text).trim() } as const;
            } catch {
                return { status: 'decode' } as const;
            }
        },
    };
}
