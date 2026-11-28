const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const checksumChunk = 4 * 1024 * 1024;

async function crc32(bytes: Uint8Array, signal?: AbortSignal) {
    let crc = 0xffffffff;
    for (let start = 0; start < bytes.length; start += checksumChunk) {
        const end = Math.min(start + checksumChunk, bytes.length);
        for (let index = start; index < end; index++) {
            const byte = bytes[index] ?? 0;
            crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
        }
        if (end < bytes.length && globalThis.scheduler) await scheduler.yield();
        signal?.throwIfAborted();
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
    name: string;
    data: Uint8Array<ArrayBuffer>;
    compress?: boolean;
}

export async function buildZip(entries: Iterable<ZipEntry>, now: number, signal?: AbortSignal) {
    if (Array.isArray(entries) && entries.length >= 0xffff)
        throw new Error('Too many files for a standard ZIP archive.');
    const encoder = new TextEncoder();
    const date = new Date(now);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid ZIP date.');
    const names = new Set<string>();
    const dosTime =
        (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate =
        ((Math.min(127, Math.max(0, date.getFullYear() - 1980)) & 0x7f) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();

    const chunks: BlobPart[] = [];
    const centrals: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    for (const entry of entries) {
        signal?.throwIfAborted();
        if (centrals.length >= 0xfffe)
            throw new Error('Too many files for a standard ZIP archive.');
        if (
            /[\p{Cc}\\:]/u.test(entry.name) ||
            entry.name.split('/').some((part) => !part || part === '.' || part === '..')
        ) {
            throw new Error('Invalid ZIP entry path.');
        }
        if (names.has(entry.name)) throw new Error('Duplicate ZIP entry path: ' + entry.name);
        names.add(entry.name);
        const nameBytes = encoder.encode(entry.name);
        if (nameBytes.length > 0xffff || entry.data.length >= 0xffffffff)
            throw new Error('A file exceeds the ZIP size limit.');
        const checksum = await crc32(entry.data, signal);
        let method = 0;
        let fileData = entry.data;
        if (entry.compress !== false && entry.data.length > 0) {
            method = 8;
            const data = entry.data;
            const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                },
            });
            const stream = source.pipeThrough(
                new CompressionStream('deflate-raw'),
                signal ? { signal } : {},
            );
            fileData = new Uint8Array(await new Response(stream).arrayBuffer());
        }

        signal?.throwIfAborted();
        if (
            fileData.length >= 0xffffffff ||
            offset + 30 + nameBytes.length + fileData.length >= 0xffffffff
        )
            throw new Error('The EPUB exceeds the ZIP size limit.');
        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(8, method, true);
        localView.setUint16(10, dosTime, true);
        localView.setUint16(12, dosDate, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, fileData.length, true);
        localView.setUint32(22, entry.data.length, true);
        localView.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        // Freeze large entries individually so archive assembly cannot copy all of them at once.
        if (fileData.byteLength > checksumChunk) {
            chunks.push(local, new Blob([fileData]));
            if (globalThis.scheduler) await scheduler.yield();
        } else chunks.push(local, fileData);

        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint16(10, method, true);
        centralView.setUint16(12, dosTime, true);
        centralView.setUint16(14, dosDate, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, fileData.length, true);
        centralView.setUint32(24, entry.data.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centrals.push(central);

        offset += local.length + fileData.length;
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    if (offset + centralSize + 22 >= 0xffffffff)
        throw new Error('The EPUB exceeds the ZIP size limit.');
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, centrals.length, true);
    eocdView.setUint16(10, centrals.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    signal?.throwIfAborted();
    return new Blob([...chunks, ...centrals, eocd], { type: 'application/epub+zip' });
}
