import { readFile, writeFile } from 'node:fs/promises';

const packagePath = new URL('../package.json', import.meta.url);
const lockPath = new URL('../package-lock.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const lock = JSON.parse(await readFile(lockPath, 'utf8'));

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!match) {
	throw new Error(`Cannot increment non-release version: ${packageJson.version}`);
}
const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
packageJson.version = nextVersion;
lock.version = nextVersion;
if (lock.packages?.['']?.name === packageJson.name) {
	lock.packages[''].version = nextVersion;
	lock.packages[''].license = packageJson.license;
	lock.packages[''].engines = packageJson.engines;
	lock.packages[''].devDependencies = packageJson.devDependencies;
}

await writeFile(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);
await writeFile(lockPath, `${JSON.stringify(lock, null, '\t')}\n`);
console.log(`Wuchat build version: ${nextVersion}`);
