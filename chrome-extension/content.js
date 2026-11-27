(() => {
    const panel = document.createElement('div');
    panel.id = 'greenflame-export';
    panel.lang = 'en';

    const button = document.createElement('button');
    button.type = 'button';

    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    panel.append(button, status);

    let exporter;
    let loading = false;
    let readerPath = '';

    async function fetchAsset(url) {
        const response = await chrome.runtime.sendMessage({ type: 'FETCH_ASSET', url });
        if (!response?.ok) throw new Error(response?.error || 'Could not download the image');
        return Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0));
    }

    function refresh() {
        const view = exporter.viewState();
        button.disabled = view.disabled;
        button.textContent = view.label;
        button.title = view.title;
        status.textContent = view.message;
    }

    async function toggleExport() {
        if (exporter) {
            exporter.toggle();
            return;
        }
        if (loading) return;

        loading = true;
        button.disabled = true;
        status.textContent = 'Loading exporter…';
        const path = readerPath;
        try {
            const { createEbookExport } = await import(chrome.runtime.getURL('lib/epub-export.js'));
            exporter = createEbookExport({ doc: document, win: window, fetchAsset, onStateChange: refresh });
            refresh();
            if (readerPath === path) exporter.toggle();
        } catch (error) {
            status.textContent = 'Could not load the exporter. Refresh the reader page and try again.';
            console.error('[Greenflame] Could not load the exporter', error);
        } finally {
            loading = false;
            if (!exporter) button.disabled = false;
        }
    }

    function updateReader() {
        const path = location.pathname;
        if (path === readerPath) return;
        if (exporter?.viewState().running) exporter.toggle();

        readerPath = path;
        if (!path.startsWith('/web/reader/')) {
            panel.remove();
            return;
        }

        document.body.append(panel);
        if (exporter) {
            refresh();
        } else {
            button.textContent = 'Export book';
        }
    }

    button.addEventListener('click', toggleExport);
    window.navigation.addEventListener('currententrychange', updateReader);
    updateReader();
})();
