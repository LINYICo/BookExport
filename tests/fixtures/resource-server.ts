import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';

export async function resourceServer(workspace: string) {
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
    };
    const chunk = Buffer.alloc(65536);
    const server = createServer({ key, cert }, (request, response) => {
        const name =
            new URL(request.url ?? '/', 'https://localhost').pathname.split('/').at(-1) ?? '';
        held.requests.set(name, (held.requests.get(name) ?? 0) + 1);
        if (request.headers.cookie || request.headers.authorization || request.headers.referer)
            held.credentials++;
        held.active++;
        held.peak = Math.max(held.peak, held.active);
        const isHeld = held.hold;
        response.once('close', () => {
            held.active--;
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
            } else response.end(png);
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
