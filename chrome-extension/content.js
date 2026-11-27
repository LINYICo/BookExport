(() => {
    const ports = new Set();
    let readerPath = location.pathname;
    let exporter;
    let pendingDownload;

    async function fetchAsset(url) {
        const response = await chrome.runtime.sendMessage({ type: 'FETCH_ASSET', url });
        if (!response?.ok) throw new Error(response?.error || 'Could not download the image');
        return Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0));
    }

    function viewState() {
        return {
            available: readerPath.startsWith('/web/reader/'),
            bookTitle: document.title,
            ...exporter?.viewState()
        };
    }

    function publish() {
        const state = viewState();
        for (const port of ports) {
            try {
                port.postMessage(state);
            } catch {
                ports.delete(port);
            }
        }
    }

    async function toggleDownload(port) {
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
            if (ports.has(port)) {
                port.postMessage({ ...viewState(), message: 'Refresh the reader and try again.' });
            }
            console.error('[BookExport] Could not load the exporter', error);
        } finally {
            if (pendingDownload === request) pendingDownload = undefined;
        }
    }

    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== 'book-download') return;
        ports.add(port);
        port.onDisconnect.addListener(() => ports.delete(port));
        port.onMessage.addListener((message) => {
            if (message === 'toggle-download') toggleDownload(port);
        });
        port.postMessage(viewState());
    });

    window.navigation.addEventListener('currententrychange', () => {
        if (readerPath === location.pathname) return;
        const previous = exporter;
        readerPath = location.pathname;
        exporter = undefined;
        pendingDownload = undefined;
        if (previous?.viewState().running) previous.toggle();
        publish();
    });
})();
