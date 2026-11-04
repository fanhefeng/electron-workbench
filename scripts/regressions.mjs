import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForBrowserWindow } from './electron-window.mjs';

async function waitFor(read, predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read().catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (value !== undefined && predicate(value)) return value;
    await delay(30);
  }
  assert.fail(message);
}

async function launch(t, updateFailure) {
  const root = resolve('.');
  const data = await mkdtemp(join(tmpdir(), 'workbench-regression-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Draft</title><textarea id="draft">Unsaved draft</textarea>');
  });
  let application;
  t.after(async () => {
    try {
      if (application) {
        await application
          .evaluate(({ BrowserWindow }) => {
            for (const win of BrowserWindow.getAllWindows()) win.destroy();
          })
          .catch(() => {});
        await application.close();
      }
    } finally {
      server.close();
      server.closeAllConnections();
      await rm(data, { recursive: true, force: true });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let entry = root;
  if (updateFailure) {
    await mkdir(join(data, 'resources'));
    await writeFile(
      join(data, 'resources/update.json'),
      JSON.stringify({ url: 'https://update.invalid/' }),
    );
    await copyFile(join(root, 'resources/tray.png'), join(data, 'resources/tray.png'));
    entry = join(data, 'entry.cjs');
    await writeFile(
      entry,
      `const { app } = require('electron');
      Object.defineProperty(app, 'isPackaged', { value: true });
      Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(data)} });
      app.setAppPath(${JSON.stringify(root)});
      const updater = require(${JSON.stringify(join(root, 'node_modules/electron-updater'))}).autoUpdater;
      updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.2.0' });
      updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.2.0' });
      updater.quitAndInstall = () => {
        globalThis.installCalls = (globalThis.installCalls ?? 0) + 1;
        ${updateFailure === 'throw' ? "throw new Error('Install failed');" : updateFailure === 'event' ? "updater.emit('error', new Error('Install failed'));" : ''}
      };
      require(${JSON.stringify(join(root, 'out/main/index.js'))});`,
    );
  }
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  application = await electron.launch({ executablePath: electronPath, args: [entry], env });
  const child = application.process();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  child.once('exit', () => clearTimeout(deadline));
  const page = await application.firstWindow();
  page.setDefaultTimeout(5000);
  await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
  const snapshot = () => page.evaluate(() => window.desktop.getSnapshot());
  const menu = (accelerator) =>
    application.evaluate(
      ({ Menu }, accelerator) =>
        Menu.getApplicationMenu()
          .items.flatMap((item) => item.submenu?.items ?? [])
          .find((item) => item.accelerator === accelerator)
          .click(),
      accelerator,
    );
  const open = async (path) => {
    const url = `http://127.0.0.1:${server.address().port}/${path}`;
    await page.evaluate((url) => window.desktop.openTab(url), url);
    const contentsId = await waitFor(
      () =>
        application.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .find((wc) => wc.getURL() === url && wc.getTitle() === 'Draft' && !wc.isLoading())
              ?.id,
          url,
        ),
      Boolean,
      'Remote document did not load',
    );
    const tab = (await snapshot()).tabs.find((tab) => tab.url === url);
    return { ...tab, contentsId };
  };
  return { application, page, snapshot, menu, open, data };
}

await test('cancelled tab close preserves draft, selection, order and persisted workspace', async (t) => {
  const { application, page, snapshot, open, data } = await launch(t);
  await open('other');
  const draft = await open('draft');
  await application.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      .executeJavaScript(
        `window.onbeforeunload = () => false; document.querySelector('#draft').value = 'Keep this draft';`,
        true,
      );
  }, draft.contentsId);
  const before = await snapshot();
  assert.deepEqual(
    await page.evaluate(
      (id) => Promise.all([window.desktop.closeTab(id), window.desktop.closeTab(id)]),
      draft.id,
    ),
    [false, false],
  );
  const after = await snapshot();
  assert.deepEqual(
    after.tabs.map((tab) => tab.id),
    before.tabs.map((tab) => tab.id),
  );
  assert.equal(after.activeTabId, draft.id);
  await page.evaluate(() => window.desktop.activateTab('home'));
  assert.equal(await page.evaluate((id) => window.desktop.closeTab(id), draft.id), false);
  assert.equal((await snapshot()).activeTabId, 'home');
  await page.evaluate((id) => window.desktop.activateTab(id), draft.id);
  assert.equal(
    await application.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)?.executeJavaScript("document.querySelector('#draft').value"),
      draft.contentsId,
    ),
    'Keep this draft',
  );
  await waitFor(
    async () => JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8')),
    (saved) => saved.tabs.some((tab) => tab.id === draft.id) && saved.activeTabId === draft.id,
    'Cancelled close was persisted as a removed tab',
  );
  await application.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id).executeJavaScript('window.onbeforeunload = null');
  }, draft.contentsId);
  assert.equal(await page.evaluate((id) => window.desktop.closeTab(id), draft.id), true);
  assert.equal(
    (await snapshot()).tabs.some((tab) => tab.id === draft.id),
    false,
  );
  assert.equal(
    await application.evaluate(({ webContents }, id) => !!webContents.fromId(id), draft.contentsId),
    false,
  );
});

await test('window waiter ignores embedded views and selects a BrowserWindow', async (t) => {
  const { application, open } = await launch(t);
  const [page, expected] = await Promise.all([
    waitForBrowserWindow(application),
    open('embedded').then(() =>
      application.evaluate(({ BrowserWindow }) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        void window.loadURL('about:blank');
        return window.id;
      }),
    ),
  ]);
  const window = await application.browserWindow(page);
  try {
    assert.equal(await window.evaluate((window) => window?.id), expected);
  } finally {
    await window.dispose();
  }
});

await test('native window colors follow app and system theme changes', async (t) => {
  const { application, page } = await launch(t);
  const assertBackground = async () => {
    const color = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    );
    const rgb = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
    assert.equal(
      await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor),
      `rgb(${rgb.join(', ')})`,
      'Native and renderer backgrounds must share the current palette',
    );
  };
  await assertBackground();
  for (const theme of ['dark', 'light', 'system']) {
    await page.evaluate((theme) => window.desktop.updateSettings({ theme }), theme);
    await page.waitForFunction(
      async () =>
        document.documentElement.dataset.theme ===
        ((await window.desktop.getSnapshot()).dark ? 'dark' : 'light'),
    );
    await assertBackground();
  }
  for (const theme of ['dark', 'light']) {
    await application.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme;
    }, theme);
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await assertBackground();
  }
});

for (const destination of ['tab', 'settings']) {
  await test(`keyboard close preserves focus after a concurrent ${destination} switch`, async (t) => {
    const { application, page, snapshot, open } = await launch(t);
    const first = await open('first');
    await open('second');
    const third = await open('third');
    await page.evaluate((id) => window.desktop.activateTab(id), first.id);
    await application.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      const close = contents.close.bind(contents);
      contents.close = (options) => {
        globalThis.resumeTabClose = () => {
          contents.close = close;
          delete globalThis.resumeTabClose;
          close(options);
        };
      };
    }, first.contentsId);
    try {
      await page.locator(`#tab-${first.id}`).press('Delete');
      await waitFor(
        () => application.evaluate(() => typeof globalThis.resumeTabClose === 'function'),
        Boolean,
        'Tab close did not wait for the remote document',
      );
      const target =
        destination === 'tab'
          ? page.locator(`#tab-${third.id}`)
          : page.getByRole('button', { name: '设置', exact: true });
      await target.click();
      await application.evaluate(() => globalThis.resumeTabClose());
      await page.locator(`#tab-${first.id}`).waitFor({ state: 'detached' });
      const after = await snapshot();
      assert.equal(after.page, destination === 'tab' ? 'workspace' : 'settings');
      if (destination === 'tab') assert.equal(after.activeTabId, third.id);
      assert.equal(
        await target.evaluate((element) => element === document.activeElement),
        true,
        'An asynchronous close must not focus the previously predicted neighbor',
      );
    } finally {
      await application.evaluate(() => globalThis.resumeTabClose?.()).catch(() => {});
    }
  });
}

await test('home address command focuses and selects the home input', async (t) => {
  const { page, menu, open } = await launch(t);
  const input = page.locator('.open-form input');
  await input.fill('example.com');
  await page.locator('.nav-item').first().focus();
  await menu('CmdOrCtrl+L');
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('.open-form input'),
  );
  assert.equal(
    await input.evaluate((el) => el.selectionEnd - el.selectionStart),
    'example.com'.length,
  );
  await open('page');
  await page.evaluate(() => window.desktop.activateTab('home'));
  await page.evaluate(() => window.desktop.setPage('settings'));
  await menu('CmdOrCtrl+L');
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('.open-form input'),
  );
});

await test('window close and application quit respect cancelled page unload', async (t) => {
  const { application, page, snapshot, open } = await launch(t);
  const draft = await open('draft');
  await application.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id);
    globalThis.cancelledWindowUnloads = 0;
    wc.on('will-prevent-unload', () => {
      globalThis.cancelledWindowUnloads++;
    });
    await wc.executeJavaScript('window.onbeforeunload = () => false; undefined', true);
  }, draft.contentsId);
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.once('close', (event) => event.preventDefault());
    win.close();
  });
  await delay(100);
  assert.equal(
    await application.evaluate(() => globalThis.cancelledWindowUnloads),
    0,
    'A cancelled window event must not start unloading pages',
  );
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(
    () => application.evaluate(() => globalThis.cancelledWindowUnloads),
    (count) => count === 1,
    'Window close bypassed page unload',
  );
  assert.equal((await snapshot()).activeTabId, draft.id);
  await application.evaluate(({ app }) => app.quit());
  await waitFor(
    () => application.evaluate(() => globalThis.cancelledWindowUnloads),
    (count) => count === 2,
    'Application quit bypassed page unload',
  );
  assert.equal(
    (await snapshot()).tabs.some((tab) => tab.id === draft.id),
    true,
  );
  await page.evaluate(() => window.desktop.updateSettings({ closeToTray: true }));
  const hidden = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.close();
    return !win.isVisible();
  });
  assert.equal(hidden, true, 'Cancelling quit must restore normal tray behavior');
  await application.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id).executeJavaScript('window.onbeforeunload = null');
  }, draft.contentsId);
});

await test('failed quit persistence preserves the live page and draft', async (t) => {
  const { application, page, snapshot, open, data } = await launch(t);
  const draft = await open('draft');
  await application.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      .executeJavaScript("document.querySelector('#draft').value = 'Keep my work'");
  }, draft.contentsId);
  const file = join(data, 'workspace.json');
  await waitFor(
    () => readFile(file, 'utf8'),
    (content) => JSON.parse(content).tabs.some((tab) => tab.id === draft.id),
    'Initial workspace was not saved',
  );
  await rm(file);
  await mkdir(file);
  try {
    const errors = [];
    application.process().stderr.on('data', (chunk) => errors.push(chunk.toString()));
    await page.evaluate(() => window.desktop.updateSettings({ theme: 'dark' }));
    await application.evaluate(({ app }) => app.quit());
    await waitFor(
      async () => errors.join(''),
      (text) => text.includes('Could not save workspace before exit'),
      'Quit did not report the write failure',
    );
    assert.equal(
      await application.evaluate(
        ({ webContents }, id) => !!webContents.fromId(id),
        draft.contentsId,
      ),
      true,
      'Failed persistence must not destroy the live document',
    );
    assert.equal(
      await application.evaluate(
        ({ webContents }, id) =>
          webContents.fromId(id).executeJavaScript("document.querySelector('#draft').value"),
        draft.contentsId,
      ),
      'Keep my work',
    );
    assert.equal((await snapshot()).activeTabId, draft.id);
  } finally {
    await rm(file, { recursive: true, force: true });
  }
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'en' }));
  await waitFor(
    () => readFile(file, 'utf8'),
    (content) => JSON.parse(content).settings.locale === 'en',
    'Storage did not recover after the write failure',
  );
});

await test('shell renderer crash hides native pages and reloads the shell without recreating tabs', async (t) => {
  const { application, snapshot, open, menu } = await launch(t);
  const draft = await open('draft');
  const before = await snapshot();
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const load = win.loadURL.bind(win);
    win.loadURL = (...args) =>
      new Promise((resolve, reject) => {
        globalThis.resumeShell = () => load(...args).then(resolve, reject);
      });
    win.webContents.forcefullyCrashRenderer();
  });
  await waitFor(
    () => application.evaluate(() => typeof globalThis.resumeShell === 'function'),
    Boolean,
    'Shell renderer crash did not start recovery',
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
    ),
    true,
  );
  await menu('CmdOrCtrl+L');
  await application.evaluate(() => globalThis.resumeShell());
  await waitFor(
    () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          "document.activeElement === document.querySelector('.address-bar input')",
        ),
      ),
    Boolean,
    'Recovery did not deliver the queued address command',
  );
  const after = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.desktop.getSnapshot()'),
  );
  assert.equal(after.activeTabId, before.activeTabId);
  assert.deepEqual(
    after.tabs.map((tab) => tab.id),
    before.tabs.map((tab) => tab.id),
  );
  assert.equal(
    await application.evaluate(({ webContents }, id) => !!webContents.fromId(id), draft.contentsId),
    true,
  );
});

for (const failure of ['event', 'throw']) {
  await test(`failed update installation (${failure}) keeps close-to-tray working`, async (t) => {
    const { application, page, snapshot } = await launch(t, failure);
    await page.waitForFunction(
      async () => (await window.desktop.getSnapshot()).update.status === 'idle',
    );
    await page.evaluate(() => window.desktop.updateSettings({ closeToTray: true }));
    await page.evaluate(() => window.desktop.updateAction('check'));
    await page.evaluate(() => window.desktop.updateAction('download'));
    if (failure === 'throw')
      await assert.rejects(
        page.evaluate(() => window.desktop.updateAction('install')),
        /Install failed/,
      );
    else await page.evaluate(() => window.desktop.updateAction('install'));
    assert.equal((await snapshot()).update.status, 'error');
    const prevented = await application.evaluate(({ BrowserWindow }) => {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      BrowserWindow.getAllWindows()[0].emit('close', event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true, 'Installation failure must not disable close-to-tray');
    assert.equal((await snapshot()).settings.closeToTray, true);
  });
}

await test('update installation is single-flight and bypasses tray only on native quit', async (t) => {
  const { application, page, snapshot } = await launch(t, 'pending');
  await page.waitForFunction(
    async () => (await window.desktop.getSnapshot()).update.status === 'idle',
  );
  await page.evaluate(() => window.desktop.updateSettings({ closeToTray: true }));
  await page.evaluate(() => window.desktop.setPage('settings'));
  await page.evaluate(() => window.desktop.updateAction('check'));
  await page.evaluate(() => window.desktop.updateAction('download'));
  await page.evaluate(() =>
    Promise.all([
      window.desktop.updateAction('install'),
      window.desktop.updateAction('install'),
      window.desktop.updateAction('check'),
    ]),
  );
  assert.equal(await application.evaluate(() => globalThis.installCalls), 1);
  assert.equal((await snapshot()).update.status, 'installing');
  assert.equal(
    await page.getByRole('button', { name: '重启并安装', exact: true }).isDisabled(),
    true,
  );
  const beforeQuit = await application.evaluate(({ BrowserWindow }) => {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    BrowserWindow.getAllWindows()[0].emit('close', event);
    return event.defaultPrevented;
  });
  assert.equal(beforeQuit, true);
  const afterQuit = await application.evaluate(({ BrowserWindow, autoUpdater }) => {
    autoUpdater.emit('before-quit-for-update');
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    BrowserWindow.getAllWindows()[0].emit('close', event);
    return event.defaultPrevented;
  });
  assert.equal(afterQuit, false);
});
