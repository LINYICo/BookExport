import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EPUB_SHARDS, CSS_SHARD } from './fixtures/epub-shards.ts';

const workspace = await mkdtemp(join(tmpdir(), 'bookexport-test-'));
const profile = join(workspace, 'profile');
const downloadPath = join(workspace, 'downloads');
await mkdir(downloadPath);
const executable =
    process.env.CHROME_BIN ||
    (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'google-chrome');
const chrome = spawn(
    executable,
    [
        '--headless',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-unsafe-extension-debugging',
        '--remote-debugging-pipe',
        '--user-data-dir=' + profile,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
let diagnostics = '';
chrome.stderr?.setEncoding('utf8').on('data', (data: string) => {
    diagnostics = (diagnostics + data).slice(-4000);
});
const exited = once(chrome, 'close');
let id = 0;
let buffer = '';
type Event = {
    method: string;
    sessionId?: string;
    params: {
        state?: string;
        requestId: string;
        networkId?: string;
        canceled?: boolean;
        request: { url: string };
        resourceType?: string;
    };
};
type Envelope = { id?: number; error?: unknown; result?: unknown };
interface DomNode {
    nodeName: string;
    nodeId: number;
    children?: DomNode[];
    shadowRoots?: DomNode[];
}
interface Evaluation {
    exceptionDetails?: unknown;
    result: { value?: unknown };
}
const calls = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (reason: Error) => void }
>();
const events: ((event: Event) => void)[] = [];
const [, , , input, output] = chrome.stdio;
assert.ok(input instanceof Writable && output instanceof Readable);
const pipe = input;
function send<Result = void>(method: string, params = {}, sessionId?: string) {
    return new Promise<Result>((resolve, reject) => {
        // Each caller supplies the response schema for the CDP method it invokes.
        calls.set(++id, { method, resolve: (result) => resolve(result as Result), reject });
        pipe.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
}
output.setEncoding('utf8').on('data', (data: string) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
        const message: Envelope | Event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if ('id' in message && message.id) {
            const call = calls.get(message.id);
            calls.delete(message.id);
            if (!call) continue;
            if (message.error) call.reject(new Error(JSON.stringify(message.error)));
            else call.resolve(message.result);
        } else if ('method' in message) {
            for (const event of events) event(message);
        }
    }
});
chrome.on('exit', (code) => {
    for (const call of calls.values())
        call.reject(
            new Error(
                'Chrome exited while waiting for ' +
                    call.method +
                    ' with code ' +
                    code +
                    '\n' +
                    diagnostics,
            ),
        );
    calls.clear();
});
async function waitFor(predicate: string, sessionId: string) {
    for (let i = 0; i < 80; i++) {
        const { result } = await send<Evaluation>(
            'Runtime.evaluate',
            { expression: predicate, returnByValue: true },
            sessionId,
        );
        if (result.value) return result.value;
        await delay(100);
    }
    throw new Error('Timed out: ' + predicate);
}
const timeout = setTimeout(() => chrome.kill(), 30000);
try {
    const { id: extension } = await send<{ id: string }>('Extensions.loadUnpacked', {
        path: resolve('dist/extension'),
    });
    const { targetId: reader } = await send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
    });
    const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: reader,
        flatten: true,
    });
    await send(
        'Fetch.enable',
        { patterns: [{ urlPattern: 'https://weread.qq.com/*' }] },
        sessionId,
    );
    const [firstShard, middleShard, lastShard] = EPUB_SHARDS;
    const chapterResponses = new Map([
        ['e_0', firstShard],
        ['e_1', middleShard],
        ['e_3', lastShard],
        ['e_2', CSS_SHARD],
    ]);
    let holdFirstShard = true;
    const png = (await readFile('public/icons/icon48.png')).toString('base64');
    let heldShard = Promise.withResolvers<void>();
    let abortedShard = Promise.withResolvers<boolean>();
    let heldURL: string | undefined;
    await send('Network.enable', {}, sessionId);
    const heldRequests = new Set<string>();
    await send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath,
        eventsEnabled: true,
    });
    const completed = new Promise<void>((resolve) =>
        events.push(({ method, params }) => {
            if (method === 'Browser.downloadProgress' && params.state === 'completed') resolve();
        }),
    );
    events.push(({ method, params, sessionId }) => {
        if (method === 'Network.loadingFailed' && heldRequests.has(params.requestId)) {
            abortedShard.resolve(params.canceled === true);
            return;
        }
        if (method !== 'Fetch.requestPaused') return;
        const url = new URL(params.request.url);
        if (holdFirstShard && url.pathname.endsWith('/e_0')) {
            assert.ok(params.networkId);
            heldRequests.add(params.networkId);
            heldURL = url.pathname;
            heldShard.resolve();
            return;
        }
        const body = url.pathname.startsWith('/web/reader/')
            ? '<title>Fixture Book - Fixture Author - \u5fae\u4fe1\u8bfb\u4e66</title><script>window.__INITIAL_STATE__={"reader":{"bookInfo":{"bookId":"42","title":"Fixture Book"},"psvts":"test"}};(function(){});</script>'
            : (chapterResponses.get(url.pathname.split('/').at(-1) ?? '') ??
              JSON.stringify({
                  data: [
                      {
                          bookId: '42',
                          updated: [
                              { chapterUid: '1', wordCount: 100 },
                              { chapterUid: '2', wordCount: 100 },
                          ],
                      },
                  ],
              }));
        setTimeout(
            () =>
                send(
                    'Fetch.fulfillRequest',
                    {
                        requestId: params.requestId,
                        responseCode: 200,
                        responseHeaders: [
                            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                        ],
                        body: Buffer.from(body).toString('base64'),
                    },
                    sessionId,
                ).catch(() => {}),
            params.resourceType === 'Document' ? 0 : 200,
        );
    });
    await send('Page.navigate', { url: 'https://weread.qq.com/web/reader/fixture' }, sessionId);
    await waitFor(
        "document.readyState === 'complete' && document.title.endsWith('\u5fae\u4fe1\u8bfb\u4e66')",
        sessionId,
    );
    let workerTargetId: string | undefined;
    for (let attempt = 0; attempt < 50 && !workerTargetId; attempt++) {
        const { targetInfos } = await send<{
            targetInfos: { type: string; url: string; targetId: string }[];
        }>('Target.getTargets');
        workerTargetId = targetInfos.find(
            (target) =>
                target.type === 'service_worker' &&
                target.url.startsWith('chrome-extension://' + extension + '/'),
        )?.targetId;
        if (!workerTargetId) await delay(100);
    }
    assert.ok(workerTargetId, 'Extension service worker did not start');
    const { sessionId: worker } = await send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: workerTargetId,
        flatten: true,
    });
    const mockedImages = await send<Evaluation>(
        'Runtime.evaluate',
        {
            expression: `(() => {
            globalThis.imageRequests = 0;
            globalThis.fetch = async (url) => {
                const found = url.pathname === '/sample.png';
                if (found) globalThis.imageRequests++;
                const response = new Response(found ? Uint8Array.fromBase64('${png}') : null, { status: found ? 200 : 404 });
                Object.defineProperty(response, 'url', { value: url.href });
                return response;
            };
        })()`,
        },
        worker,
    );
    assert.equal(mockedImages.exceptionDetails, undefined);
    async function action() {
        const { exceptionDetails, result } = await send<Evaluation>(
            'Runtime.evaluate',
            {
                expression: `(async () => {
                const manifest = chrome.runtime.getManifest();
                if (manifest.action.default_popup) throw Error('Native popup is still configured');
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab.url.startsWith('https://weread.qq.com/web/reader/')) throw Error('Missing reader tab');
                await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_DOWNLOAD_PANEL' }, { frameId: 0 });
                return true;
            })()`,
                returnByValue: true,
                awaitPromise: true,
            },
            worker,
        );
        assert.equal(exceptionDetails, undefined, JSON.stringify(exceptionDetails));
        assert.equal(result.value, true);
    }
    async function panelNode(selector: string) {
        for (let i = 0; i < 70; i++) {
            const { root } = await send<{ root: DomNode }>(
                'DOM.getDocument',
                { depth: -1, pierce: true },
                sessionId,
            );
            const host = root.children
                ?.find((node) => node.nodeName === 'HTML')
                ?.children?.find((node) => node.shadowRoots);
            const shadow = host?.shadowRoots?.[0];
            if (shadow) {
                const { nodeId } = await send<{ nodeId: number }>(
                    'DOM.querySelector',
                    { nodeId: shadow.nodeId, selector },
                    sessionId,
                );
                if (nodeId)
                    return (
                        await send<{ object: { objectId: string } }>(
                            'DOM.resolveNode',
                            { nodeId },
                            sessionId,
                        )
                    ).object.objectId;
            }
            await delay(100);
        }
        throw Error('Panel not found: ' + selector);
    }
    async function inspectPanel(selector: string, code: string) {
        const objectId = await panelNode(selector);
        const { result } = await send<Evaluation>(
            'Runtime.callFunctionOn',
            { objectId, functionDeclaration: code, returnByValue: true },
            sessionId,
        );
        return result.value;
    }
    async function matchPanel(selector: string, code: string) {
        for (let i = 0; i < 90; i++) {
            if (await inspectPanel(selector, code)) return;
            await delay(100);
        }
        throw Error('Timed out: ' + code);
    }
    await action();
    await matchPanel('main', 'function() { return this.getBoundingClientRect().width > 0; }');
    assert.equal(
        await inspectPanel('#book-title', 'function() { return this.textContent; }'),
        'Fixture Book - Fixture Author',
    );
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await Promise.race([
        heldShard.promise,
        delay(8000, undefined, { ref: false }).then(() => {
            throw new Error('Chrome did not request the first shard');
        }),
    ]);
    assert.equal(heldURL, '/web/book/chapter/e_0');
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await matchPanel('#status', "function() { return this.textContent === 'Export cancelled'; }");
    assert.equal(
        await Promise.race([abortedShard.promise, delay(3000, false, { ref: false })]),
        true,
        'Chrome must abort the in-flight chapter request',
    );

    heldShard = Promise.withResolvers<void>();
    abortedShard = Promise.withResolvers<boolean>();
    heldRequests.clear();
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await Promise.race([
        heldShard.promise,
        delay(8000, undefined, { ref: false }).then(() => {
            throw new Error('Chrome did not restart the chapter request');
        }),
    ]);
    await send(
        'Runtime.evaluate',
        { expression: "history.pushState({}, '', '/web/reader/other')" },
        sessionId,
    );
    await matchPanel('main', 'function() { return !this.matches(":popover-open"); }');
    assert.equal(
        await Promise.race([abortedShard.promise, delay(3000, false, { ref: false })]),
        true,
        'Navigation must cancel the previous export',
    );
    await send(
        'Runtime.evaluate',
        { expression: "history.replaceState({}, '', '/web/reader/fixture')" },
        sessionId,
    );
    await action();

    holdFirstShard = false;
    await inspectPanel('.download-button', 'function() { this.click(); }');
    await matchPanel(
        '.download-button',
        "function() { return this.textContent === 'Cancel download'; }",
    );
    await inspectPanel('.close', 'function() { this.click(); }');
    await matchPanel('main', 'function() { return this.getBoundingClientRect().width === 0; }');
    await action();
    await matchPanel(
        '.download-button',
        "function() { return this.getBoundingClientRect().width > 0 && this.textContent === 'Cancel download'; }",
    );
    await matchPanel(
        '#status',
        "function() { return this.textContent.startsWith('EPUB sent to browser downloads.'); }",
    );
    await Promise.race([
        completed,
        delay(5000, undefined, { ref: false }).then(() => {
            throw new Error('Chrome did not finish downloading the EPUB');
        }),
    ]);
    execFileSync(
        process.env.EPUBCHECK_BIN || 'epubcheck',
        ['--failonwarnings', join(downloadPath, 'Fixture Book.epub')],
        { stdio: 'inherit', timeout: 20000 },
    );
    const file = join(downloadPath, 'Fixture Book.epub');
    const chapter = execFileSync('unzip', ['-p', file, 'OEBPS/text/chapter_0001.xhtml'], {
        encoding: 'utf8',
    });
    const imageRequests = await send<Evaluation>(
        'Runtime.evaluate',
        { expression: 'globalThis.imageRequests', returnByValue: true },
        worker,
    );
    assert.equal(imageRequests.result.value, 1, 'Fetch each unique image once');
    assert.equal(Array.from(chapter.matchAll(/src="\.\.\/images\/image_1\.png"/g)).length, 2);
    assert.ok(chapter.includes('[Illustration: Unavailable &amp; missing]'));
    const nextChapter = execFileSync('unzip', ['-p', file, 'OEBPS/text/chapter_0002.xhtml'], {
        encoding: 'utf8',
    });
    assert.ok(nextChapter.includes('src="../images/image_1.png"'));
    assert.ok(chapter.includes('href="#chapter-start"'));
    assert.doesNotMatch(chapter, /<script/);
    assert.equal(
        execFileSync('unzip', ['-p', file, 'OEBPS/styles/weread.css'], { encoding: 'utf8' }),
        'p { margin: 1em 0; }',
    );
    console.log('Chrome saved a valid EPUB after cancelling and restarting the download.');
} finally {
    clearTimeout(timeout);
    chrome.kill();
    await exited;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
}
