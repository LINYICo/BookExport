import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssetQueue } from '../../src/assets.ts';
import { readBounded } from '../../src/io.ts';
import { resourceURL, type ResourceResponse } from '../../src/resource.ts';

const base = 'https://assets.weread.qq.com/books/intro.xhtml';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('the book queue enforces its bound and assigns paths in discovery order', async () => {
    const active = new Map<string, ReturnType<typeof Promise.withResolvers<ResourceResponse>>>();
    const seen: string[] = [];
    let peak = 0;
    const signal = new AbortController().signal;
    const queue = createAssetQueue(
        async (url) => {
            const gate = Promise.withResolvers<ResourceResponse>();
            active.set(url, gate);
            peak = Math.max(peak, active.size);
            seen.push(url);
            const result = await gate.promise;
            active.delete(url);
            return result;
        },
        signal,
        () => 0,
    );
    await queue.add(
        ['one.png', 'two.png?edition=1', 'three.png', 'four.png', 'five.png', 'six.png'],
        base,
    );
    await queue.add(['one.png#ignored', 'five.png', 'two.png?edition=2'], base);
    assert.equal(peak, 4);
    assert.equal(seen.length, 4);
    const settle = async (name: string, outcome: ResourceResponse) => {
        const url = new URL(name, base).href;
        for (let i = 0; i < 40 && !active.has(url); i++)
            await new Promise((resolve) => setTimeout(resolve, 5));
        const gate = active.get(url);
        assert.ok(gate, 'Active resource: ' + name);
        gate.resolve(outcome);
    };
    await settle('four.png', { status: 'timeout' });
    await settle('two.png?edition=1', { status: 'downloaded', data: png });
    await settle('one.png', { status: 'downloaded', data: png });
    await settle('three.png', { status: 'downloaded', data: png });
    for (const name of ['five.png', 'six.png', 'two.png?edition=2'])
        await settle(name, { status: 'downloaded', data: png });
    await queue.drain();
    assert.equal(peak, 4);
    assert.equal(seen.length, 7);
    assert.equal(queue.path('one.png', base), '../images/image_1.png');
    assert.equal(queue.path('two.png?edition=2', base), '../images/image_7.png');
    assert.deepEqual(queue.result().failures, { timeout: 1 });
    assert.equal(queue.result().references, 9);
    assert.equal(queue.result().unique, 7);
});

test(
    'draining a finished resource queue skips the final cooldown',
    { timeout: 1000 },
    async (t) => {
        const cooling = Promise.withResolvers<void>();
        const queue = createAssetQueue(
            async () => ({ status: 'downloaded', data: png }),
            t.signal,
            () => {
                cooling.resolve();
                return 60000;
            },
        );
        await queue.add(['one.png'], base);
        await cooling.promise;
        await queue.drain();
        assert.equal(queue.result().assets.length, 1);
    },
);

test('resource reservations cap reads and preserve other images when the budget is reached', async () => {
    const limits: number[] = [];
    const queue = createAssetQueue(
        async (_url, limit) => {
            limits.push(limit);
            return limit >= png.length ? { status: 'downloaded', data: png } : { status: 'limit' };
        },
        new AbortController().signal,
        () => 0,
        { budget: 20, maxResource: 8 },
    );
    await queue.add(['first.png', 'second.png', 'third.png'], base);
    await queue.drain();
    assert.deepEqual(limits, [8, 6, 6]);
    assert.deepEqual(queue.result().failures, { limit: 2 });
    assert.equal(queue.result().assets.length, 1);
});

test('closing a cancelled queue settles active downloads and drops pending work', async () => {
    const job = new AbortController();
    let started = 0;
    const queue = createAssetQueue(
        async (_url, _limit, signal) => {
            started++;
            return await new Promise<ResourceResponse>((resolve) => {
                signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), {
                    once: true,
                });
            });
        },
        job.signal,
        () => 0,
    );
    await queue.add(
        Array.from({ length: 20 }, (_, n) => n + '.png'),
        base,
    );
    job.abort();
    await queue.drain();
    assert.equal(started, 4);
    assert.equal(queue.result().unavailable, 0);
});

test('stream limit applies to both declared and undeclared lengths', async () => {
    const signal = new AbortController().signal;
    await assert.rejects(
        readBounded(new Response('small', { headers: { 'content-length': '99' } }), 6, signal),
        /size limit/,
    );
    await assert.rejects(
        readBounded(new Response('too long', { headers: { 'content-length': '1' } }), 6, signal),
        /size limit/,
    );
    await assert.rejects(readBounded(new Response('too long'), 6, signal), /size limit/);
    assert.equal(
        new TextDecoder().decode(await readBounded(new Response('small'), 6, signal)),
        'small',
    );
});

test('resource identifiers preserve meaningful queries and reject unauthorized addresses', () => {
    assert.equal(
        resourceURL('../pic.png?version=2#part', base),
        'https://assets.weread.qq.com/pic.png?version=2',
    );
    assert.equal(
        resourceURL('https://assets.myqcloud.com/pic.png'),
        'https://assets.myqcloud.com/pic.png',
    );
    for (const url of [
        'https://weread.qq.com.other.invalid/img',
        'https://abc@weread.qq.com/img',
        'https://weread.qq.com:123/img',
        'http://weread.qq.com/img',
    ])
        assert.equal(resourceURL(url), undefined);
});

test('large chapter discovery pauses while the pending queue is full', async () => {
    const job = new AbortController();
    let started = 0;
    const queue = createAssetQueue(
        async (_url, _limit, signal) => {
            started++;
            return await new Promise<ResourceResponse>((resolve) => {
                signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), {
                    once: true,
                });
            });
        },
        job.signal,
        () => 0,
    );
    let submitted = false;
    const adding = queue
        .add(
            Array.from({ length: 200 }, (_, n) => n + '.png'),
            base,
        )
        .finally(() => {
            submitted = true;
        });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(submitted, false);
    assert.equal(started, 4);
    assert.equal(queue.result().unique, 36);
    job.abort();
    await assert.rejects(adding, { name: 'AbortError' });
    await queue.drain();
});

test('mistyped resources free their reservation and counts are independent of path lookups', async () => {
    const limits: number[] = [];
    const fakeFont = new TextEncoder().encode('wOF2xxxx');
    const queue = createAssetQueue(
        async (url, limit) => {
            limits.push(limit);
            return { status: 'downloaded', data: url.endsWith('/wrong.png') ? fakeFont : png };
        },
        new AbortController().signal,
        () => 0,
        { budget: 20, maxResource: 8 },
    );
    await queue.add(
        [
            { value: 'wrong.png', kind: 'image' },
            { value: 'wrong.png#duplicate', kind: 'image' },
            { value: 'right.png', kind: 'image' },
            'https://denied.invalid/no.png',
            'https://denied.invalid/no.png#duplicate',
        ],
        base,
    );
    await queue.drain();
    assert.deepEqual(limits, [8, 8]);
    assert.equal(queue.path('wrong.png', base, 'image'), undefined);
    assert.equal(queue.path('wrong.png', base, 'font'), undefined);
    const outcome = queue.result();
    assert.equal(outcome.assets.length, 1);
    assert.equal(outcome.downloaded, 2);
    assert.equal(outcome.unique, 3);
    assert.equal(outcome.references, 5);
    assert.equal(outcome.unavailable, 2);
    assert.equal(outcome.missingReferences, 4);
    assert.deepEqual(outcome.failures, { policy: 1, unsupported: 1 });
});
