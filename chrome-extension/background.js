// 章节图片由扩展的 Service Worker 代理，响应使用 Base64 通过消息传回。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== 'FETCH_ASSET' || sender.origin !== 'https://weread.qq.com') return;

    fetchAssetBase64(request.url)
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
});

async function fetchAssetBase64(url) {
    if (typeof url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*weread\.qq\.com\//.test(url)) {
        throw new Error('仅支持 weread.qq.com 资源');
    }

    const response = await fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('图片资源 HTTP ' + response.status);

    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
