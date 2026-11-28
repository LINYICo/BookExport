import { ByteLimitError, readBounded } from './io.ts';

export const resourceLimit = 16 * 1024 * 1024;
const approvedHosts = ['weread.qq.com', 'tencent-cloud.com', 'myqcloud.com'];

export type ResourceKind = 'image' | 'font';
export type ResourceReference = { value: string; kind?: ResourceKind | undefined };

export type ResourceFailure =
    | 'unavailable'
    | 'timeout'
    | 'limit'
    | 'unsupported'
    | 'policy'
    | 'cancelled';
export type ResourceResponse =
    | { status: 'downloaded'; data: Uint8Array<ArrayBuffer> }
    | { status: ResourceFailure };
export type FetchAsset = (
    url: string,
    limit: number,
    signal: AbortSignal,
) => Promise<ResourceResponse>;

function bytesStartWith(data: Uint8Array, magic: number[]) {
    if (data.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (data[i] !== magic[i]) return false;
    }
    return true;
}

export function resourceFormat(data: Uint8Array) {
    if (bytesStartWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return { ext: '.png', mediaType: 'image/png' };
    if (bytesStartWith(data, [0xff, 0xd8, 0xff])) return { ext: '.jpg', mediaType: 'image/jpeg' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))
        return { ext: '.gif', mediaType: 'image/gif' };
    if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
        return { ext: '.gif', mediaType: 'image/gif' };
    if (
        bytesStartWith(data, [0x52, 0x49, 0x46, 0x46]) &&
        bytesStartWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])
    )
        return { ext: '.webp', mediaType: 'image/webp' };
    if (bytesStartWith(data, [0x77, 0x4f, 0x46, 0x32]))
        return { ext: '.woff2', mediaType: 'font/woff2' };
    if (bytesStartWith(data, [0x77, 0x4f, 0x46, 0x46]))
        return { ext: '.woff', mediaType: 'font/woff' };
    if (bytesStartWith(data, [0x4f, 0x54, 0x54, 0x4f]))
        return { ext: '.otf', mediaType: 'font/otf' };
    if (bytesStartWith(data, [0, 1, 0, 0])) return { ext: '.ttf', mediaType: 'font/ttf' };
    return null;
}

export function httpsURL(value: string, base?: string) {
    if (!value.trim()) return;
    const url = URL.parse(value, base);
    if (url?.protocol === 'https:' && !url.username && !url.password && !url.port) return url;
}

export function resourceURL(value: string, base?: string) {
    const url = httpsURL(value, base);
    if (
        !url ||
        !approvedHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
    )
        return;
    url.hash = '';
    return url.href;
}

export function resourceRequest(value: unknown) {
    if (!value || typeof value !== 'object' || !('url' in value) || !('limit' in value)) return;
    const { url, limit } = value;
    if (
        typeof url === 'string' &&
        typeof limit === 'number' &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= resourceLimit
    )
        return { url, limit };
}

export function isResourceResponse(value: unknown): value is ResourceResponse {
    if (!value || typeof value !== 'object' || !('status' in value)) return false;
    if (value.status === 'downloaded') {
        return (
            'data' in value &&
            value.data instanceof Uint8Array &&
            value.data.buffer instanceof ArrayBuffer
        );
    }
    return ['unavailable', 'timeout', 'limit', 'unsupported', 'policy', 'cancelled'].some(
        (status) => status === value.status,
    );
}

export async function downloadResource(
    url: string,
    limit: number,
    signal: AbortSignal,
): Promise<ResourceResponse> {
    const address = resourceURL(url);
    if (!address) return { status: 'policy' };
    const deadline = AbortSignal.timeout(15000);
    const abort = AbortSignal.any([signal, deadline]);
    try {
        const response = await fetch(address, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'manual',
            signal: abort,
        });
        // Manual redirects are opaque. Never follow them, even when the eventual host might be allowed.
        if (
            response.type === 'opaqueredirect' ||
            response.redirected ||
            (response.status >= 300 && response.status < 400)
        ) {
            void response.body?.cancel().catch(() => {});
            return { status: 'policy' };
        }
        if (!response.ok || !response.body) {
            void response.body?.cancel().catch(() => {});
            return { status: 'unavailable' };
        }
        if (resourceURL(response.url) !== address) {
            void response.body.cancel().catch(() => {});
            return { status: 'policy' };
        }
        return { status: 'downloaded', data: await readBounded(response, limit, abort) };
    } catch (error) {
        if (signal.aborted) return { status: 'cancelled' };
        if (deadline.aborted) return { status: 'timeout' };
        return { status: error instanceof ByteLimitError ? 'limit' : 'unavailable' };
    }
}
