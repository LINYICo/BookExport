(() => {
    let panel;
    let openingPanel = false;
    let readerPath = location.pathname;
    let exporter;
    let pendingDownload;

    async function fetchAsset(url, signal) {
        signal.throwIfAborted();
        const port = chrome.runtime.connect({ name: 'book-image' });
        let cancel;
        try {
            const response = await new Promise((resolve, reject) => {
                cancel = () => reject(signal.reason);
                signal.addEventListener('abort', cancel, { once: true });
                port.onMessage.addListener(resolve);
                port.onDisconnect.addListener(() => {
                    reject(new Error(chrome.runtime.lastError?.message || 'Image connection closed'));
                });
                port.postMessage(url);
            });
            if (!response.ok) throw new Error(response.error);
            return Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0));
        } finally {
            if (cancel) signal.removeEventListener('abort', cancel);
            port.disconnect();
        }
    }

    function viewState() {
        return {
            available: readerPath.startsWith('/web/reader/'),
            bookTitle: document.title.replace(/\s*[-–—|｜]\s*\u5fae\u4fe1\u8bfb\u4e66\s*$/, '').trim(),
            ...exporter?.viewState()
        };
    }

    function publish() {
        panel?.render(viewState());
    }

    async function toggleDownload() {
        if (!viewState().available) return;
        if (exporter) {
            exporter.toggle();
            return;
        }
        if (pendingDownload) return;

        const request = {};
        pendingDownload = request;
        try {
            const { createEbookExport } = await import(chrome.runtime.getURL('lib/epub-export.js'));
            if (pendingDownload !== request) return;
            exporter = createEbookExport({ doc: document, win: window, fetchAsset, onStateChange: publish });
            exporter.toggle();
        } catch (error) {
            panel?.render({ ...viewState(), message: 'Refresh the reader and try again.' });
            console.error('[BookExport] Could not load the exporter', error);
        } finally {
            if (pendingDownload === request) pendingDownload = undefined;
        }
    }

    async function togglePanel() {
        if (openingPanel) return;
        openingPanel = true;
        try {
            if (!panel) {
                const { createDownloadPanel } = await import(chrome.runtime.getURL('popup.js'));
                panel = await createDownloadPanel({ onDownload: toggleDownload });
            }
            publish();
            panel.toggle();
        } catch (error) {
            console.error('[BookExport] Could not open the download panel', error);
        } finally {
            openingPanel = false;
        }
    }

    chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.id === chrome.runtime.id && message?.type === 'TOGGLE_DOWNLOAD_PANEL') {
            togglePanel();
        }
    });

    window.navigation.addEventListener('currententrychange', () => {
        if (readerPath === location.pathname) return;
        panel?.close(false);
        const previous = exporter;
        readerPath = location.pathname;
        exporter = undefined;
        pendingDownload = undefined;
        if (previous?.viewState().running) previous.toggle();
        publish();
    });
})();
