import { downloadResource, resourceRequest } from './resource.ts';

const readerOrigin = 'https://weread.qq.com';

function toggleDownloadPanel(tab: chrome.tabs.Tab) {
    if (tab.id == null || !tab.url?.startsWith(readerOrigin + '/')) return;
    return chrome.tabs
        .sendMessage(tab.id, { type: 'TOGGLE_DOWNLOAD_PANEL' }, { frameId: 0 })
        .catch((error: unknown) =>
            console.debug('[BookExport] Could not open the download panel', error),
        );
}

chrome.action.onClicked.addListener(toggleDownloadPanel);

chrome.runtime.onConnect.addListener((port) => {
    if (
        port.name !== 'book-image' ||
        port.sender?.origin !== readerOrigin ||
        port.sender.id !== chrome.runtime.id ||
        port.sender.frameId !== 0
    )
        return;
    const disconnect = new AbortController();
    port.onDisconnect.addListener(() => disconnect.abort());

    async function download(message: unknown) {
        port.onMessage.removeListener(download);
        const request = resourceRequest(message);
        const response = request
            ? await downloadResource(request.url, request.limit, disconnect.signal)
            : { status: 'policy' };
        if (disconnect.signal.aborted) return;
        try {
            port.postMessage(response);
        } catch {
            disconnect.abort();
        }
    }
    port.onMessage.addListener(download);
});
