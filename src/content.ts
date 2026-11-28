import { createEbookExport } from './export.ts';
import { isResourceResponse, type FetchAsset, type ResourceResponse } from './resource.ts';
import { createDownloadPanel } from './ui/panel.ts';

const readerKey = () => location.pathname + location.search;
let readerPath = readerKey();
let panel: ReturnType<typeof createDownloadPanel> | undefined;
let exporter: ReturnType<typeof createEbookExport> | undefined;

const fetchAsset: FetchAsset = async (url, limit, signal) => {
    signal.throwIfAborted();
    const port = chrome.runtime.connect({ name: 'book-image' });
    let cancel: (() => void) | undefined;
    try {
        return await new Promise<ResourceResponse>((resolve, reject) => {
            cancel = () => reject(signal.reason);
            signal.addEventListener('abort', cancel, { once: true });
            port.onMessage.addListener((response: unknown) => {
                if (isResourceResponse(response)) resolve(response);
                else resolve({ status: 'unavailable' });
            });
            port.onDisconnect.addListener(() => {
                void chrome.runtime.lastError;
                resolve({ status: 'unavailable' });
            });
            port.postMessage({ url, limit });
        });
    } finally {
        if (cancel) signal.removeEventListener('abort', cancel);
        port.disconnect();
    }
};

function publish() {
    panel?.render({
        available: readerPath.startsWith('/web/reader/'),
        bookTitle: document.title.replace(/\s*[-–—|｜]\s*\u5fae\u4fe1\u8bfb\u4e66\s*$/, '').trim(),
        ...exporter?.viewState(),
    });
}

chrome.runtime.onMessage.addListener((message: { type?: string }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'TOGGLE_DOWNLOAD_PANEL') return;
    panel ??= createDownloadPanel(() => {
        if (!exporter) {
            const task = createEbookExport({
                win: window,
                fetchAsset,
                onStateChange: () => {
                    if (exporter === task) publish();
                },
            });
            exporter = task;
        }
        exporter.toggle();
    });
    if (panel.toggle()) exporter = undefined;
    publish();
});

window.navigation.addEventListener('currententrychange', () => {
    if (readerPath === readerKey()) return;
    panel?.close();
    const previous = exporter;
    readerPath = readerKey();
    exporter = undefined;
    if (previous?.viewState().running) previous.toggle();
    publish();
});
