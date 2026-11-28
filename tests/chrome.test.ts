import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceServer } from './fixtures/resource-server.ts';
import { decodeContentShards, decodeStyleShard, wereadE } from '../src/weread/protocol.ts';
import { encodeShards } from './fixtures/encode-shards.ts';
import { EPUB_SHARDS, CSS_SHARD } from './fixtures/epub-shards.ts';

const workspace = await mkdtemp(join(tmpdir(), 'bookexport-test-'));
const profile = join(workspace, 'profile');
const downloadPath = join(workspace, 'downloads');
await mkdir(downloadPath);
const benchmark = process.argv.includes('--benchmark');
const stress = process.argv.includes('--stress');
const metricsRun = benchmark || stress;
const network = await resourceServer(workspace, stress);
const executable =
    process.env.CHROME_BIN ||
    (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'google-chrome');
const chrome = spawn(
    executable,
    [
        '--headless',
        ...network.args,
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
        sessionId?: string;
        targetInfo?: { type: string };
        url?: string;
        executionContextId?: number;
        exceptionDetails?: unknown;
        requestId: string;
        networkId?: string;
        canceled?: boolean;
        request: { url: string; postData?: string };
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
async function until(predicate: () => boolean, message: string) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(100);
    }
    assert.fail(message);
}

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
async function openReaderTab() {
    const { targetId } = await send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        forTab: true,
    });
    const { sessionId: tabSession } = await send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
    });
    const attachedPage = Promise.withResolvers<string>();
    events.push(({ method, params, sessionId }) => {
        if (
            method === 'Target.attachedToTarget' &&
            sessionId === tabSession &&
            params.targetInfo?.type === 'page' &&
            params.sessionId
        ) {
            attachedPage.resolve(params.sessionId);
        }
    });
    await send(
        'Target.setAutoAttach',
        {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: 'page' }],
        },
        tabSession,
    );
    const sessionId = await Promise.race([
        attachedPage.promise,
        delay(5000, undefined, { ref: false }).then(() => {
            throw new Error('Chrome did not attach to the reader tab');
        }),
    ]);
    await send(
        'Fetch.enable',
        { patterns: [{ urlPattern: 'https://weread.qq.com/*' }] },
        sessionId,
    );
    return { targetId, sessionId };
}

const timeout = setTimeout(() => chrome.kill(), 110000);
try {
    const { id: extension } = await send<{ id: string }>('Extensions.loadUnpacked', {
        path: resolve(process.env.BOOKEXPORT_EXTENSION ?? 'extension'),
    });
    const { targetId: reader, sessionId } = await openReaderTab();
    let otherSession: string | undefined;
    const otherShard = Promise.withResolvers<string>();
    const scriptReady = Promise.withResolvers<number>();
    const unhandled: unknown[] = [];
    const consoleMessages: unknown[] = [];
    events.push(({ method, params, sessionId: eventSession }) => {
        if (
            method === 'Debugger.scriptParsed' &&
            eventSession === sessionId &&
            params.url === 'chrome-extension://' + extension + '/content.js' &&
            params.executionContextId !== undefined
        ) {
            scriptReady.resolve(params.executionContextId);
        }
        if (method === 'Runtime.consoleAPICalled') consoleMessages.push(params);
        if (method === 'Runtime.exceptionThrown') unhandled.push(params.exceptionDetails);
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Debugger.enable', {}, sessionId);
    const fixtureXhtml = decodeContentShards(...EPUB_SHARDS)
        .replace(
            'src="../illustrations/missing.png"',
            'id="missing-image" src="../illustrations/missing.png"',
        )
        .replace(
            'Next chapter</a>',
            'Next chapter</a> <a href="#missing-image">See illustration</a> <a href="second.xhtml#missing-image">See next illustration</a>',
        );
    const fixtureHtml =
        '<!doctype html>' +
        fixtureXhtml
            .replace('lang="en-US"', 'lang="fr"')
            .replace('class="original-layout"', 'class="html-layout" id="html-start"')
            .replace(
                'A chapter for the browser download test.',
                'A chapter in ordinary HTML.<br>Second line.',
            )
            .replace(
                '</body>',
                '<iframe src="https://denied.invalid/parser-only.png"></iframe></body>',
            );
    const stylesheet =
        decodeStyleShard(CSS_SHARD) +
        ' .responsive { background-image: image-set("../illustrations/responsive.png" 1x, url("../illustrations/missing.png") 2x); }' +
        ' .unused { background-image: url("../illustrations/orphan.png"), url("../illustrations/missing.png"); }';
    const benchmarkChapter =
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Fixture text</p>' +
        Array.from(
            { length: 12 },
            (_, index) =>
                '<p><img alt="Fixture image" src="https://assets.weread.qq.com/bench-' +
                index +
                '.png"/></p>',
        ).join('') +
        '</body></html>';
    const first = encodeShards(metricsRun ? benchmarkChapter : fixtureXhtml, 3);
    const second = metricsRun ? first : encodeShards(fixtureHtml, 3);
    const [style] = encodeShards(metricsRun ? 'p { margin: 1em 0; }' : stylesheet, 1);
    const paths = ['e_0', 'e_1', 'e_3'];
    let holdFirstShard = !metricsRun;
    let failSecondChapter = false;
    if (metricsRun) network.held.hold = false;
    let chapterEnds = 0;
    let chapterStartAt = 0;
    let chapterEndAt = 0;
    let overlapped = false;
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
    let downloadStarts = 0;
    events.push(({ method }) => {
        if (method === 'Browser.downloadWillBegin') downloadStarts++;
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
        if (url.pathname.endsWith('/e_0')) chapterStartAt ||= performance.now();
        const lastChapterShard = url.pathname.endsWith('/e_3') && ++chapterEnds === 2;
        if (lastChapterShard) overlapped = network.held.requests.size > 0;
        if (holdFirstShard && url.pathname.endsWith('/e_0')) {
            assert.ok(params.networkId);
            if (sessionId === otherSession) {
                otherShard.resolve(params.networkId);
                return;
            }
            heldRequests.add(params.networkId);
            heldURL = url.pathname;
            heldShard.resolve();
            return;
        }
        const api = url.pathname.split('/').at(-1) ?? '';
        const chapterId = params.request.postData
            ? JSON.parse(params.request.postData).c
            : undefined;
        const fail = failSecondChapter && api === 'e_0' && chapterId === wereadE('2');
        const shard =
            api === 'e_2'
                ? style
                : (chapterId === wereadE('2') ? second : first)[paths.indexOf(api)];
        const body = url.pathname.startsWith('/web/reader/')
            ? '<title>Fixture Book - Fixture Author - \u5fae\u4fe1\u8bfb\u4e66</title><script>window.__INITIAL_STATE__={"reader":{"bookInfo":{"bookId":"42","title":"Fixture Book","language":"en-US"},"psvts":"test"}};(function(){});</script>'
            : (shard ??
              JSON.stringify({
                  data: [
                      {
                          bookId: '42',
                          updated: [
                              {
                                  chapterUid: '1',
                                  title: '\u7248\u6743\u4fe1\u606f',
                                  wordCount: 100,
                                  href: 'https://assets.weread.qq.com/book-source/chapter/first.xhtml',
                              },
                              {
                                  chapterUid: '2',
                                  parentChapterUid: '1',
                                  wordCount: 100,
                              },
                          ],
                      },
                  ],
              }));
        setTimeout(
            () => {
                if (lastChapterShard) chapterEndAt = performance.now();
                void send(
                    'Fetch.fulfillRequest',
                    {
                        requestId: params.requestId,
                        responseCode: fail ? 503 : 200,
                        responseHeaders: [
                            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                        ],
                        body: Buffer.from(body).toString('base64'),
                    },
                    sessionId,
                ).catch(() => {});
            },
            params.resourceType === 'Document' ? 0 : 200,
        );
    });
    await send('Page.navigate', { url: 'https://weread.qq.com/web/reader/fixture' }, sessionId);
    await waitFor(
        "document.readyState === 'complete' && document.title.endsWith('\u5fae\u4fe1\u8bfb\u4e66')",
        sessionId,
    );
    const contextId = await Promise.race([
        scriptReady.promise,
        delay(8000, undefined, { ref: false }).then(() => {
            throw new Error('The BookExport content script did not load');
        }),
    ]);
    await send(
        'Runtime.evaluate',
        {
            expression: metricsRun ? 'Math.random = () => 0.4' : 'void 0',
            contextId,
        },
        sessionId,
    );
    await send('Debugger.disable', {}, sessionId);
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
    await send('Runtime.enable', {}, worker);
    let workerReady: Evaluation | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
        workerReady = await send<Evaluation>(
            'Runtime.evaluate',
            {
                expression: `(async () => {
                    const tabs = await chrome.tabs.query({});
                    return tabs.some((tab) => tab.url === 'https://weread.qq.com/web/reader/fixture')
                        && chrome.action.onClicked.hasListeners();
                })()`,
                returnByValue: true,
                awaitPromise: true,
            },
            worker,
        );
        if (workerReady.result.value === true) break;
        await delay(100);
    }
    assert.equal(workerReady?.result.value, true, JSON.stringify(workerReady));
    function action() {
        return send('Extensions.triggerAction', { id: extension, targetId: reader });
    }
    async function panelNode(selector: string, target = sessionId) {
        for (let i = 0; i < 70; i++) {
            const { root } = await send<{ root: DomNode }>(
                'DOM.getDocument',
                { depth: -1, pierce: true },
                target,
            );
            const host = root.children
                ?.find((node) => node.nodeName === 'HTML')
                ?.children?.find((node) => node.shadowRoots);
            const shadow = host?.shadowRoots?.[0];
            if (shadow) {
                const { nodeId } = await send<{ nodeId: number }>(
                    'DOM.querySelector',
                    { nodeId: shadow.nodeId, selector },
                    target,
                );
                if (nodeId)
                    return (
                        await send<{ object: { objectId: string } }>(
                            'DOM.resolveNode',
                            { nodeId },
                            target,
                        )
                    ).object.objectId;
            }
            await delay(100);
        }
        throw Error(
            'Panel not found: ' + selector + '\n' + JSON.stringify({ unhandled, consoleMessages }),
        );
    }
    async function inspectPanel(selector: string, code: string, target = sessionId) {
        const objectId = await panelNode(selector, target);
        const { result } = await send<Evaluation>(
            'Runtime.callFunctionOn',
            { objectId, functionDeclaration: code, returnByValue: true },
            target,
        );
        return result.value;
    }
    async function matchPanel(selector: string, code: string, target = sessionId) {
        for (let i = 0; i < 90; i++) {
            if (await inspectPanel(selector, code, target)) return;
            await delay(100);
        }
        throw Error('Timed out: ' + code);
    }
    await action();
    await matchPanel('main', 'function() { return this.getBoundingClientRect().width > 0; }');
    if (metricsRun) {
        const { browserMetrics } = await import('./fixtures/browser-metrics.ts');
        const sample = browserMetrics(send, sessionId);
        await inspectPanel(
            '#status',
            `function() {
            const longTasks = [];
            const phases = {};
            this.bookExportMetrics = { longTasks, phases };
            new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
                .observe({type: 'longtask'});
            new MutationObserver(() => {
                const label = this.textContent;
                if (label.startsWith('Downloading chapters')) phases.chapters ??= performance.now();
                if (label === 'Packaging EPUB…') phases.packaging ??= performance.now();
                if (/^(EPUB sent|Saved|Export complete)/i.test(label)) phases.completed ??= performance.now();
            }).observe(this, { childList: true });
        }`,
        );
        const started = performance.now();
        await inspectPanel('.download-button', 'function() { this.click(); }');
        const result = await Promise.race([
            completed.then(() => true),
            delay(30000, false, { ref: false }),
        ]);
        const totalMs = performance.now() - started;
        const metrics = await sample();
        const status = await inspectPanel('#status', 'function() { return this.textContent; }');
        assert.equal(result, true, String(status));
        const panelMetrics = await inspectPanel(
            '#status',
            `function() {
                const { longTasks, phases } = this.bookExportMetrics;
                return {
                    longTasks,
                    packagingMs: phases.completed && phases.packaging
                        ? Math.round(phases.completed - phases.packaging)
                        : null
                };
            }`,
        );
        const file = join(downloadPath, 'Fixture Book.epub');
        const size = (await stat(file)).size;
        if (stress && !benchmark) {
            // The queue reserves space for both incoming chunks and a contiguous response.
            assert.match(String(status), /Resources: 8\. 4 resources unavailable\./);
            assert.equal(network.held.requests.size, 12);
            assert.equal(network.held.peak <= 4, true);
            const paths = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
            assert.equal(Array.from(paths.matchAll(/^OEBPS\/images\/image_\d+\.png$/gm)).length, 8);
            execFileSync(process.env.EPUBCHECK_BIN || 'epubcheck', ['--failonwarnings', file], {
                stdio: 'inherit',
                timeout: 30000,
            });
        }
        console.log(
            JSON.stringify({
                fixture: stress ? 'large-images' : 'shared-images',
                totalMs: Math.round(totalMs),
                chapterRequestMs: Math.round(chapterEndAt - chapterStartAt),
                resourceMs: Math.round(network.held.lastResponseAt - network.held.firstRequestAt),
                requests: Array.from(network.held.requests.values()).reduce((a, b) => a + b, 0),
                unique: network.held.requests.size,
                resourcePeak: network.held.peak,
                resourceOverlap: overlapped,
                epubBytes: size,
                status,
                panelMetrics,
                ...metrics,
            }),
        );
    } else {
        await send(
            'Emulation.setEmulatedMedia',
            {
                features: [{ name: 'prefers-color-scheme', value: 'light' }],
            },
            sessionId,
        );
        assert.equal(
            await inspectPanel('main', 'function() { return this.getBoundingClientRect().width; }'),
            318,
        );
        assert.equal(
            await inspectPanel(
                'header',
                'function() { return getComputedStyle(this).borderBottomWidth; }',
            ),
            '0px',
        );
        await matchPanel(
            '.product',
            `function() {
            return getComputedStyle(this).fontFamily.includes('BookExport Teko') &&
                [...document.fonts].some(font => font.family === 'BookExport Teko' && font.status === 'loaded');
        }`,
        );
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
        assert.equal(
            await inspectPanel(
                '#status',
                `function() {
                const rect = this.getBoundingClientRect();
                return this.textContent === 'Downloading chapters' && rect.width === 1 && rect.height === 1;
            }`,
            ),
            true,
            'Chapter progress uses the bar without a visible status label',
        );
        assert.equal(
            await inspectPanel(
                '.progress-track',
                'function() { return this.getBoundingClientRect().height; }',
            ),
            6,
        );
        assert.equal(heldURL, '/web/book/chapter/e_0');
        const other = await openReaderTab();
        otherSession = other.sessionId;
        await send('Network.enable', {}, otherSession);
        await send(
            'Page.navigate',
            { url: 'https://weread.qq.com/web/reader/parallel' },
            otherSession,
        );
        await waitFor(
            "document.readyState === 'complete' && document.title.startsWith('Fixture Book')",
            otherSession,
        );
        await send('Extensions.triggerAction', { id: extension, targetId: other.targetId });
        await inspectPanel('.download-button', 'function() { this.click(); }', otherSession);
        const otherRequest = await Promise.race([
            otherShard.promise,
            delay(5000, undefined, { ref: false }).then(() => {
                throw new Error('The second tab did not start its chapter request');
            }),
        ]);
        const otherAborted = Promise.withResolvers<boolean>();
        events.push(({ method, params, sessionId }) => {
            if (
                sessionId === otherSession &&
                method === 'Network.loadingFailed' &&
                params.requestId === otherRequest
            )
                otherAborted.resolve(params.canceled === true);
        });
        await inspectPanel('.download-button', 'function() { this.click(); }');
        await matchPanel(
            '#status',
            "function() { return this.textContent === 'Export cancelled'; }",
        );
        assert.equal(
            await Promise.race([abortedShard.promise, delay(3000, false, { ref: false })]),
            true,
            'Chrome must abort the in-flight chapter request',
        );

        assert.equal(
            await inspectPanel(
                '.download-button',
                'function() { return this.textContent; }',
                otherSession,
            ),
            'Cancel download',
            'Cancelling the first tab must leave the second export running',
        );
        await inspectPanel('.download-button', 'function() { this.click(); }', otherSession);
        assert.equal(
            await Promise.race([otherAborted.promise, delay(3000, false, { ref: false })]),
            true,
        );
        await send('Target.closeTarget', { targetId: other.targetId });
        console.log('Two reader tabs maintain independent exports.');

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
        await until(() => network.held.active === 4, 'waiting for four held downloads');
        const cancelStarted = performance.now();
        await inspectPanel('.download-button', 'function() { this.click(); }');
        await matchPanel(
            '#status',
            "function() { return this.textContent === 'Export cancelled'; }",
        );
        await until(
            () => network.held.aborted === 4 && network.held.active === 0,
            'waiting for sockets to close',
        );
        console.log(
            'Resource cancellation took ' + Math.round(performance.now() - cancelStarted) + ' ms.',
        );
        assert.equal(
            Array.from(network.held.requests.values()).reduce((a, b) => a + b, 0),
            4,
        );
        network.held.requests.clear();
        await inspectPanel('.download-button', 'function() { this.click(); }');
        await until(
            () => network.held.active === 4,
            'waiting for resources before stopping the worker',
        );
        await send('ServiceWorker.enable', {}, sessionId);
        network.held.hold = false;
        await send('ServiceWorker.stopAllWorkers', {}, sessionId);
        for (let attempt = 0; attempt < 50; attempt++) {
            const { targetInfos } = await send<{ targetInfos: { targetId: string }[] }>(
                'Target.getTargets',
            );
            if (!targetInfos.some((target) => target.targetId === workerTargetId)) break;
            if (attempt === 49)
                assert.fail('Chrome did not terminate the extension Service Worker');
            await delay(100);
        }
        await until(
            () => network.held.aborted >= 8,
            'waiting for worker termination to close resource sockets',
        );
        await inspectPanel('.download-button', 'function() { this.click(); }');
        await matchPanel(
            '#status',
            "function() { return this.textContent === 'Export cancelled'; }",
        );
        await until(
            () => network.held.active === 0,
            'waiting for the restarted worker to release resources',
        );
        console.log('Service Worker termination disconnects in-flight resource requests.');

        await inspectPanel(
            '#status',
            `function() {
            const observer = new MutationObserver(() => {
                if (this.textContent !== 'Packaging EPUB…') return;
                observer.disconnect();
                this.dataset.packagingCancelled = 'yes';
                this.getRootNode().querySelector('.download-button').click();
            });
            observer.observe(this, { childList: true });
        }`,
        );
        await inspectPanel('.download-button', 'function() { this.click(); }');
        for (let attempt = 0; attempt < 160; attempt++) {
            if (
                await inspectPanel(
                    '#status',
                    "function() { return this.dataset.packagingCancelled === 'yes' && this.textContent === 'Export cancelled'; }",
                )
            )
                break;
            if (attempt === 159) assert.fail('Cancellation during packaging did not settle');
            await delay(100);
        }
        assert.equal(
            downloadStarts,
            0,
            'Cancellation during packaging must prevent download handoff',
        );
        console.log('Cancelling from the panel during packaging prevents download handoff.');
        failSecondChapter = true;
        await inspectPanel('.download-button', 'function() { this.click(); }');
        await matchPanel(
            '.download-button',
            "function() { return this.textContent === 'Retry download' && !this.disabled; }",
        );
        assert.equal(
            await inspectPanel('progress', 'function() { return this.value / this.max; }'),
            0.5,
            'Failure retains the progress shown before the failing chapter',
        );
        assert.equal(
            await inspectPanel(
                '.progress-fill',
                `function() {
                const style = getComputedStyle(this);
                return style.backgroundColor === 'rgb(206, 57, 72)' &&
                    style.animationName === 'none' && style.transitionProperty === 'none';
            }`,
            ),
            true,
            'The failed progress bar is red and still',
        );
        failSecondChapter = false;
        network.held.requests.clear();
        network.held.hold = false;
        network.held.peak = 0;
        chapterEnds = 0;
        overlapped = false;
        await inspectPanel(
            'progress',
            `function() {
        new MutationObserver((changes) => {
            if (changes.some(change => change.attributeName === 'value')
                && this.hasAttribute('value') && this.value === this.max) this.dataset.completed = 'yes';
        }).observe(this, { attributes: true });
    }`,
        );
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
        assert.equal(
            await inspectPanel(
                '.download-result',
                'function() { return !this.hidden && this.textContent === "Export complete"; }',
            ),
            true,
        );
        assert.equal(
            await inspectPanel('.download-button', 'function() { return this.hidden; }'),
            true,
        );
        assert.equal(
            await inspectPanel(
                '.resource-warning',
                'function() { return this.hidden ? "" : this.textContent; }',
            ),
            '9 resources unavailable.',
        );
        console.log(
            'The popup has the new width and bundled font, and retry restores a successful export.',
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
        assert.equal(
            network.held.requests.get('shared.png'),
            1,
            'One request for a resource shared by chapters and CSS',
        );
        assert.equal(
            network.held.requests.get('direct.png'),
            1,
            'An approved CDN may be addressed directly',
        );
        assert.equal(
            network.held.requests.has('redirect-target.png'),
            false,
            'Cross-origin redirects must not be followed',
        );
        assert.equal(network.held.credentials, 0);
        assert.ok(
            network.held.streamed > 16 * 1024 * 1024,
            'Exercise the streaming limit without Content-Length',
        );
        assert.equal(network.held.peak, 4);
        assert.equal(overlapped, true, 'Resources start before the final chapter response');
        assert.equal(
            await inspectPanel('progress', 'function() { return this.dataset.completed; }'),
            'yes',
        );
        assert.equal(Array.from(chapter.matchAll(/src="\.\.\/images\/image_1\.png"/g)).length, 2);
        assert.ok(chapter.includes('[Illustration: Unavailable &amp; missing]'));
        const nextChapter = execFileSync('unzip', ['-p', file, 'OEBPS/text/chapter_0002.xhtml'], {
            encoding: 'utf8',
        });
        assert.ok(nextChapter.includes('src="../images/image_1.png"'));
        assert.match(nextChapter, /class="html-layout" id="html-start"/);
        assert.match(nextChapter, /lang="fr"/);
        assert.match(nextChapter, /ordinary HTML\.<br[^>]*\/>Second line\./);
        assert.doesNotMatch(nextChapter, /parsererror|parser-only/);
        assert.equal(network.held.requests.has('parser-only.png'), false);
        assert.match(chapter, /href="#missing-image"/);
        assert.match(chapter, /href="chapter_0002.xhtml#missing-image"/);
        assert.match(nextChapter, /<span[^>]*id="missing-image"[^>]*>\[Illustration:/);
        assert.ok(chapter.includes('<title>\u7248\u6743\u4fe1\u606f</title>'));
        assert.ok(chapter.includes('href="#chapter-start"'));
        assert.doesNotMatch(chapter, /<script/);
        assert.ok(chapter.includes('href="chapter_0002.xhtml#chapter-start"'));
        assert.match(chapter, /<style>[^<]*embedded[^<]*\.\.\/images\/image_1\.png/);
        assert.match(chapter, /style="[^"]*\.\.\/images\/image_1\.png/);
        assert.ok(chapter.includes('[Illustration: Oversized image]'));
        assert.ok(chapter.includes('[Illustration: Approved redirect]'));
        assert.ok(chapter.includes('[Illustration: Blocked redirect]'));
        assert.ok(chapter.includes('class="original-layout"'));
        assert.ok(chapter.includes('lang="en-US"'));
        assert.equal(Array.from(chapter.matchAll(/<h1(?:\s[^>]*)?>/g)).length, 1);
        assert.doesNotMatch(chapter, /denied\.invalid|<animate/);
        assert.match(
            String(await inspectPanel('#status', 'function() { return this.textContent; }')),
            /9 resources unavailable/,
        );
        const opf = execFileSync('unzip', ['-p', file, 'OEBPS/content.opf'], { encoding: 'utf8' });
        assert.ok(opf.includes('properties="svg mathml"'));
        assert.ok(opf.includes('<dc:language>en-US</dc:language>'));
        const nav = execFileSync('unzip', ['-p', file, 'OEBPS/nav.xhtml'], { encoding: 'utf8' });
        assert.match(
            nav,
            /chapter_0001\.xhtml"[^<]*>[^<]+<\/a><ol><li><a href="text\/chapter_0002\.xhtml"/,
        );
        const css = execFileSync('unzip', ['-p', file, 'OEBPS/styles/weread.css'], {
            encoding: 'utf8',
        });
        assert.ok(css.includes('margin: 1em 0'));
        assert.ok(css.includes('../images/image_1.png'));
        assert.match(
            css,
            /\.responsive\s*\{[^}]*image-set\(url\("\.\.\/images\/image_\d+\.png"\) 1(?:x|dppx)\)/,
        );
        assert.doesNotMatch(css, /\.unused\s*\{[^}]*url\(/);
        assert.equal(network.held.requests.get('orphan.png'), 1);
        assert.equal(network.held.requests.get('responsive.png'), 1);
        assert.equal(Array.from(opf.matchAll(/media-type="image\/png"/g)).length, 7);
        assert.doesNotMatch(css, /example\.invalid/);
        assert.deepEqual(unhandled, [], 'No unhandled Chrome exceptions');
        console.log('Chrome saved a valid EPUB after cancelling and restarting the download.');
    }
} finally {
    clearTimeout(timeout);
    chrome.kill();
    await exited;
    await network.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
}
