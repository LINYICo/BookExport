import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest: { name: string; version: string } = JSON.parse(
    await readFile('dist/extension/manifest.json', 'utf8'),
);
const pkg: { version: string } = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.name !== 'BookExport')
    throw new Error('Manifest and package versions must match.');
const zip = resolve('dist', 'BookExport-v' + manifest.version + '.zip');
await rm(zip, { force: true });
execFileSync('zip', ['-q', '-X', '-r', zip, '.'], { cwd: 'dist/extension' });
execFileSync('unzip', ['-tq', zip], { stdio: 'inherit' });
console.log(zip);
