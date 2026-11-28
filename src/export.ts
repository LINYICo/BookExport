import { rewriteCss, type ResolveResource } from './epub/css.ts';
import { createAssetQueue } from './assets.ts';
import { buildEpub, sanitizeFilename, type EpubChapter } from './epub/builder.ts';
import {
    chapterIndex,
    chapterResources,
    parseChapter,
    rewriteChapterLinks,
    type ChapterDocument,
} from './epub/document.ts';
import { resourceURL, type FetchAsset, type ResourceReference } from './resource.ts';
import { createWeReadClient, ExportError, wait } from './weread/client.ts';

type Stage =
    | 'idle'
    | 'preparing'
    | 'chapters'
    | 'images'
    | 'packaging'
    | 'completed'
    | 'cancelled'
    | 'failed';
type State = { stage: Stage; message: string; warning?: string };

export type ExportView = {
    stage: Stage | 'cancelling';
    running: boolean;
    disabled: boolean;
    done: number;
    total: number;
    message: string;
    warning: string;
};

interface Options {
    win: { location: Pick<Location, 'href' | 'pathname'> };
    onStateChange?: () => void;
    chapterDelayMs?: () => number;
    shardDelayMs?: () => number;
    resourceDelayMs?: () => number;
    resourceConcurrency?: number;
    emptyRetryDelaysMs?: number[];
    requestTimeoutMs?: number;
    fetchAsset?: FetchAsset;
}

// Run the same rewrite used for packaging so rejected CSS declarations and
// removed elements cannot reserve bytes. Preserve rejected references for warnings.
function discoverResources(
    base: string,
    rewrite: (resolve: ResolveResource, use: (path: string) => void) => void,
) {
    const candidates = new Map<string, ResourceReference>();
    const references: ResourceReference[] = [];
    rewrite(
        (value, kind) => {
            if (!resourceURL(value, base)) {
                references.push({ value, kind });
                return;
            }
            const path = '../candidate/' + candidates.size;
            candidates.set(path, { value, kind });
            return path;
        },
        (path) => {
            const reference = candidates.get(path);
            if (reference) references.push(reference);
        },
    );
    return references;
}

export function createEbookExport({
    win,
    onStateChange = () => {},
    chapterDelayMs = () => 2000 + Math.floor(Math.random() * 2000),
    shardDelayMs = () => 200 + Math.floor(Math.random() * 200),
    resourceDelayMs = () => 300 + Math.floor(Math.random() * 200),
    resourceConcurrency = 4,
    emptyRetryDelaysMs = [3000, 8000],
    requestTimeoutMs = 20000,
    fetchAsset = async () => ({ status: 'unavailable' }),
}: Options) {
    let state: State = { stage: 'idle', message: '' };
    let controller: AbortController | undefined;
    let done = 0;
    let total = 0;
    const available = () => win.location.pathname.startsWith('/web/reader/');

    function update(next: State) {
        state = next;
        onStateChange();
    }

    function viewState(): ExportView {
        const running = controller !== undefined;
        const stage = controller?.signal.aborted ? 'cancelling' : state.stage;
        const message = stage === 'cancelling' ? 'Cancelling download…' : state.message;
        return {
            stage,
            running,
            disabled: stage === 'cancelling' || !available(),
            done,
            total,
            message,
            warning: state.warning ?? '',
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
        const queue = createAssetQueue(fetchAsset, signal, resourceDelayMs, {
            concurrency: resourceConcurrency,
        });
        let result: State;
        done = 0;
        total = 0;
        update({ stage: 'preparing', message: 'Preparing download…' });

        try {
            const book = await client.reader(readerUrl);
            if (!book.psvts)
                throw new ExportError('Sign in to WeRead, refresh the reader page, and retry.');
            const catalog = await client.catalog(book.bookId);
            if (!catalog.length) throw new ExportError('No chapters are available to export.');
            const chapters: ChapterDocument[] = [];
            let serializer: XMLSerializer | undefined;
            const parentIndices = new Map<string, number>();
            let retainedText = 0;
            let css = '';
            let stylesheetMissing = false;
            let cssBase = readerUrl;
            total = catalog.length;
            update({ stage: 'chapters', message: 'Downloading chapters' });
            for (const chapter of catalog) {
                signal.throwIfAborted();
                if (done > 0) {
                    await wait(chapterDelayMs(), signal);
                    try {
                        const fresh = await client.reader(readerUrl);
                        if (fresh.bookId === book.bookId && fresh.psvts) book.psvts = fresh.psvts;
                    } catch {
                        signal.throwIfAborted();
                    }
                }
                const source = await client.chapter(book, chapter);
                serializer ??= new XMLSerializer();
                const { body, ...parsed } = parseChapter(source, readerUrl, chapter.href);
                if (
                    Number(chapter.wordCount) > 0 &&
                    !body.textContent.trim() &&
                    !body.querySelector('img, svg, math')
                )
                    throw new ExportError(
                        'A chapter has no exportable content. Refresh the reader and retry.',
                    );

                const markup = serializer.serializeToString(body);
                retainedText += (markup.length + parsed.embeddedCss.length) * 2;
                if (retainedText > 96 * 1024 * 1024)
                    throw new ExportError('The book text exceeds the export size limit.');
                chapters.push({
                    ...parsed,
                    title: chapter.title || String(chapter.chapterUid),
                    markup,
                    anchors: new Set([
                        body.id,
                        ...Array.from(body.querySelectorAll('[id]'), (node) => node.id),
                    ]),
                });
                parentIndices.set(String(Number(chapter.chapterUid)), done);
                done = chapters.length;
                onStateChange();
                const references = discoverResources(parsed.base, (resolve, use) =>
                    chapterResources(body, parsed.embeddedCss, resolve, use),
                );
                await queue.add(references, parsed.base);
                if (!css) {
                    const style = await client.css(book, chapter);
                    if (style.status !== 'ok') stylesheetMissing = true;
                    else if (style.css) {
                        css = style.css;
                        stylesheetMissing = false;
                    }
                    cssBase = parsed.base;
                    const styles = discoverResources(cssBase, (resolve, use) =>
                        rewriteCss(css, resolve, false, use),
                    );
                    await queue.add(styles, cssBase);
                }
            }

            await scheduler.yield();
            signal.throwIfAborted();
            update({ stage: 'images', message: 'Finishing resource downloads…' });
            await queue.drain();
            signal.throwIfAborted();

            update({ stage: 'packaging', message: 'Packaging EPUB…' });
            const parser = new DOMParser();
            await queue.recoverBudget(async (resolve, use) => {
                for (const [index, chapter] of chapters.entries()) {
                    signal.throwIfAborted();
                    const body = parser.parseFromString(
                        chapter.markup,
                        'application/xhtml+xml',
                    ).documentElement;
                    chapterResources(
                        body,
                        chapter.embeddedCss,
                        (value, kind) => resolve(value, chapter.base, kind),
                        use,
                    );
                    if (index % 16 === 0) await scheduler.yield();
                }
                rewriteCss(css, (value, kind) => resolve(value, cssBase, kind), false, use);
            });
            const outputSerializer = serializer ?? new XMLSerializer();
            const documents = chapterIndex(chapters);
            const completed: EpubChapter[] = [];
            const usedPaths = new Set<string>();
            const use = (path: string) => usedPaths.add(path);
            for (const [index, chapter] of chapters.entries()) {
                signal.throwIfAborted();
                const body = parser.parseFromString(
                    chapter.markup,
                    'application/xhtml+xml',
                ).documentElement;
                if (body.localName !== 'body') throw new Error('Could not prepare chapter XHTML.');
                const embeddedCss = chapterResources(
                    body,
                    chapter.embeddedCss,
                    (value, kind) => queue.path(value, chapter.base, kind),
                    use,
                );
                rewriteChapterLinks(body, index, chapters, documents);
                const attributes = Object.fromEntries(
                    Array.from(body.attributes, ({ name, value }) => [name, value]),
                );
                const hasHeading = Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6')).some(
                    (heading) => heading.textContent.trim() === chapter.title.trim(),
                );
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
                    ...(catalog[index]?.sections ? { sections: catalog[index].sections } : {}),
                });
                chapter.markup = '';
                if (index % 16 === 0) await scheduler.yield();
            }
            css = rewriteCss(css, (value, kind) => queue.path(value, cssBase, kind), false, use);
            const { assets, unavailable, omitted } = queue.result(usedPaths);
            queue.discardUnused(usedPaths);
            const chapterLanguages = new Set(
                chapters.map(({ language }) => language).filter(Boolean),
            );
            const language =
                book.language ??
                (chapterLanguages.size === 1 && chapters.every(({ language }) => language)
                    ? [...chapterLanguages][0]
                    : undefined) ??
                'und';
            const archive = await buildEpub({
                title: book.title,
                author: book.author,
                language,
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
            const warning = [
                stylesheetMissing ? 'The book stylesheet could not be loaded.' : '',
                unavailable ? unavailable + ' resources unavailable.' : '',
                omitted ? 'Some unsupported resource references were removed.' : '',
            ]
                .filter(Boolean)
                .join(' ');
            result = {
                stage: 'completed',
                warning,
                message:
                    'EPUB sent to browser downloads. Chapters: ' +
                    chapters.length +
                    '. Resources: ' +
                    assets.length +
                    '.' +
                    (warning ? ' ' + warning : ''),
            };
        } catch (error) {
            result = signal.aborted
                ? { stage: 'cancelled', message: 'Export cancelled' }
                : {
                      stage: 'failed',
                      message:
                          error instanceof ExportError
                              ? error.message
                              : state.stage === 'packaging'
                                ? 'Could not package the EPUB. Retry the download.'
                                : 'Could not prepare this book for export. Refresh the reader and retry.',
                  };
        } finally {
            job.abort();
            await queue.drain();
            controller = undefined;
        }
        update(result);
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
