import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { test } from 'vite-plus/test';
import { FileMatcher } from 'app-builder-lib/internal';
import { createPackageWithOptions, extractFile, listPackage, statFile } from '@electron/asar';
import { FileList } from 'filelist';

const require = createRequire(import.meta.url);
const fromBuilder = createRequire(require.resolve('app-builder-lib'));

const files = {
  'package.json': '{"name":"fixture","main":"out/main/index.js"}',
  'out/main/index.js': 'main',
  'out/preload/index.cjs': 'preload',
  'out/renderer/index.html': '<title>Workbench</title>',
  'out/renderer/assets/app.js': 'renderer',
  'out/renderer/assets/app.css': 'body {}',
  'out/renderer/assets/.theme.css': 'hidden theme',
  'out/renderer/assets/中文.css': 'unicode theme',
  'out/renderer/assets/app.js.map': 'source map',
  'native/addon.node': 'native fixture',
  'src/private.ts': 'excluded source',
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-packaging-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), content);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('builder file matching keeps entry points, partial directories, hidden and Unicode assets', async () => {
  const directory = await fixture();
  try {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { build: { fileOptions: { files: string[] } } };
    const matcher = new FileMatcher(directory, join(directory, 'release'), (value) => value, [
      ...manifest.build.fileOptions.files,
      '!out/**/*.map',
    ]);
    const filter = matcher.createFilter();
    const actual = [];
    for (const name of Object.keys(files))
      if (filter(join(directory, name), await stat(join(directory, name)))) actual.push(name);
    assert.deepEqual(
      actual,
      Object.keys(files).filter(
        (name) => name === 'package.json' || (name.startsWith('out/') && !name.endsWith('.map')),
      ),
    );
    for (const name of ['out', 'out/renderer', 'out/renderer/assets'])
      assert.equal(filter(join(directory, name), await stat(join(directory, name))), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('extra resources include runtime assets without copying the source app icon', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { build: { fileOptions: { extraResources: { from: string; filter?: string[] }[] } } };
  const resource = manifest.build.fileOptions.extraResources[0];
  const from = join(dirname(fileURLToPath(import.meta.url)), '..', resource.from);
  const matcher = new FileMatcher(
    from,
    join(tmpdir(), 'workbench-resources'),
    (value) => value,
    resource.filter,
  );
  if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*');
  const filter = matcher.createFilter();
  const included = [];
  for (const name of ['icon.png', 'tray.png', 'update.json'])
    if (filter(join(from, name), await stat(join(from, name)))) included.push(name);
  assert.deepEqual(included, ['tray.png', 'update.json']);
});

test('ASAR glob crawling and unpacking preserve packed bytes and native files', async () => {
  const directory = await fixture();
  const archive = join(directory, 'fixture.asar');
  try {
    await createPackageWithOptions(directory, archive, { unpack: '**/*.node' });
    const entries = listPackage(archive, { isPack: false }).map((name) =>
      name.replaceAll('\\', '/'),
    );
    for (const [name, content] of Object.entries(files)) {
      assert.ok(entries.includes(`/${name}`), `Missing archive entry: ${name}`);
      assert.equal(extractFile(archive, name).toString(), content);
    }
    assert.equal(statFile(archive, 'native/addon.node').unpacked, true);
    assert.equal(
      await readFile(`${archive}.unpacked/native/addon.node`, 'utf8'),
      files['native/addon.node'],
    );
    assert.equal(Boolean(statFile(archive, 'out/main/index.js').unpacked), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('filelist includes matching files and excludes explicit paths', async () => {
  const directory = await fixture();
  try {
    const list = new FileList();
    list.include(join(directory, 'out/**/*.js').replaceAll('\\', '/'));
    list.exclude(join(directory, 'out/renderer/assets/app.js').replaceAll('\\', '/'));
    assert.deepEqual(list.toArray(), [join(directory, 'out/main/index.js').replaceAll('\\', '/')]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pathological glob preprocessing respects its expansion budget', async () => {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
    const { Minimatch } = require(workerData.modulePath);
    const matcher = new Minimatch('**/../a/b/'.repeat(18) + 'target', {
      optimizationLevel: 2, braceExpandMax: 64,
    });
    parentPort.postMessage({ alternatives: matcher.set.length, match: matcher.match('target') });`,
    {
      eval: true,
      execArgv: [],
      workerData: { modulePath: fromBuilder.resolve('minimatch') },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ alternatives: number; match: boolean }>(
      (resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) =>
          reject(new Error(`Matcher worker exited before returning: ${code}`)),
        );
        timer = setTimeout(
          () => reject(new Error('Glob preprocessing exceeded its time budget')),
          2000,
        );
      },
    );
    assert.ok(result.alternatives > 0 && result.alternatives <= 64);
    assert.equal(typeof result.match, 'boolean');
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test('lockfile has no matcher versions affected by GHSA-g3hv-75wg-m249', async () => {
  const lock = JSON.parse(
    await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ) as { packages: Record<string, { version?: string }> };
  const matchers = Object.entries(lock.packages).filter(([name]) => name.endsWith('/minimatch'));
  assert.ok(matchers.length > 0);
  for (const [name, entry] of matchers) {
    const version = entry.version ?? '';
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      !version.includes('-') && (major > 11 || (major === 11 && (minor > 0 || patch >= 1))),
      `${name}: ${version}`,
    );
  }
});
