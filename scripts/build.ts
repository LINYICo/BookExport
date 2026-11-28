import { watch as watchFiles } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { build, watch } from 'rolldown';
import config from '../rolldown.config.ts';

const output = 'dist/extension';
const staticRoot = resolve('public');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(staticRoot, output, { recursive: true });
await cp('LICENSE', join(output, 'LICENSE'));

async function syncManifest() {
    const pkg: { version: string } = JSON.parse(await readFile('package.json', 'utf8'));
    const version = pkg.version;
    if (
        !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(version) ||
        version === '0.0.0' ||
        version.split('.').some((part) => Number(part) > 65535)
    ) {
        throw new Error('Invalid extension version in package.json.');
    }
    const template: object = JSON.parse(await readFile(join(staticRoot, 'manifest.json'), 'utf8'));
    await writeFile(
        join(output, 'manifest.json'),
        JSON.stringify({ ...template, version }, null, 4) + '\n',
    );
}
await syncManifest();

if (process.argv.includes('--watch')) {
    let pending = Promise.resolve();
    watchFiles(staticRoot, { recursive: true }, (_, name) => {
        if (!name) return;
        const source = resolve(staticRoot, name);
        const relativePath = relative(staticRoot, source);
        if (!relativePath || relativePath.startsWith('..')) return;
        const destination = join(output, relativePath);
        pending = pending
            .then(async () => {
                const exists = await stat(source).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                        if (error.code !== 'ENOENT') throw error;
                        return false;
                    },
                );
                if (exists && relativePath === 'manifest.json') await syncManifest();
                else if (exists) {
                    await mkdir(dirname(destination), { recursive: true });
                    await cp(source, destination, { recursive: true });
                } else {
                    await rm(destination, { recursive: true, force: true });
                }
            })
            .catch((error: unknown) => console.error('Could not sync ' + relativePath, error));
    });
    watchFiles('package.json', () => {
        pending = pending
            .then(syncManifest)
            .catch((error: unknown) => console.error('Could not update extension version', error));
    });
    const watcher = watch(config);
    watcher.on('event', (event) => {
        if (event.code === 'ERROR') console.error(event.error);
        if (event.code === 'END') console.log('BookExport rebuilt.');
    });
} else {
    for (const entry of config) await build(entry);
}
