import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
if (lock.version !== version || lock.packages[''].version !== version)
  throw new Error('package.json and package-lock.json versions must match');
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${version}`) throw new Error(`Expected version tag v${version}, received ${tag}`);
if (process.argv[2] === '--check-tag') process.exit(0);
if (!process.argv[2]) throw new Error('An installer directory is required');

const directory = resolve(process.argv[2]);
const expected = [
  `Workbench-${version}-mac-arm64.dmg`,
  `Workbench-${version}-mac-arm64.zip`,
  `Workbench-${version}-mac-x64.dmg`,
  `Workbench-${version}-mac-x64.zip`,
  `Workbench-${version}-win-x64.exe`,
  `Workbench-${version}-linux-x86_64.AppImage`,
].sort();
const entries = await readdir(directory, { withFileTypes: true });
const actual = entries
  .filter((entry) => entry.name !== 'SHA256SUMS')
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(actual) !== JSON.stringify(expected) || entries.some((entry) => !entry.isFile()))
  throw new Error(`Incomplete or unexpected release assets: ${actual.join(', ')}`);

const checksums = [];
for (const name of expected) {
  const file = join(directory, name);
  if (!(await stat(file)).size) throw new Error(`Empty installer: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log(`Verified ${expected.length} installers for ${tag}; wrote SHA256SUMS.`);
