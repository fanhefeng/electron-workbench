import { test, vi } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/main/storage.ts';
import { DEFAULT_SETTINGS, MAX_TABS } from '../src/shared/model.ts';
import { normalizeURL } from '../src/shared/validation.ts';

test('long and encoded page addresses survive a storage round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-long-urls-'));
  try {
    const storage = new Storage(directory, () => {});
    await storage.load();
    const url = normalizeURL(`https://example.com/?q=${'汉'.repeat(500)}`);
    const tabs = [
      { id: 'unicode', title: 'Unicode', url },
      { id: 'long', title: 'Long', url: `https://example.com/#${'x'.repeat(5000)}` },
    ];
    storage.save({ settings: DEFAULT_SETTINGS, tabs, activeTabId: 'unicode' });
    await storage.flush();
    assert.deepEqual((await storage.load()).tabs, tabs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('overlapping saves serialize, flush retains the final user intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-storage-'));
  try {
    const storage = new Storage(directory, (error) => {
      throw error;
    });
    await storage.load();
    storage.save({
      settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
      tabs: [],
      activeTabId: 'home',
    });
    const first = storage.flush();
    storage.save({
      settings: { ...DEFAULT_SETTINGS, theme: 'light', locale: 'en', htmlInCanvas: true },
      tabs: [],
      activeTabId: 'home',
    });
    await Promise.all([first, storage.flush()]);
    const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
    assert.equal(saved.settings.theme, 'light');
    assert.equal(saved.settings.locale, 'en');
    assert.equal((await storage.load()).settings.htmlInCanvas, true);
    assert.equal((await readdir(directory)).includes('workspace.json.tmp'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('restored tabs respect the workspace limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-tab-limit-'));
  try {
    const tabs = Array.from({ length: MAX_TABS + 3 }, (_, index) => ({
      id: `tab-${index}`,
      title: `Tab ${index}`,
      url: `https://example.com/${index}`,
    }));
    await writeFile(
      join(directory, 'workspace.json'),
      JSON.stringify({ settings: DEFAULT_SETTINGS, tabs, activeTabId: tabs[0].id }),
    );
    const storage = new Storage(directory, (error) => {
      throw error;
    });
    assert.deepEqual((await storage.load()).tabs, tabs.slice(0, MAX_TABS));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved settings preserve explicit values and merge missing defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-settings-defaults-'));
  try {
    await writeFile(
      join(directory, 'workspace.json'),
      JSON.stringify({
        settings: {
          theme: 'dark',
          accent: 'moss',
          locale: 'en',
          restoreTabs: true,
          closeToTray: true,
          notifications: false,
          openAtLogin: false,
        },
        tabs: [],
        activeTabId: 'home',
      }),
    );
    const storage = new Storage(directory, (error) => {
      throw error;
    });
    assert.deepEqual((await storage.load()).settings, {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      accent: 'moss',
      locale: 'en',
      closeToTray: true,
      notifications: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid or obsolete saved settings preserve the remaining preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-settings-recovery-'));
  try {
    await writeFile(
      join(directory, 'workspace.json'),
      JSON.stringify({
        settings: {
          theme: 'dark',
          locale: 'en',
          notifications: false,
          htmlInCanvas: 'true',
          retired: true,
        },
        tabs: [],
        activeTabId: 'home',
      }),
    );
    const storage = new Storage(directory, () => {});
    assert.deepEqual((await storage.load()).settings, {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      locale: 'en',
      notifications: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed recovery backup stops loading and preserves the original workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-backup-failure-'));
  const now = vi.spyOn(Date, 'now').mockReturnValue(12345);
  try {
    const file = join(directory, 'workspace.json');
    await writeFile(file, '{broken');
    const backup = `${file}.broken-12345`;
    await mkdir(backup);
    await writeFile(join(backup, 'keep'), 'Existing backup');
    const storage = new Storage(directory, () => {});
    await assert.rejects(storage.load());
    assert.equal(await readFile(file, 'utf8'), '{broken');
    assert.equal(await readFile(join(backup, 'keep'), 'utf8'), 'Existing backup');
  } finally {
    now.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
test('failed overlapping writes clean up and retry only the latest intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-write-failure-'));
  try {
    const storage = new Storage(directory, () => {});
    await storage.load();
    const file = join(directory, 'workspace.json');
    await mkdir(file);
    storage.save({
      settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
      tabs: [],
      activeTabId: 'home',
    });
    const first = storage.flush();
    storage.save({
      settings: { ...DEFAULT_SETTINGS, theme: 'light' },
      tabs: [],
      activeTabId: 'home',
    });
    const second = storage.flush();
    const writes = await Promise.allSettled([first, second]);
    assert.ok(writes.every((result) => result.status === 'rejected'));
    assert.equal((await readdir(directory)).includes('workspace.json.tmp'), false);
    await rm(file, { recursive: true });
    await storage.flush();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).settings.theme, 'light');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a reporter exception cannot poison a later queued write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-writer-recovery-'));
  try {
    const storage = new Storage(directory, () => {
      throw new Error('Reporter failed');
    });
    await storage.load();
    const file = join(directory, 'workspace.json');
    await mkdir(file);
    storage.save({ settings: DEFAULT_SETTINGS, tabs: [], activeTabId: 'home' });
    await assert.rejects(storage.flush());
    await rm(file, { recursive: true });
    storage.save({
      settings: { ...DEFAULT_SETTINGS, locale: 'en' },
      tabs: [],
      activeTabId: 'home',
    });
    await storage.flush();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).settings.locale, 'en');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('corrupt data is preserved before recovery and restored URLs are revalidated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'));
  try {
    await writeFile(join(directory, 'workspace.json'), '{broken');
    const storage = new Storage(directory, () => {});
    const recovered = await storage.load();
    assert.deepEqual(recovered.settings, DEFAULT_SETTINGS);
    assert.ok((await readdir(directory)).some((file) => file.startsWith('workspace.json.broken-')));
    await writeFile(
      join(directory, 'workspace.json'),
      JSON.stringify({
        settings: DEFAULT_SETTINGS,
        tabs: [
          { id: 'bad', title: 'Bad', url: 'file:///etc/passwd' },
          { id: '', title: 'Empty ID', url: 'https://example.com' },
          { id: 'x'.repeat(101), title: 'Long ID', url: 'https://example.com' },
          { id: 'good', title: 'Good', url: 'https://example.com' },
        ],
      }),
    );
    assert.deepEqual(
      (await storage.load()).tabs.map((tab) => tab.id),
      ['good'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid workspace root values are backed up before defaults are used', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-invalid-workspace-'));
  try {
    for (const [index, value] of [[], false, 42, 'workspace', null].entries()) {
      const folder = join(directory, String(index));
      await mkdir(folder);
      const content = JSON.stringify(value);
      await writeFile(join(folder, 'workspace.json'), content);
      const storage = new Storage(folder, () => {});
      assert.deepEqual(await storage.load(), {
        settings: DEFAULT_SETTINGS,
        tabs: [],
        activeTabId: 'home',
      });
      const backups = (await readdir(folder)).filter((name) =>
        name.startsWith('workspace.json.broken-'),
      );
      assert.equal(backups.length, 1, `Missing backup for ${content}`);
      assert.equal(await readFile(join(folder, backups[0]), 'utf8'), content);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
