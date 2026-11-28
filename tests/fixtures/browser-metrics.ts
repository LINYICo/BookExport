import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function browserMetrics(
    send: <Result>(method: string, params?: object, sessionId?: string) => Promise<Result>,
    sessionId: string,
) {
    let samples = 0;
    let heapBytes = 0;
    let browserRssKiB = 0;
    let pending: Promise<void> | undefined;
    async function sample() {
        const [heap, processes] = await Promise.all([
            send<{ usedSize: number }>('Runtime.getHeapUsage', {}, sessionId),
            send<{ processInfo: { id: number }[] }>('SystemInfo.getProcessInfo'),
        ]);
        const ids = processes.processInfo.map(({ id }) => id).join(',');
        const { stdout } = await exec('ps', ['-o', 'rss=', '-p', ids]);
        const rss = stdout
            .trim()
            .split(/\s+/)
            .reduce((total, value) => total + Number(value), 0);
        heapBytes = Math.max(heapBytes, heap.usedSize);
        browserRssKiB = Math.max(browserRssKiB, rss);
        samples++;
    }
    function tick() {
        pending ??= sample()
            .catch(() => {})
            .finally(() => {
                pending = undefined;
            });
    }
    tick();
    const timer = setInterval(tick, 200);
    return async () => {
        clearInterval(timer);
        await pending;
        return { samples, heapBytes, browserRssKiB };
    };
}
