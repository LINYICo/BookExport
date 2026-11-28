export class ByteLimitError extends Error {}

export async function readBounded(response: Response, limit: number, signal: AbortSignal) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > limit) {
        void response.body?.cancel().catch(() => {});
        throw new ByteLimitError('Response exceeds the size limit.');
    }

    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const cancel = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) throw new ByteLimitError('Response exceeds the size limit.');
            chunks.push(chunk.value);
        }
    } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    signal.throwIfAborted();
    const first = chunks[0];
    if (chunks.length === 1 && first) return first;
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return buffer;
}

export function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
        }, ms);
        function cancel() {
            clearTimeout(timer);
            reject(signal.reason);
        }
        signal.addEventListener('abort', cancel, { once: true });
    });
}
