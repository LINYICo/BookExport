function toggleDownloadPanel(tab) {
    if (tab.id == null || !tab.url?.startsWith('https://weread.qq.com/')) return;
    return chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_DOWNLOAD_PANEL' }, { frameId: 0 })
        .catch((error) => console.debug('[BookExport] Could not open the download panel', error.message));
}

chrome.action.onClicked.addListener(toggleDownloadPanel);

// Disconnecting the port also cancels the image request in the service worker.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'book-image' || port.sender?.origin !== 'https://weread.qq.com') return;

    const controller = new AbortController();
    let disconnected = false;
    port.onDisconnect.addListener(() => {
        disconnected = true;
        controller.abort();
    });

    async function download(url) {
        port.onMessage.removeListener(download);
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const data = await fetchAssetBase64(url, controller.signal);
            if (!disconnected) port.postMessage({ ok: true, data });
        } catch (error) {
            if (!disconnected) port.postMessage({ ok: false, error: error.message });
        } finally {
            clearTimeout(timeout);
        }
    }

    port.onMessage.addListener(download);
});

async function fetchAssetBase64(url, signal) {
    if (typeof url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*weread\.qq\.com\//.test(url)) {
        throw new Error('Only weread.qq.com assets are supported');
    }

    const response = await fetch(url, {
        credentials: 'omit',
        signal
    });
    if (!response.ok) throw new Error('Image request failed with HTTP ' + response.status);

    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
