import { createEbookExport } from './export.ts';
import { createDownloadPanel } from './ui/panel.ts';

let readerPath = location.pathname;
let panel: ReturnType<typeof createDownloadPanel> | undefined;
let exporter: ReturnType<typeof createEbookExport> | undefined;

async function fetchAsset(url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const port = chrome.runtime.connect({ name: 'book-image' });
    let cancel: (() => void) | undefined;
    try {
        return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
            cancel = () => reject(signal.reason);
            signal.addEventListener('abort', cancel, { once: true });
            port.onMessage.addListener((response: { data?: unknown; error?: string }) => {
                if (
                    response?.data instanceof Uint8Array &&
                    response.data.buffer instanceof ArrayBuffer
                ) {
                    resolve(
                        new Uint8Array(
                            response.data.buffer,
                            response.data.byteOffset,
                            response.data.byteLength,
                        ),
                    );
                } else reject(new Error(response?.error || 'Invalid image response'));
            });
            port.onDisconnect.addListener(() =>
                reject(new Error(chrome.runtime.lastError?.message || 'Image connection closed')),
            );
            port.postMessage(url);
        });
    } finally {
        if (cancel) signal.removeEventListener('abort', cancel);
        port.disconnect();
    }
}

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
        exporter ??= createEbookExport({ win: window, fetchAsset, onStateChange: publish });
        exporter.toggle();
    });
    publish();
    panel.toggle();
});

window.navigation.addEventListener('currententrychange', () => {
    if (readerPath === location.pathname) return;
    panel?.close();
    const previous = exporter;
    readerPath = location.pathname;
    exporter = undefined;
    if (previous?.viewState().running) previous.toggle();
    publish();
});
