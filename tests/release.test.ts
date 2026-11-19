import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

test('install notes render current and future versions and preserve changelog', async () => {
  const helper = new URL('../scripts/release-notes.mjs', import.meta.url).href;
  const template = await readFile(new URL('../docs/install.md', import.meta.url), 'utf8');
  const changelog =
    '**Full Changelog**: https://github.com/fanhefeng/electron-workbench/compare/v0.1.3...v0.1.4';
  const render = (text: string, target: string) =>
    execute(process.execPath, [
      '--input-type=module',
      '-e',
      `import { renderInstallNotes } from ${JSON.stringify(helper)}; console.log(renderInstallNotes(${JSON.stringify(text)}, ${JSON.stringify(target)}, ${JSON.stringify(changelog)}));`,
    ]);
  for (const target of [version, '0.2.0', '0.2.0-beta.1']) {
    const { stdout } = await render(template, target);
    assert.ok(stdout.includes(`Workbench-${target}-linux-x86_64.AppImage`));
    assert.ok(stdout.includes(changelog));
    assert.ok(!stdout.includes('{{'));
    assert.ok(!stdout.includes('xattr -'));
  }
  await assert.rejects(
    render(template + '\nWorkbench-0.0.1-mac-arm64.dmg', version),
    /Unexpected installer/,
  );
  await assert.rejects(render(template + '\n{{UNKNOWN}}', version), /Invalid install guide/);
  await assert.rejects(
    render(template + '\nxattr -dr com.apple.quarantine app', version),
    /security bypass/,
  );
  await assert.rejects(render(template, '../invalid'), /Invalid release version/);
});

test('release notes stay outside assets and use one generation path for create and draft edit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-release-notes-'));
  const notes = join(directory, '..', `${basename(directory)}-notes.md`);
  const changelog = join(directory, '..', `${basename(directory)}-changelog.md`);
  try {
    for (const name of installers) await writeFile(join(directory, name), 'fixture');
    await writeFile(changelog, '**Full Changelog**: preserved');
    await run([directory, notes, changelog]);
    const first = await readFile(notes, 'utf8');
    assert.ok(first.includes('**Full Changelog**: preserved'));
    await run([directory, notes, changelog]);
    assert.equal(await readFile(notes, 'utf8'), first);
    await assert.rejects(run([directory, join(directory, 'notes.md')]), /outside the installer/);
    const workflow = await readFile(
      new URL('../.github/workflows/build.yml', import.meta.url),
      'utf8',
    );
    assert.equal(
      (workflow.match(/--notes-file "\$RUNNER_TEMP\/release-notes.md"/g) || []).length,
      2,
    );
    assert.ok(
      workflow.indexOf('its assets will not be replaced') <
        workflow.indexOf('releases/generate-notes'),
    );
    assert.ok(!workflow.includes('--notes-file docs/install.md'));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(notes, { force: true });
    await rm(changelog, { force: true });
  }
});

test('pull-request signing is restricted to ad-hoc builds without publishing or notarization', async () => {
  const config = new URL('../electron-builder.config.mjs', import.meta.url).href;
  const args = [
    '--input-type=module',
    '-e',
    `import config from ${JSON.stringify(config)}; console.log(JSON.stringify(config));`,
  ];
  const env = {
    ...process.env,
    CSC_FOR_PULL_REQUEST: 'true',
    WORKBENCH_UNSIGNED_RELEASE: '1',
    WORKBENCH_SIGN_IDENTITY: 'must not be used',
  };
  const { stdout } = await execute(process.execPath, args, { env });
  const result = JSON.parse(stdout);
  assert.equal(result.mac.sign.identity, '-');
  assert.equal(result.mac.notarize, false);
  assert.equal(result.win.sign, false);
  assert.equal(result.publish, null);
  await assert.rejects(
    execute(process.execPath, args, { env: { ...env, WORKBENCH_UNSIGNED_RELEASE: '0' } }),
    /credential-free ad-hoc/,
  );
});
