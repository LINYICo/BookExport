(() => {
    const panel = document.createElement('div');
    panel.id = 'greenflame-export';

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
        if (!response?.ok) throw new Error(response?.error || '图片下载失败');
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
        status.textContent = '正在加载导出组件…';
        const path = readerPath;
        try {
            const { createEbookExport } = await import(chrome.runtime.getURL('lib/epub-export.js'));
            exporter = createEbookExport({ doc: document, win: window, fetchAsset, onStateChange: refresh });
            refresh();
            if (readerPath === path) exporter.toggle();
        } catch (error) {
            status.textContent = '加载失败，请刷新阅读页后重试。';
            console.error('[Greenflame] 加载导出组件失败', error);
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
            button.textContent = '导出本书';
        }
    }

    button.addEventListener('click', toggleExport);
    window.navigation.addEventListener('currententrychange', updateReader);
    updateReader();
})();
