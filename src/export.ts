import { buildEpub, sanitizeFilename, type EpubImage } from './epub/builder.ts';
import { imageExtensionAndType, localCss, parseChapter } from './epub/document.ts';
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
    fetchAsset?: (url: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
}

const imageBudget = 128 * 1024 * 1024;

export function createEbookExport({
    win,
    onStateChange = () => {},
    chapterDelayMs = () => 2000 + Math.floor(Math.random() * 2000),
    shardDelayMs = () => 200 + Math.floor(Math.random() * 200),
    imageDelayMs = () => 300 + Math.floor(Math.random() * 200),
    imageConcurrency = 4,
    emptyRetryDelaysMs = [3000, 8000],
    requestTimeoutMs = 20000,
    fetchAsset = async () => {
        throw new Error('No image downloader is available');
    },
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
        let where = '';
        update({ stage: 'preparing', message: 'Preparing download…' });

        try {
            const book = await client.reader(readerUrl);
            if (!book.psvts)
                throw new Error('Missing psvts token. Refresh the reader page and try again.');
            const catalog = await client.catalog(book.bookId);
            if (!catalog.length) throw new Error('No chapters are available to export.');
            const chapters: { title: string; body: HTMLElement }[] = [];
            let css = '';
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
                update({
                    stage: 'chapters',
                    done,
                    total: catalog.length,
                    message: 'Downloading chapters (' + done + ' of ' + catalog.length + ')',
                });
                const source = await client.chapter(book, chapter);
                chapters.push({
                    title: chapter.title || String(chapter.chapterUid),
                    body: parseChapter(source),
                });
                if (!css) css = localCss(await client.css(book, chapter));
            }

            where = '';
            update({ stage: 'images', message: 'Finishing image downloads…' });
            const images = new Map<string, HTMLImageElement[]>();
            for (const { body } of chapters) {
                for (const image of body.querySelectorAll('img')) {
                    const src = image.getAttribute('src') ?? '';
                    const group = images.get(src);
                    if (group) group.push(image);
                    else images.set(src, [image]);
                }
            }
            const queue = [...images];
            let cursor = 0;
            let remaining = imageBudget;
            const assets: EpubImage[] = [];
            async function worker() {
                while (cursor < queue.length) {
                    signal.throwIfAborted();
                    const index = cursor++;
                    const task = queue[index];
                    if (!task) break;
                    const [src, elements] = task;
                    let href = '';
                    try {
                        if (src && remaining > 0) {
                            const data = await fetchAsset(src, signal);
                            signal.throwIfAborted();
                            const kind = imageExtensionAndType(data);
                            if (kind && data.length <= remaining) {
                                remaining -= data.length;
                                href = 'images/image_' + (index + 1) + kind.ext;
                                assets.push({ href, mediaType: kind.mediaType, data });
                            }
                        }
                    } catch {
                        signal.throwIfAborted();
                    }
                    for (const image of elements) {
                        if (href) image.setAttribute('src', '../' + href);
                        else {
                            const alt = image.getAttribute('alt');
                            image.replaceWith(alt ? '[Illustration: ' + alt + ']' : '[Image]');
                        }
                    }
                    if (cursor < queue.length) await wait(imageDelayMs(), signal);
                }
            }
            await Promise.all(
                Array.from({ length: Math.min(imageConcurrency, queue.length) }, worker),
            );

            signal.throwIfAborted();
            update({ stage: 'packaging', message: 'Packaging EPUB…' });
            const serializer = new XMLSerializer();
            const archive = await buildEpub({
                title: book.title,
                author: book.author,
                css,
                signal,
                assets,
                now: Date.now(),
                chapters: chapters.map(({ title, body }) => ({
                    title,
                    source: Array.from(body.childNodes, (node) =>
                        serializer.serializeToString(node),
                    ).join(''),
                })),
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
                    '. Images: ' +
                    assets.length,
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
