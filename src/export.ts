import { createAssetQueue } from './assets.ts';
import { buildEpub, sanitizeFilename, type EpubChapter } from './epub/builder.ts';
import {
    chapterIndex,
    chapterResources,
    parseChapter,
    rewriteChapterLinks,
    rewriteCss,
    type ChapterDocument,
} from './epub/document.ts';
import { type FetchAsset } from './resource.ts';
import { createWeReadClient, wait } from './weread/client.ts';

type State =
    | {
          stage:
              | 'idle'
              | 'preparing'
              | 'images'
              | 'packaging'
              | 'completed'
              | 'cancelled'
              | 'failed';
          message: string;
      }
    | { stage: 'chapters'; message: string; done: number; total: number };

interface Options {
    win: { location: Pick<Location, 'href' | 'pathname'> };
    onStateChange?: () => void;
    chapterDelayMs?: () => number;
    shardDelayMs?: () => number;
    imageDelayMs?: () => number;
    imageConcurrency?: number;
    emptyRetryDelaysMs?: number[];
    requestTimeoutMs?: number;
    fetchAsset?: FetchAsset;
}

export function createEbookExport({
    win,
    onStateChange = () => {},
    chapterDelayMs = () => 2000 + Math.floor(Math.random() * 2000),
    shardDelayMs = () => 200 + Math.floor(Math.random() * 200),
    imageDelayMs = () => 300 + Math.floor(Math.random() * 200),
    imageConcurrency = 4,
    emptyRetryDelaysMs = [3000, 8000],
    requestTimeoutMs = 20000,
    fetchAsset = async () => ({ status: 'unavailable' }),
}: Options) {
    let state: State = { stage: 'idle', message: '' };
    let controller: AbortController | undefined;
    const available = () => win.location.pathname.startsWith('/web/reader/');

    function update(next: State) {
        state = next;
        onStateChange();
    }

    function viewState() {
        const running = controller !== undefined;
        const message = controller?.signal.aborted ? 'Cancelling download…' : state.message;
        return {
            running,
            disabled: running ? !!controller?.signal.aborted : !available(),
            done: state.stage === 'chapters' ? state.done : 0,
            total: state.stage === 'chapters' ? state.total : 0,
            chapterProgress: state.stage === 'chapters',
            message,
            title: message || 'Save a personal copy of this book as an EPUB',
        };
    }

    async function run(job: AbortController) {
        const { signal } = job;
        const readerUrl = win.location.href;
        const client = createWeReadClient(
            signal,
            requestTimeoutMs,
            emptyRetryDelaysMs,
            shardDelayMs,
        );
        const queue = createAssetQueue(fetchAsset, signal, imageDelayMs, {
            concurrency: imageConcurrency,
        });
        let where = '';
        update({ stage: 'preparing', message: 'Preparing download…' });

        try {
            const book = await client.reader(readerUrl);
            if (!book.psvts)
                throw new Error('Missing psvts token. Refresh the reader page and try again.');
            const catalog = await client.catalog(book.bookId);
            if (!catalog.length) throw new Error('No chapters are available to export.');
            const chapters: ChapterDocument[] = [];
            let serializer: XMLSerializer | undefined;
            const parentIndices = new Map<string, number>();
            let retainedText = 0;
            let css = '';
            let cssBase = readerUrl;
            const chapterProgress = () =>
                update({
                    stage: 'chapters',
                    done: chapters.length,
                    total: catalog.length,
                    message:
                        'Downloading chapters (' + chapters.length + ' of ' + catalog.length + ')',
                });
            chapterProgress();
            for (const chapter of catalog) {
                signal.throwIfAborted();
                const done = chapters.length;
                if (done > 0) {
                    await wait(chapterDelayMs(), signal);
                    try {
                        const fresh = await client.reader(readerUrl);
                        if (fresh.bookId === book.bookId && fresh.psvts) book.psvts = fresh.psvts;
                    } catch {
                        signal.throwIfAborted();
                    }
                }
                where = chapter.title ? '"' + chapter.title + '": ' : '';
                const source = await client.chapter(book, chapter);
                serializer ??= new XMLSerializer();
                const { body, ...parsed } = parseChapter(source, readerUrl, chapter.href);
                const references: string[] = [];
                chapterResources(body, parsed.embeddedCss, (value) => {
                    references.push(value);
                    return value;
                });
                const markup = serializer.serializeToString(body);
                retainedText += (markup.length + parsed.embeddedCss.length) * 2;
                if (retainedText > 96 * 1024 * 1024)
                    throw new Error('The book text exceeds the export size limit.');
                chapters.push({
                    ...parsed,
                    title: chapter.title || String(chapter.chapterUid),
                    markup,
                    anchors: new Set([
                        body.id,
                        ...Array.from(body.querySelectorAll('[id]'), (node) => node.id),
                    ]),
                });
                parentIndices.set(String(chapter.chapterUid), done);
                await queue.add(references, parsed.base);
                chapterProgress();
                if (!css) {
                    css = await client.css(book, chapter);
                    cssBase = parsed.base;
                    const styles: string[] = [];
                    rewriteCss(css, (value) => {
                        styles.push(value);
                        return value;
                    });
                    await queue.add(styles, cssBase);
                }
            }

            await scheduler.yield();
            signal.throwIfAborted();
            where = '';
            update({ stage: 'images', message: 'Finishing resource downloads…' });
            await queue.drain();
            signal.throwIfAborted();

            update({ stage: 'packaging', message: 'Packaging EPUB…' });
            const parser = new DOMParser();
            const outputSerializer = serializer ?? new XMLSerializer();
            const documents = chapterIndex(chapters);
            const completed: EpubChapter[] = [];
            for (const [index, chapter] of chapters.entries()) {
                signal.throwIfAborted();
                const body = parser.parseFromString(
                    chapter.markup,
                    'application/xhtml+xml',
                ).documentElement;
                if (body.localName !== 'body') throw new Error('Could not prepare chapter XHTML.');
                rewriteChapterLinks(body, index, chapters, documents);
                const embeddedCss = chapterResources(
                    body,
                    chapter.embeddedCss,
                    (value, imageOnly) => queue.path(value, chapter.base, imageOnly),
                    true,
                );
                const attributes = Object.fromEntries(
                    Array.from(body.attributes, ({ name, value }) => [name, value]),
                );
                const first = body.firstElementChild;
                const hasHeading =
                    !!first &&
                    /^h[1-6]$/.test(first.localName) &&
                    first.textContent.trim() === chapter.title.trim();
                const source = Array.from(body.childNodes, (node) =>
                    outputSerializer.serializeToString(node),
                ).join('');
                const parent = parentIndices.get(String(catalog[index]?.parentChapterUid ?? ''));
                completed.push({
                    title: chapter.title,
                    source,
                    properties: chapter.properties,
                    embeddedCss,
                    attributes,
                    hasHeading,
                    ...(chapter.language ? { language: chapter.language } : {}),
                    ...(parent !== undefined && parent < index ? { parent } : {}),
                });
                chapter.markup = '';
                if (index % 16 === 0) await scheduler.yield();
            }
            css = rewriteCss(css, (value) => queue.path(value, cssBase));
            const { assets, unavailable } = queue.result();
            const archive = await buildEpub({
                title: book.title,
                author: book.author,
                language: book.language ?? 'und',
                css,
                signal,
                assets,
                now: Date.now(),
                chapters: completed,
            });
            signal.throwIfAborted();
            const url = URL.createObjectURL(archive);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = sanitizeFilename(book.title) + '.epub';
            try {
                document.body.append(anchor);
                anchor.click();
            } finally {
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
            }
            state = {
                stage: 'completed',
                message:
                    'EPUB sent to browser downloads. Chapters: ' +
                    chapters.length +
                    '. Resources: ' +
                    assets.length +
                    '.' +
                    (unavailable ? ' ' + unavailable + ' resources unavailable.' : ''),
            };
        } catch (error) {
            state = signal.aborted
                ? { stage: 'cancelled', message: 'Export cancelled' }
                : {
                      stage: 'failed',
                      message:
                          'Export failed: ' +
                          where +
                          (error instanceof Error ? error.message : String(error)),
                  };
        } finally {
            job.abort();
            await queue.drain();
            controller = undefined;
            onStateChange();
        }
    }

    function toggle() {
        if (controller) {
            controller.abort();
            onStateChange();
        } else if (available()) {
            controller = new AbortController();
            void run(controller);
        }
    }

    return { toggle, viewState };
}
