import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import * as path from 'node:path';

const prompt = createInterface({ input: stdin, output: stdout });
try {
	console.log('Install Wuchat:');
	console.log('1. Standalone CLI');
	console.log('2. VS Code extension (local VSIX)');
	const choice = (await prompt.question('Choose 1 or 2: ')).trim();
	if (choice === '1') {
		const build = spawnSync('npm', ['run', 'compile'], { stdio: 'inherit' });
		if (build.status !== 0) process.exit(build.status ?? 1);
		const binDir = path.join(homedir(), '.local', 'bin');
		mkdirSync(binDir, { recursive: true });
		const target = path.join(binDir, platform() === 'win32' ? 'wuchat.cjs' : 'wuchat');
		copyFileSync('dist/wuchat.cjs', target);
		chmodSync(target, 0o755);
		console.log(`Installed ${target}`);
		console.log('Ensure ~/.local/bin is on PATH. Wuchat authentication is used by default when its VS Code bridge is active.');
	} else if (choice === '2') {
		const build = spawnSync('npm', ['run', 'compile'], { stdio: 'inherit' });
		if (build.status !== 0) process.exit(build.status ?? 1);
		const packageResult = spawnSync('npx', ['vsce', 'package', '--no-dependencies', '-o', 'dist/'], { stdio: 'inherit' });
		if (packageResult.status !== 0) process.exit(packageResult.status ?? 1);
		const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
		const vsix = `wuchat-${version}.vsix`;
		if (!((await import('node:fs')).existsSync(path.join('dist', vsix)))) {
			throw new Error(`Expected VSIX artifact dist/${vsix} was not found.`);
		}
		const installed = spawnSync('code', ['--install-extension', path.join('dist', vsix), '--force'], { stdio: 'inherit' });
		if (installed.status !== 0) process.exit(installed.status ?? 1);
	} else {
		throw new Error('Choose 1 or 2.');
	}
} finally {
	prompt.close();
}