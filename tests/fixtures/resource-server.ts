import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

function largePng() {
    function chunk(tag: string, data: Buffer) {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(data.length);
        header.write(tag, 4);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(data, crc32(header.subarray(4))));
        return Buffer.concat([header, data, checksum]);
    }
    const width = 2048;
    const height = 1792;
    const dimensions = Buffer.alloc(13);
    dimensions.writeUInt32BE(width);
    dimensions.writeUInt32BE(height, 4);
    dimensions[8] = 8;
    dimensions[9] = 6;
    const pixels = Buffer.alloc((width * 4 + 1) * height);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', dimensions),
        chunk('IDAT', deflateSync(pixels, { level: 0 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

export async function resourceServer(workspace: string, stress = false) {
    const keyFile = join(workspace, 'fixture.key');
    const certFile = join(workspace, 'fixture.pem');
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-nodes',
            '-newkey',
            'rsa:2048',
            '-days',
            '1',
            '-subj',
            '/CN=BookExport fixture',
            '-keyout',
            keyFile,
            '-out',
            certFile,
        ],
        { stdio: 'ignore' },
    );
    const [key, cert, png] = await Promise.all([
        readFile(keyFile),
        readFile(certFile),
        readFile('public/icons/icon48.png'),
    ]);
    const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    const fingerprint = createHash('sha256').update(spki).digest('base64');
    const held = {
        hold: true,
        active: 0,
        peak: 0,
        aborted: 0,
        credentials: 0,
        requests: new Map<string, number>(),
        streamed: 0,
        firstRequestAt: 0,
        lastResponseAt: 0,
    };
    const chunk = Buffer.alloc(65536);
    const large = stress ? largePng() : undefined;
    const server = createServer({ key, cert }, (request, response) => {
        const name =
            new URL(request.url ?? '/', 'https://localhost').pathname.split('/').at(-1) ?? '';
        held.firstRequestAt ||= performance.now();
        held.requests.set(name, (held.requests.get(name) ?? 0) + 1);
        if (request.headers.cookie || request.headers.authorization || request.headers.referer)
            held.credentials++;
        held.active++;
        held.peak = Math.max(held.peak, held.active);
        const isHeld = held.hold;
        response.once('close', () => {
            held.active--;
            held.lastResponseAt = performance.now();
            if (isHeld && !response.writableFinished) held.aborted++;
        });
        response.setHeader('Cache-Control', 'no-store');
        if (isHeld) {
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.write(png.subarray(0, 8));
            return;
        }
        void wait(180).then(() => {
            if (response.destroyed) return;
            if (name.endsWith('redirect.png')) {
                const host =
                    name === 'approved-redirect.png' ? 'assets.myqcloud.com' : 'denied.invalid';
                response.writeHead(302, { Location: 'https://' + host + '/redirect-target.png' });
                response.end();
            } else if (name === 'missing.png') {
                response.writeHead(404);
                response.end();
            } else if (name === 'oversize.png') {
                response.writeHead(200, { 'Content-Type': 'image/png' });
                const stream = Readable.from(
                    (function* () {
                        for (let i = 0; i < 264; i++) {
                            held.streamed += chunk.length;
                            yield chunk;
                        }
                    })(),
                );
                response.once('close', () => stream.destroy());
                stream.pipe(response);
            } else {
                const data = large ?? png;
                response.setHeader('Content-Length', data.length);
                response.end(data);
            }
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('Resource fixture did not start');
    const rules = ['assets.weread.qq.com', 'assets.myqcloud.com', 'denied.invalid']
        .map((host) => 'MAP ' + host + ':443 127.0.0.1:' + address.port)
        .join(', ');
    return {
        held,
        args: [
            '--no-proxy-server',
            '--host-resolver-rules=' + rules,
            '--ignore-certificate-errors-spki-list=' + fingerprint,
        ],
        async close() {
            server.closeAllConnections();
            const closed = once(server, 'close');
            server.close();
            await closed;
        },
    };
}
