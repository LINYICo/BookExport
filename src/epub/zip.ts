const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
    name: string;
    data: Uint8Array<ArrayBuffer>;
    compress?: boolean;
}

export async function buildZip(entries: ZipEntry[], now: number, signal?: AbortSignal) {
    if (entries.length >= 0xffff) throw new Error('Too many files for a standard ZIP archive.');
    const encoder = new TextEncoder();
    const date = new Date(now);
    const dosTime =
        (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate =
        (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    const chunks: BlobPart[] = [];
    const centrals: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    for (const entry of entries) {
        signal?.throwIfAborted();
        const nameBytes = encoder.encode(entry.name);
        if (nameBytes.length > 0xffff || entry.data.length >= 0xffffffff)
            throw new Error('A file exceeds the ZIP size limit.');
        const checksum = crc32(entry.data);
        let method = 0;
        let fileData = entry.data;
        if (entry.compress !== false && entry.data.length > 0) {
            method = 8;
            const stream = new Blob([entry.data])
                .stream()
                .pipeThrough(new CompressionStream('deflate-raw'), signal ? { signal } : {});
            fileData = new Uint8Array(await new Response(stream).arrayBuffer());
        }

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
        chunks.push(local, fileData);

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
        if (offset >= 0xffffffff) throw new Error('The EPUB exceeds the ZIP size limit.');
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, centrals.length, true);
    eocdView.setUint16(10, centrals.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    if (offset + centralSize + eocd.length >= 0xffffffff)
        throw new Error('The EPUB exceeds the ZIP size limit.');
    signal?.throwIfAborted();
    return new Blob([...chunks, ...centrals, eocd], { type: 'application/epub+zip' });
}
