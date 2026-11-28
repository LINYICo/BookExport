const readerOrigin = 'https://weread.qq.com';
const imageLimit = 16 * 1024 * 1024;

function toggleDownloadPanel(tab: chrome.tabs.Tab) {
    if (tab.id == null || !tab.url?.startsWith(readerOrigin + '/')) return;
    return chrome.tabs
        .sendMessage(tab.id, { type: 'TOGGLE_DOWNLOAD_PANEL' }, { frameId: 0 })
        .catch((error: unknown) =>
            console.debug('[BookExport] Could not open the download panel', error),
        );
}

chrome.action.onClicked.addListener(toggleDownloadPanel);

function imageURL(value: string, allowRedirectHosts = false) {
    const url = new URL(value);
    const hosts = allowRedirectHosts
        ? ['weread.qq.com', 'tencent-cloud.com', 'myqcloud.com']
        : ['weread.qq.com'];
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !hosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
    ) {
        throw new Error('Unsupported image address');
    }
    return url;
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'book-image' || port.sender?.origin !== readerOrigin) return;
    const disconnect = new AbortController();
    port.onDisconnect.addListener(() => disconnect.abort());

    async function download(message: unknown) {
        port.onMessage.removeListener(download);
        const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(15000)]);
        try {
            if (typeof message !== 'string') throw new Error('Invalid image address');
            const response = await fetch(imageURL(message), { credentials: 'omit', signal });
            if (!response.ok) throw new Error('Image request failed with HTTP ' + response.status);
            imageURL(response.url, true);
            if (!response.body || Number(response.headers.get('content-length')) > imageLimit) {
                throw new Error('Image exceeds the size limit');
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let size = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.length;
                    if (size > imageLimit) throw new Error('Image exceeds the size limit');
                    chunks.push(chunk.value);
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            const data = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
            }
            if (!disconnect.signal.aborted) port.postMessage({ data });
        } catch (error) {
            if (!disconnect.signal.aborted)
                port.postMessage({ error: error instanceof Error ? error.message : String(error) });
        }
    }
    port.onMessage.addListener(download);
});
