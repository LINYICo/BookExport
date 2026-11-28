import { type EpubImage } from './epub/builder.ts';
import { imageExtensionAndType } from './epub/document.ts';
import { resourceLimit, resourceURL, type FetchAsset, type ResourceFailure } from './resource.ts';
import { wait } from './weread/client.ts';

const defaultBudget = 128 * 1024 * 1024;
const maxPending = 32;

function resourceFormat(bytes: Uint8Array) {
    const image = imageExtensionAndType(bytes);
    if (image) return image;
    const magic = new TextDecoder().decode(bytes.subarray(0, 4));
    if (magic === 'wOF2') return { ext: '.woff2', mediaType: 'font/woff2' };
    if (magic === 'wOFF') return { ext: '.woff', mediaType: 'font/woff' };
    if (magic === 'OTTO') return { ext: '.otf', mediaType: 'font/otf' };
    if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
        return { ext: '.ttf', mediaType: 'font/ttf' };
}

type Job = { url: string; index: number; asset?: EpubImage };

export function createAssetQueue(
    fetchAsset: FetchAsset,
    signal: AbortSignal,
    imageDelayMs: () => number,
    { concurrency = 4, budget = defaultBudget, maxResource = resourceLimit } = {},
) {
    const jobs = new Map<string, Job>();
    const pending: Job[] = [];
    const active = new Set<Promise<void>>();
    const failures = new Map<ResourceFailure, number>();
    let retained = 0;
    let reserved = 0;
    let references = 0;

    function fail(status: ResourceFailure) {
        if (status !== 'cancelled') failures.set(status, (failures.get(status) ?? 0) + 1);
    }

    function pump() {
        if (signal.aborted) return;
        while (active.size < concurrency && pending.length) {
            const free = budget - retained - reserved;
            const limit = Math.min(maxResource, Math.floor(free / 2));
            if (limit < maxResource && reserved > 0) return;
            const job = pending.shift();
            if (!job) return;
            if (limit <= 0) {
                fail('limit');
                continue;
            }
            // Allow both the response chunks and the outgoing contiguous buffer in the budget.
            const reservation = limit * 2;
            reserved += reservation;
            const task = download(job, limit, reservation).finally(() => {
                active.delete(task);
                pump();
            });
            active.add(task);
        }
    }

    async function download(job: Job, limit: number, reservation: number) {
        try {
            const result = await fetchAsset(job.url, limit, signal);
            signal.throwIfAborted();
            if (result.status !== 'downloaded') fail(result.status);
            else if (result.data.length > limit) fail('limit');
            else {
                const kind = resourceFormat(result.data);
                if (!kind) fail('unsupported');
                else {
                    retained += result.data.length;
                    job.asset = {
                        href: 'images/image_' + job.index + kind.ext,
                        mediaType: kind.mediaType,
                        data: result.data,
                    };
                }
            }
        } catch {
            if (!signal.aborted) fail('unavailable');
        } finally {
            reserved -= reservation;
        }
        if (!signal.aborted) await wait(imageDelayMs(), signal).catch(() => {});
    }

    async function add(values: Iterable<string>, base: string) {
        for (const value of values) {
            signal.throwIfAborted();
            references++;
            const url = resourceURL(value, base);
            if (!url) {
                fail('policy');
                continue;
            }
            if (jobs.has(url)) continue;
            while (pending.length >= maxPending && active.size) {
                await Promise.race(active);
                signal.throwIfAborted();
            }
            const job = { url, index: jobs.size + 1 };
            jobs.set(url, job);
            pending.push(job);
            pump();
        }
    }

    async function drain() {
        while (active.size) await Promise.all(active);
        if (signal.aborted) pending.length = 0;
    }

    function path(value: string, base: string, imageOnly = false) {
        const url = resourceURL(value, base);
        const asset = url ? jobs.get(url)?.asset : undefined;
        if (asset && (!imageOnly || asset.mediaType.startsWith('image/')))
            return '../' + asset.href;
        if (imageOnly && asset) fail('unsupported');
    }

    function result() {
        const assets = Array.from(jobs.values()).flatMap(({ asset }) => (asset ? [asset] : []));
        return {
            assets,
            references,
            unique: jobs.size,
            failures: Object.fromEntries(failures),
            unavailable: Array.from(failures.values()).reduce((sum, count) => sum + count, 0),
        };
    }

    return { add, drain, path, result };
}
