import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
// Playwright resolves this runtime registry JSON relative to the extension package root.
copyFileSync('node_modules/playwright-core/browsers.json', 'browsers.json');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode', 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper', 'chromium-bidi/lib/cjs/cdp/CdpConnection'],
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: false,
	minify: false,
	logLevel: 'info',
	legalComments: 'none'
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[wuchat] watching for changes...');
} else {
	await esbuild.build(options);
}
