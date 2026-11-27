import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EPUB_SHARDS } from './fixtures/epub-shards.js';

const workspace = await mkdtemp(join(tmpdir(), 'bookexport-test-'));
const profile = join(workspace, 'profile');
const downloadPath = join(workspace, 'downloads');
await mkdir(downloadPath);
const executable = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const chrome = spawn(executable, [
    '--headless', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--user-data-dir=' + profile
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let diagnostics = '';
chrome.stderr.setEncoding('utf8').on('data', (data) => { diagnostics = (diagnostics + data).slice(-4000); });
const exited = once(chrome, 'close');
let id = 0;
let buffer = '';
const calls = new Map();
const events = [];
function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        calls.set(++id, { resolve, reject });
        chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
}
chrome.stdio[4].setEncoding('utf8').on('data', (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id) {
            const call = calls.get(message.id);
            calls.delete(message.id);
            if (message.error) call.reject(new Error(JSON.stringify(message.error)));
            else call.resolve(message.result);
        } else {
            for (const event of events) event(message);
        }
    }
});
chrome.on('exit', (code) => {
    for (const call of calls.values()) call.reject(new Error('Chrome exited with code ' + code + '\n' + diagnostics));
    calls.clear();
});
async function waitFor(predicate, sessionId) {
    for (let i = 0; i < 80; i++) {
        const { result } = await send('Runtime.evaluate', { expression: predicate, returnByValue: true }, sessionId);
        if (result.value) return result.value;
        await delay(100);
    }
    throw new Error('Timed out: ' + predicate);
}
const timeout = setTimeout(() => chrome.kill(), 30000);
try {
    const { id: extension } = await send('Extensions.loadUnpacked', { path: resolve('chrome-extension') });
    const { targetId: reader } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: reader, flatten: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://weread.qq.com/*' }] }, sessionId);
    const [firstShard, middleShard, lastShard] = EPUB_SHARDS;
    const chapterResponses = new Map([['e_0', firstShard], ['e_1', middleShard], ['e_3', lastShard], ['e_2', '']]);
    let holdFirstShard = true;
    const heldShard = Promise.withResolvers();
    const abortedShard = Promise.withResolvers();
    let heldURL;
    await send('Network.enable', {}, sessionId);
    const heldRequests = new Set();
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
    const completed = new Promise((resolve) => events.push(({ method, params }) => {
        if (method === 'Browser.downloadProgress' && params.state === 'completed') resolve();
    }));
    events.push(({ method, params, sessionId }) => {
        if (method === 'Network.loadingFailed' && heldRequests.has(params.requestId)) {
            abortedShard.resolve(params.canceled);
            return;
        }
        if (method !== 'Fetch.requestPaused') return;
        const url = new URL(params.request.url);
        if (holdFirstShard && url.pathname.endsWith('/e_0')) {
            heldRequests.add(params.networkId);
            heldURL = url.pathname;
            heldShard.resolve();
            return;
        }
        const body = url.pathname.startsWith('/web/reader/')
            ? '<title>Fixture Book - Fixture Author - \u5fae\u4fe1\u8bfb\u4e66</title><script>window.__INITIAL_STATE__={"reader":{"bookInfo":{"bookId":"42","title":"Fixture Book"},"psvts":"test"}};(function(){});</script>'
            : chapterResponses.get(url.pathname.split('/').at(-1)) ?? JSON.stringify({ data: [{ bookId: '42', updated: [{ chapterUid: '1', wordCount: 100 }] }] });
        setTimeout(() => send('Fetch.fulfillRequest', {
            requestId: params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(body).toString('base64')
        }, sessionId).catch(() => {}), params.request.resourceType === 'Document' ? 0 : 200);
    });
    await send('Page.navigate', { url: 'https://weread.qq.com/web/reader/fixture' }, sessionId);
    await waitFor("document.readyState === 'complete' && document.title.endsWith('\u5fae\u4fe1\u8bfb\u4e66')", sessionId);
    const { targetInfos } = await send('Target.getTargets');
    const workerTarget = targetInfos.find((target) => target.type === 'service_worker' && target.url.includes(extension));
    assert.ok(workerTarget, 'extension action worker');
    const { sessionId: worker } = await send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true });
    async function action() {
        const { exceptionDetails, result } = await send('Runtime.evaluate', {
            expression: `(async () => {
                const manifest = chrome.runtime.getManifest();
                if (manifest.action.default_popup) throw Error('Native popup is still configured');
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab.url.startsWith('https://weread.qq.com/web/reader/')) throw Error('Missing reader tab');
                await toggleDownloadPanel(tab);
                return true;
            })()`, returnByValue: true, awaitPromise: true
        }, worker);
        assert.equal(exceptionDetails, undefined, JSON.stringify(exceptionDetails));
        assert.equal(result.value, true);
    }
    async function panelNode(selector) {
        for (let i = 0; i < 70; i++) {
            const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
            const host = root.children.find((node) => node.nodeName === 'HTML').children.find((node) => node.shadowRoots);
            const shadow = host?.shadowRoots[0];
            if (shadow) {
                const { nodeId } = await send('DOM.querySelector', { nodeId: shadow.nodeId, selector }, sessionId);
                if (nodeId) return (await send('DOM.resolveNode', { nodeId }, sessionId)).object.objectId;
            }
            await delay(100);
        }
        throw Error('Panel not found: ' + selector);
    }
    async function inspectPanel(selector, code) {
        const objectId = await panelNode(selector);
        const { result } = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: code, returnByValue: true }, sessionId);
        return result.value;
    }
    async function matchPanel(selector, code) {
        for (let i = 0; i < 90; i++) {
            if (await inspectPanel(selector, code)) return;
            await delay(100);
        }
        throw Error('Timed out: ' + code);
    }
    await action();
    await matchPanel('main', 'function() { return this.getBoundingClientRect().width > 0; }');
    assert.equal(await inspectPanel('#book-title', "function() { return this.textContent; }"), 'Fixture Book - Fixture Author');
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await Promise.race([heldShard.promise, delay(8000, undefined, { ref: false }).then(() => {
        throw new Error('Chrome did not request the first shard');
    })]);
    assert.equal(heldURL, '/web/book/chapter/e_0');
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await matchPanel('#status', "function() { return this.textContent === 'Export cancelled'; }");
    assert.equal(await Promise.race([
        abortedShard.promise,
        delay(3000, false, { ref: false })
    ]), true, 'Chrome must abort the in-flight chapter request');

    holdFirstShard = false;
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await matchPanel('.download-button', "function() { return this.textContent === 'Cancel download'; }");
    await inspectPanel('.close', 'function() { this.click(); }');
    await matchPanel('main', 'function() { return this.getBoundingClientRect().width === 0; }');
    await action();
    await matchPanel('.download-button', "function() { return this.getBoundingClientRect().width > 0 && this.textContent === 'Cancel download'; }");
    await matchPanel('#status', "function() { return this.textContent.startsWith('EPUB sent to browser downloads.'); }");
    await Promise.race([completed, delay(5000, undefined, { ref: false }).then(() => {
        throw new Error('Chrome did not finish downloading the EPUB');
    })]);
    execFileSync(process.env.EPUBCHECK_BIN || 'epubcheck', [
        '--failonwarnings', join(downloadPath, 'Fixture Book.epub')
    ], { stdio: 'inherit', timeout: 20000 });
    console.log('Chrome saved a valid EPUB after cancelling and restarting the download.');
} finally {
    clearTimeout(timeout);
    chrome.kill();
    await exited;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
}
