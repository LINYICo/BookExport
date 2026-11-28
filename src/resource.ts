import { ByteLimitError, readBounded } from './io.ts';

export const resourceLimit = 16 * 1024 * 1024;
const approvedHosts = ['weread.qq.com', 'tencent-cloud.com', 'myqcloud.com'];

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

export function resourceURL(value: string, base?: string) {
    if (!value.trim()) return;
    try {
        const url = new URL(value, base);
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
        if (
            !approvedHosts.some(
                (host) => url.hostname === host || url.hostname.endsWith('.' + host),
            )
        )
            return;
        url.hash = '';
        return url.href;
    } catch {
        return undefined;
    }
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
