import { type EpubAsset } from './epub/builder.ts';
import { imageExtensionAndType } from './epub/document.ts';
import {
    resourceLimit,
    resourceURL,
    type FetchAsset,
    type ResourceFailure,
    type ResourceKind,
    type ResourceReference,
} from './resource.ts';
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

type Job = {
    url: string;
    index: number;
    references: Map<ResourceKind | undefined, number>;
    status?: ResourceFailure | 'downloaded';
    asset?: EpubAsset;
    mismatchedType?: string;
    limitedAt?: number;
};

function matchesKind(mediaType: string, kind?: ResourceKind) {
    return !kind || mediaType.startsWith(kind + '/');
}

export function createAssetQueue(
    fetchAsset: FetchAsset,
    signal: AbortSignal,
    resourceDelayMs: () => number,
    { concurrency = 4, budget = defaultBudget, maxResource = resourceLimit } = {},
) {
    const jobs = new Map<string, Job>();
    const pending: Job[] = [];
    const active = new Set<Promise<void>>();
    const rejected = new Map<string, number>();
    let omitted = 0;
    let downloaded = 0;
    let retained = 0;
    let reserved = 0;
    let references = 0;
    let draining = false;
    const noMoreRequests = new AbortController();
    const pacing = AbortSignal.any([signal, noMoreRequests.signal]);

    function pump() {
        if (signal.aborted) return;
        while (active.size < concurrency && pending.length) {
            const free = budget - retained - reserved;
            const limit = Math.min(maxResource, Math.floor(free / 2));
            if (limit < maxResource && reserved > 0) return;
            const job = pending.shift();
            if (!job) return;
            if (limit <= 0) {
                job.status = 'limit';
                job.limitedAt = 0;
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
        if (draining && !pending.length) noMoreRequests.abort();
    }

    async function download(job: Job, limit: number, reservation: number) {
        try {
            const result = await fetchAsset(job.url, limit, signal);
            signal.throwIfAborted();
            if (result.status !== 'downloaded') job.status = result.status;
            else if (result.data.length > limit) job.status = 'limit';
            else {
                downloaded++;
                const kind = resourceFormat(result.data);
                if (
                    !kind ||
                    ![...job.references.keys()].some((expected) =>
                        matchesKind(kind.mediaType, expected),
                    )
                ) {
                    if (kind) job.mismatchedType = kind.mediaType;
                    job.status = 'unsupported';
                } else {
                    job.status = 'downloaded';
                    retained += result.data.length;
                    job.asset = {
                        href: 'images/image_' + job.index + kind.ext,
                        mediaType: kind.mediaType,
                        data: result.data,
                    };
                }
            }
        } catch {
            job.status = signal.aborted ? 'cancelled' : 'unavailable';
        } finally {
            if (job.status === 'limit' && limit < maxResource) job.limitedAt = limit;
            reserved -= reservation;
        }
        if (!pacing.aborted) await wait(resourceDelayMs(), pacing).catch(() => {});
    }

    async function add(values: Iterable<string | ResourceReference>, base: string) {
        if (draining) throw new Error('The resource queue is closed.');
        for (const entry of values) {
            signal.throwIfAborted();
            references++;
            const { value, kind } =
                typeof entry === 'string' ? { value: entry, kind: undefined } : entry;
            if (!value.trim()) {
                omitted++;
                continue;
            }
            const url = resourceURL(value, base);
            if (!url) {
                const key = URL.parse(value, base);
                if (key) key.hash = '';
                const identity = key?.href ?? value;
                rejected.set(identity, (rejected.get(identity) ?? 0) + 1);
                continue;
            }
            const existing = jobs.get(url);
            if (existing) {
                const newKind = !existing.references.has(kind);
                existing.references.set(kind, (existing.references.get(kind) ?? 0) + 1);
                if (
                    !newKind ||
                    !existing.mismatchedType ||
                    !matchesKind(existing.mismatchedType, kind)
                )
                    continue;
                delete existing.mismatchedType;
            }
            while (pending.length >= maxPending && active.size) {
                await Promise.race(active);
                signal.throwIfAborted();
            }
            const job = existing ?? { url, index: jobs.size + 1, references: new Map([[kind, 1]]) };
            jobs.set(url, job);
            pending.push(job);
            pump();
        }
    }

    async function drain() {
        draining = true;
        if (!pending.length) noMoreRequests.abort();
        while (active.size) await Promise.all(active);
        if (signal.aborted) pending.length = 0;
    }

    function path(value: string, base: string, kind?: ResourceKind) {
        const url = resourceURL(value, base);
        const asset = url ? jobs.get(url)?.asset : undefined;
        if (asset && matchesKind(asset.mediaType, kind)) return '../' + asset.href;
    }

    function result(usedPaths?: ReadonlySet<string>) {
        const assets: EpubAsset[] = [];
        const failures = new Map<ResourceFailure, number>();
        if (rejected.size) failures.set('policy', rejected.size);
        let missingReferences = omitted;
        for (const count of rejected.values()) missingReferences += count;
        for (const job of jobs.values()) {
            const { asset, status } = job;
            if (status === 'cancelled') continue;
            const used = asset && (!usedPaths || usedPaths.has('../' + asset.href));
            if (used) assets.push(asset);
            let mismatch = false;
            for (const [kind, count] of job.references) {
                const compatible = asset && matchesKind(asset.mediaType, kind);
                if (!used || !compatible) missingReferences += count;
                if (asset && !compatible) mismatch = true;
            }
            const failure =
                status === 'downloaded' ? (mismatch ? 'unsupported' : undefined) : status;
            if (failure) failures.set(failure, (failures.get(failure) ?? 0) + 1);
        }
        return {
            assets,
            references,
            unique: jobs.size + rejected.size,
            downloaded,
            omitted,
            missingReferences,
            failures: Object.fromEntries(failures),
            unavailable: Array.from(failures.values()).reduce((sum, count) => sum + count, 0),
        };
    }

    function discardUnused(usedPaths: ReadonlySet<string>) {
        for (const job of jobs.values())
            if (job.asset && !usedPaths.has('../' + job.asset.href)) {
                retained -= job.asset.data.length;
                delete job.asset;
            }
    }

    // Only under budget pressure, resolve the whole book with limited jobs treated
    // as available. This protects dependencies that a successful retry could restore.
    async function recoverBudget(
        scan: (resolve: typeof path, use: (path: string) => void) => void | Promise<void>,
    ) {
        if (![...jobs.values()].some((job) => job.limitedAt !== undefined)) return;
        const used = new Set<string>();
        await scan(
            (value, base, kind) => {
                const url = resourceURL(value, base);
                const job = url && jobs.get(url);
                if (job && job.limitedAt !== undefined) return '../pending/' + job.index;
                return path(value, base, kind);
            },
            (href) => used.add(href),
        );
        const before = retained;
        discardUnused(used);
        if (retained === before) return;
        for (const job of jobs.values()) {
            const limit = Math.min(maxResource, Math.floor((budget - retained) / 2));
            if (
                job.limitedAt === undefined ||
                limit <= job.limitedAt ||
                !used.has('../pending/' + job.index)
            )
                continue;
            await wait(resourceDelayMs(), signal);
            await download(job, limit, 0);
            signal.throwIfAborted();
        }
    }

    return { add, drain, path, result, discardUnused, recoverBudget };
}
