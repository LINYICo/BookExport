import { cp, mkdir, rm } from 'node:fs/promises';
import { build, watch } from 'rolldown';
import config from '../rolldown.config.ts';

await rm('dist/extension', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await cp('public', 'dist/extension', { recursive: true });
await cp('LICENSE', 'dist/extension/LICENSE');

if (process.argv.includes('--watch')) {
    const watcher = watch(config);
    watcher.on('event', (event) => {
        if (event.code === 'ERROR') console.error(event.error);
        if (event.code === 'END') console.log('BookExport rebuilt.');
    });
} else {
    for (const entry of config) await build(entry);
}
