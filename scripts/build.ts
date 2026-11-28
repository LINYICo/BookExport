import { watch as watchFiles } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { build, watch } from 'rolldown';
import config from '../rolldown.config.ts';

const output = 'dist/extension';
const staticRoot = resolve('public');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(staticRoot, output, { recursive: true });
await cp('LICENSE', join(output, 'LICENSE'));

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
                if (exists) {
                    await mkdir(dirname(destination), { recursive: true });
                    await cp(source, destination, { recursive: true });
                } else {
                    await rm(destination, { recursive: true, force: true });
                }
            })
            .catch((error: unknown) => console.error('Could not sync ' + relativePath, error));
    });
    const watcher = watch(config);
    watcher.on('event', (event) => {
        if (event.code === 'ERROR') console.error(event.error);
        if (event.code === 'END') console.log('BookExport rebuilt.');
    });
} else {
    for (const entry of config) await build(entry);
}
