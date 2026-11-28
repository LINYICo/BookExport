import type { BuildOptions } from 'rolldown';

export default [
    {
        input: 'src/content.ts',
        platform: 'browser',
        transform: { target: 'esnext' },
        moduleTypes: { '.css': 'text' },
        output: {
            file: 'extension/content.js',
            format: 'iife',
            minify: process.argv.includes('--release'),
            sourcemap: process.argv.includes('--watch'),
        },
    },
    {
        input: 'src/background.ts',
        platform: 'browser',
        transform: { target: 'esnext' },
        output: {
            file: 'extension/background.js',
            format: 'es',
            minify: process.argv.includes('--release'),
            sourcemap: process.argv.includes('--watch'),
        },
    },
] satisfies BuildOptions[];
