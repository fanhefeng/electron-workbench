import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Arch, getArtifactArchName } from 'builder-util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/prepare-release.mjs', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const installers = (
  [
    ['mac', Arch.arm64, 'dmg'],
    ['mac', Arch.arm64, 'zip'],
    ['mac', Arch.x64, 'dmg'],
    ['mac', Arch.x64, 'zip'],
    ['win', Arch.x64, 'exe'],
    ['linux', Arch.x64, 'AppImage'],
  ] as const
)
  .map(
    ([platform, arch, extension]) =>
      `Workbench-${version}-${platform}-${getArtifactArchName(arch, extension)}.${extension}`,
  )
  .sort();
const run = (args: string[], tag = `v${version}`) =>
  execute(process.execPath, [script, ...args], {
    env: { ...process.env, GITHUB_REF_NAME: tag },
  });

test('release rejects version mismatches, missing targets and empty installers', async () => {
  await assert.rejects(run(['--check-tag'], 'v999.0.0'), /Expected version tag/);
  await run(['--check-tag']);
  const directory = await mkdtemp(join(tmpdir(), 'workbench-release-invalid-'));
  try {
    await assert.rejects(run([directory]), /Incomplete or unexpected release assets/);
    for (const name of installers) await writeFile(join(directory, name), '');
    await assert.rejects(run([directory]), /Empty installer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release hashes every platform and architecture without modifying installers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-release-complete-'));
  try {
    const names = installers;
    for (const name of names) await writeFile(join(directory, name), `Installer fixture ${name}`);
    await run([directory]);
    const expected =
      names
        .map(
          (name) =>
            `${createHash('sha256').update(`Installer fixture ${name}`).digest('hex')}  ${name}`,
        )
        .join('\n') + '\n';
    assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), expected);
    await run([directory]);
    assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), expected);
    for (const name of names)
      assert.equal(await readFile(join(directory, name), 'utf8'), `Installer fixture ${name}`);
    await writeFile(join(directory, 'unexpected.exe'), 'Unreviewed installer');
    await assert.rejects(run([directory]), /Incomplete or unexpected release assets/);
    assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
