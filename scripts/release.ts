import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const manifest: { name: string; version: string } = JSON.parse(
    await readFile('extension/manifest.json', 'utf8'),
);
const pkg: { version: string } = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.name !== 'BookExport')
    throw new Error('Manifest and package versions must match.');

const archive = resolve('BookExport.zip');
const staging = await mkdtemp(resolve('.bookexport-release-'));
try {
    const zip = join(staging, 'BookExport.zip');
    execFileSync(
        'zip',
        [
            '-q',
            '-X',
            '-r',
            zip,
            'LICENSE',
            'manifest.json',
            'background.js',
            'content.js',
            'icons',
            'licenses',
            '-x',
            '*.DS_Store',
            '*.map',
        ],
        { cwd: 'extension' },
    );
    execFileSync('unzip', ['-tq', zip], { stdio: 'inherit' });
    await rename(zip, archive);
    console.log(archive);
} finally {
    await rm(staging, { recursive: true, force: true });
}
