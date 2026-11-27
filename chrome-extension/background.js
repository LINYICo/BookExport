// The service worker downloads chapter images and returns their bytes as Base64.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== 'FETCH_ASSET' || sender.origin !== 'https://weread.qq.com') return;

    fetchAssetBase64(request.url)
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
});

async function fetchAssetBase64(url) {
    if (typeof url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*weread\.qq\.com\//.test(url)) {
        throw new Error('Only weread.qq.com assets are supported');
    }

    const response = await fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Image request failed with HTTP ' + response.status);

    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
