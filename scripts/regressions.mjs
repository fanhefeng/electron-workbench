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

async function resumeShellRecovery(application) {
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.shellReloaded = false;
    globalThis.shellReloadError = undefined;
    BrowserWindow.getAllWindows()[0].webContents.once('did-finish-load', () => {
      globalThis.shellReloaded = true;
    });
    void globalThis.resumeShell().catch((error) => {
      globalThis.shellReloadError = String(error);
    });
  });
  await waitFor(
    () =>
      application.evaluate(() => {
        if (globalThis.shellReloadError) throw new Error(globalThis.shellReloadError);
        return globalThis.shellReloaded;
      }),
    Boolean,
    'Recovered shell did not finish loading',
  );
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
      globalThis.failUpdate = () => updater.emit('error', new Error('Install failed'));
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

await test('IPC rejects another window even when it loads the trusted entry and preload', async (t) => {
  const { application, snapshot } = await launch(t);
  const before = await snapshot();
  const preload = join(resolve('.'), 'out/preload/index.cjs');
  const result = await application.evaluate(async ({ BrowserWindow }, preload) => {
    const hostile = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await hostile.loadURL('workbench-app://shell/');
      return await hostile.webContents.executeJavaScript(
        "window.desktop.updateSettings({ locale: 'en' }).then(() => 'accepted', error => error.message)",
      );
    } finally {
      hostile.destroy();
    }
  }, preload);
  assert.match(result, /Untrusted IPC sender/);
  assert.deepEqual((await snapshot()).settings, before.settings);
});

await test('favicon requests do not attach another site login cookies', async (t) => {
  const { application, open } = await launch(t);
  const draft = await open('favicon-cookie-source');
  const target = `${draft.url}?cross-site-icon=1`;
  await application.evaluate(
    async ({ webContents }, { id, url, target }) => {
      const wc = webContents.fromId(id);
      await wc.loadURL(url.replace('127.0.0.1', 'localhost'));
      await wc.session.cookies.set({
        url,
        name: 'private_session',
        value: 'sensitive',
        sameSite: 'strict',
      });
      wc.session.webRequest.onBeforeSendHeaders({ urls: [target] }, (details, callback) => {
        globalThis.faviconCookieHeaders =
          details.requestHeaders.Cookie ?? details.requestHeaders.cookie ?? '';
        callback({ requestHeaders: details.requestHeaders });
      });
      wc.emit('page-favicon-updated', {}, [target]);
    },
    { id: draft.contentsId, url: draft.url, target },
  );
  const cookie = await waitFor(
    () => application.evaluate(() => globalThis.faviconCookieHeaders),
    (value) => typeof value === 'string',
    'Favicon request did not start',
  );
  assert.equal(
    cookie,
    '',
    'An untrusted favicon URL must not carry authenticated cookies from the page session',
  );
});

await test('IPC rejects an altered shell entry URL and malformed runtime arguments', async (t) => {
  const { application, page, snapshot, open } = await launch(t);
  const draft = await open('ipc-validation');
  const invalid = [
    { method: 'openTab', args: [null] },
    { method: 'activateTab', args: [{}] },
    { method: 'closeTab', args: [false] },
    { method: 'reorderTabs', args: [draft.id, []] },
    { method: 'navigateTab', args: [draft.id, 'file:///etc/passwd'] },
    { method: 'tabAction', args: [draft.id, []] },
    { method: 'setPage', args: [[]] },
    { method: 'setViewport', args: [{ x: 0, y: 0, width: NaN, height: 100 }] },
    { method: 'setOverlay', args: ['true'] },
    { method: 'updateSettings', args: [{ notifications: 'true' }] },
    { method: 'nativeAction', args: [null] },
    { method: 'showDownload', args: [{}] },
    { method: 'updateAction', args: [[]] },
  ];
  for (const { method, args } of invalid) {
    await assert.rejects(
      page.evaluate(({ method, args }) => window.desktop[method](...args), { method, args }),
      undefined,
      method,
    );
  }
  assert.equal((await snapshot()).activeTabId, draft.id);
  const message = await application.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    await win.loadURL('workbench-app://shell/?untrusted=1');
    return win.webContents.executeJavaScript(
      "window.desktop.updateSettings({ locale: 'en' }).then(() => 'accepted', error => error.message)",
    );
  });
  assert.match(message, /Untrusted IPC sender/);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].loadURL('workbench-app://shell/'),
  );
  assert.equal((await snapshot()).settings.locale, 'zh');
});

await test('a later window close cancellation restores a usable workspace', async (t) => {
  const { application, open } = await launch(t);
  await open('close-gate');
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.windowCloseCount = 0;
    win.on('close', (event) => {
      if (++globalThis.windowCloseCount === 2) event.preventDefault();
    });
    win.close();
  });
  await waitFor(
    () => application.evaluate(() => globalThis.windowCloseCount),
    (count) => count === 2,
    'Window did not reach the final close gate',
  );
  await open('after-cancelled-close');
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
  console.error('[DEBUG-recovery] launched');
  application
    .process()
    .stderr.on('data', (chunk) => process.stderr.write(`[DEBUG-recovery-native] ${chunk}`));
  application
    .process()
    .once('exit', (code, signal) => console.error('[DEBUG-recovery] exit', code, signal));
  const draft = await open('draft');
  console.error('[DEBUG-recovery] tab opened');
  const before = await snapshot();
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const load = win.loadURL.bind(win);
    win.loadURL = (...args) =>
      new Promise((resolve, reject) => {
        globalThis.resumeShell = () => load(...args).then(resolve, reject);
      });
    win.webContents.on('render-process-gone', (_event, details) =>
      console.error('[DEBUG-recovery] renderer gone', details.reason),
    );
    win.webContents.on('did-finish-load', () => console.error('[DEBUG-recovery] shell loaded'));
    setImmediate(() => {
      console.error('[DEBUG-recovery] crashing');
      win.webContents.forcefullyCrashRenderer();
      console.error('[DEBUG-recovery] crash requested');
    });
  });
  console.error('[DEBUG-recovery] injection returned');
  await waitFor(
    () => application.evaluate(() => typeof globalThis.resumeShell === 'function'),
    Boolean,
    'Shell renderer crash did not start recovery',
  );
  console.error('[DEBUG-recovery] recovery intercepted');
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
    ),
    true,
  );
  console.error('[DEBUG-recovery] views hidden');
  await menu('CmdOrCtrl+L');
  console.error('[DEBUG-recovery] menu queued');
  await resumeShellRecovery(application);
  console.error('[DEBUG-recovery] resumed');
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
  console.error('[DEBUG-recovery] focus delivered');
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
  console.error('[DEBUG-recovery] assertions complete');
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
  const { application, page, snapshot, open, data } = await launch(t, 'pending');
  await page.waitForFunction(
    async () => (await window.desktop.getSnapshot()).update.status === 'idle',
  );
  await page.evaluate(() => window.desktop.updateSettings({ closeToTray: true }));
  await page.evaluate(() => window.desktop.setPage('settings'));
  await page.evaluate(() => window.desktop.updateAction('check'));
  await page.evaluate(() => window.desktop.updateAction('download'));
  const draft = await open('install-ready');
  await page.evaluate(() => window.desktop.updateSettings({ theme: 'dark' }));
  await page.evaluate(() =>
    Promise.all([
      window.desktop.updateAction('install'),
      window.desktop.updateAction('install'),
      window.desktop.updateAction('check'),
    ]),
  );
  assert.equal(await application.evaluate(() => globalThis.installCalls), 1);
  assert.equal(
    await application.evaluate(({ webContents }, id) => !!webContents.fromId(id), draft.contentsId),
    false,
    'Pages must finish unloading before the installer is invoked',
  );
  assert.equal(
    JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8')).settings.theme,
    'dark',
  );
  assert.equal((await snapshot()).update.status, 'installing');
  await assert.rejects(
    page.evaluate(() => window.desktop.openTab('https://example.com/while-installing')),
    /Workspace is closing/,
  );
  await page.evaluate(() => window.desktop.setPage('settings'));
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

await test('update installation respects cancelled unload and can be retried', async (t) => {
  const { application, page, snapshot, open } = await launch(t, 'pending');
  const draft = await open('install-draft');
  await application.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      .executeJavaScript(
        "window.onbeforeunload = () => false; document.querySelector('#draft').value = 'Keep my update draft';",
        true,
      );
  }, draft.contentsId);
  await page.evaluate(() => window.desktop.updateAction('check'));
  await page.evaluate(() => window.desktop.updateAction('download'));
  await page.evaluate(() => window.desktop.updateAction('install'));
  assert.equal((await snapshot()).update.status, 'downloaded');
  assert.equal(await application.evaluate(() => globalThis.installCalls ?? 0), 0);
  assert.equal(
    await application.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript("document.querySelector('#draft').value"),
      draft.contentsId,
    ),
    'Keep my update draft',
  );
  await application.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id).executeJavaScript('window.onbeforeunload = null');
  }, draft.contentsId);
  await page.evaluate(() => window.desktop.updateAction('install'));
  assert.equal(await application.evaluate(() => globalThis.installCalls), 1);
});

await test('failed update persistence preserves the live document and never invokes the installer', async (t) => {
  const { application, page, snapshot, open, data } = await launch(t, 'pending');
  const draft = await open('install-storage-failure');
  await page.evaluate(() => window.desktop.updateAction('check'));
  await page.evaluate(() => window.desktop.updateAction('download'));
  const file = join(data, 'workspace.json');
  await waitFor(
    () => readFile(file, 'utf8'),
    (content) => JSON.parse(content).activeTabId === draft.id,
    'Workspace did not save',
  );
  await rm(file);
  await mkdir(file);
  try {
    await page.evaluate(() => window.desktop.updateSettings({ theme: 'dark' }));
    await assert.rejects(page.evaluate(() => window.desktop.updateAction('install')));
    assert.equal((await snapshot()).update.status, 'error');
    assert.equal(await application.evaluate(() => globalThis.installCalls ?? 0), 0);
    assert.equal(
      await application.evaluate(
        ({ webContents }, id) => !!webContents.fromId(id),
        draft.contentsId,
      ),
      true,
    );
  } finally {
    await rm(file, { recursive: true, force: true });
  }
});

await test('an installation error during shell recovery restores a usable workspace', async (t) => {
  const { application, page, open } = await launch(t, 'pending');
  const draft = await open('install-recovery');
  await page.evaluate(() => window.desktop.updateAction('check'));
  await page.evaluate(() => window.desktop.updateAction('download'));
  await page.evaluate(() => window.desktop.updateAction('install'));
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const load = win.loadURL.bind(win);
    win.loadURL = (...args) =>
      new Promise((resolve, reject) => {
        globalThis.resumeShell = () => load(...args).then(resolve, reject);
      });
    setImmediate(() => win.webContents.forcefullyCrashRenderer());
  });
  await waitFor(
    () => application.evaluate(() => typeof globalThis.resumeShell === 'function'),
    Boolean,
    'Shell recovery did not start',
  );
  await application.evaluate(() => globalThis.failUpdate());
  await resumeShellRecovery(application);
  const target = `${draft.url}?after-recovery=1`;
  const restored = await application.evaluate(async ({ BrowserWindow }, url) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    await wc.executeJavaScript(`window.desktop.openTab(${JSON.stringify(url)})`);
    return wc.executeJavaScript('window.desktop.getSnapshot()');
  }, target);
  assert.equal(restored.update.status, 'error');
  assert.equal(restored.tabs.find((tab) => tab.id === restored.activeTabId)?.url, target);
});

await test('late tab reorder preserves focus after switching to settings', async (t) => {
  const { application, page, open } = await launch(t);
  await open('reorder-other');
  const draft = await open('reorder-focus');
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('desktop:reorderTabs');
    ipcMain.handle(
      'desktop:reorderTabs',
      () =>
        new Promise((resolve) => {
          globalThis.finishReorder = resolve;
        }),
    );
  });
  await page.locator(`#tab-${draft.id}`).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await waitFor(
    () => application.evaluate(() => !!globalThis.finishReorder),
    Boolean,
    'Reorder did not start',
  );
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await settings.click();
  await application.evaluate(() => globalThis.finishReorder());
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await settings.evaluate((element) => element === document.activeElement), true);
});

const uiResults = resolve('test-results');
await mkdir(uiResults, { recursive: true });

await test('address errors stay beside each input, translate, and clear when edited', async (t) => {
  const { page, snapshot, open } = await launch(t);
  const home = page.locator('.open-form input');
  for (const value of ['https://', 'http://example.com', 'https://user:password@example.com', '']) {
    await home.fill(value);
    await page.locator('.open-form button[type="submit"]').click();
    await page.locator('#home-address-error').waitFor();
    assert.equal(await home.inputValue(), value);
    assert.equal(await home.getAttribute('aria-invalid'), 'true');
    assert.equal(
      await page.locator('#home-address-error').textContent(),
      '请输入有效的 HTTPS 网页地址。',
    );
    assert.equal((await snapshot()).tabs.length, 0);
    assert.equal(await page.locator('.toast').count(), 0);
    if (value === 'https://')
      await page.screenshot({
        path: join(uiResults, 'address-home-light-zh.png'),
        animations: 'disabled',
      });
  }
  await home.fill('example.com');
  assert.equal(await page.locator('#home-address-error').count(), 0);
  assert.equal(await home.getAttribute('aria-invalid'), 'false');
  await home.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal((await snapshot()).tabs.length, 0);

  const first = await open('address-validation');
  await page.evaluate(() => window.desktop.activateTab('home'));
  await home.fill(first.url);
  await home.press('Enter');
  await page.locator('.address-bar input').waitFor();
  assert.equal((await snapshot()).activeTabId, first.id);
  const address = page.locator('.address-bar input');
  await address.fill('https://');
  await address.press('Enter');
  await page.locator('#browser-address-error').waitFor();
  assert.equal((await snapshot()).tabs[0].url, first.url);
  assert.equal(await address.inputValue(), 'https://');
  assert.equal(await page.locator('.toast').count(), 0);
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'en', theme: 'dark' }));
  await page.getByText('Enter a valid HTTPS website address.', { exact: true }).waitFor();
  await page.screenshot({
    path: join(uiResults, 'address-toolbar-dark-en.png'),
    animations: 'disabled',
  });
  await address.fill(`${first.url}?recovered=1`);
  assert.equal(await page.locator('#browser-address-error').count(), 0);
  await address.press('Enter');
  await page.waitForFunction(async () =>
    (await window.desktop.getSnapshot()).tabs[0].url.includes('recovered=1'),
  );

  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#new-url').fill('https://');
  await page.getByRole('button', { name: 'Open page', exact: true }).click();
  await page.getByText('Enter a valid HTTPS website address.', { exact: true }).waitFor();
  assert.equal(await page.locator('#new-url').inputValue(), 'https://');
  assert.equal((await snapshot()).tabs.length, 1);
  await page.locator('#new-url').fill('example.com');
  assert.equal(await page.locator('#url-error').textContent(), '');
  await page.keyboard.press('Escape');
});

await test('late address results preserve newer drafts and a reopened dialog', async (t) => {
  const { application, page, snapshot } = await launch(t);
  await application.evaluate(({ ipcMain }) => {
    globalThis.addressCalls = [];
    ipcMain.removeHandler('desktop:openTab');
    ipcMain.handle(
      'desktop:openTab',
      () => new Promise((resolve, reject) => globalThis.addressCalls.push({ resolve, reject })),
    );
  });
  const home = page.locator('.open-form input');
  await home.fill('example.com');
  await page.locator('.open-form').evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await waitFor(
    () => application.evaluate(() => globalThis.addressCalls.length),
    (count) => count === 1,
    'Address submission must be single-flight',
  );
  await home.fill('new.example');
  await application.evaluate(() => globalThis.addressCalls[0].reject(new Error('Attach failed')));
  await page.waitForFunction(() => !document.querySelector('.open-form button').disabled);
  assert.equal(await home.inputValue(), 'new.example');
  assert.equal(await page.locator('#home-address-error').count(), 0);
  assert.equal(await page.locator('.toast').count(), 0);
  await home.press('Enter');
  await waitFor(
    () => application.evaluate(() => globalThis.addressCalls.length),
    (count) => count === 2,
    'Edited address can be retried',
  );
  await application.evaluate(() => globalThis.addressCalls[1].reject(new Error('Attach failed')));
  await page.getByText('暂时无法打开这个地址，请重试。', { exact: true }).waitFor();

  const trigger = page.getByRole('button', { name: '新建标签页', exact: true });
  await trigger.click();
  await page.locator('#new-url').fill('example.com');
  await page.getByRole('dialog').getByRole('button', { name: '打开页面', exact: true }).click();
  await waitFor(
    () => application.evaluate(() => globalThis.addressCalls.length),
    (count) => count === 3,
    'Dialog submission started',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await trigger.click();
  await page.locator('#new-url').fill('keep-this.example');
  await application.evaluate(() => globalThis.addressCalls[2].resolve());
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  assert.equal(await page.locator('#new-url').inputValue(), 'keep-this.example');
  assert.equal((await snapshot()).tabs.length, 0);
});

await test('a late navigation failure cannot replace another tab address or its feedback', async (t) => {
  const { application, page, open } = await launch(t);
  const other = await open('navigation-other');
  await open('navigation-current');
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('desktop:navigateTab');
    ipcMain.handle(
      'desktop:navigateTab',
      () =>
        new Promise((_resolve, reject) => {
          globalThis.rejectNavigation = reject;
        }),
    );
  });
  const address = page.locator('.address-bar input');
  await address.fill('example.com');
  await address.press('Enter');
  await waitFor(
    () => application.evaluate(() => !!globalThis.rejectNavigation),
    Boolean,
    'Navigation started',
  );
  await page.evaluate((id) => window.desktop.activateTab(id), other.id);
  await page.waitForFunction(
    (url) => document.querySelector('.address-bar input').value === url,
    other.url,
  );
  await application.evaluate(() => globalThis.rejectNavigation(new Error('Navigation failed')));
  assert.equal(await address.inputValue(), other.url);
  assert.equal(await page.locator('#browser-address-error').count(), 0);
  assert.equal(await page.locator('.toast').count(), 0);
});

await test('a late successful navigation preserves a newer address draft', async (t) => {
  const { application, page, snapshot, open } = await launch(t);
  const draft = await open('navigation-draft');
  await application.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    const load = wc.loadURL.bind(wc);
    wc.loadURL = (url) =>
      new Promise((resolve, reject) => {
        globalThis.finishNavigation = () => load(url).then(resolve, reject);
      });
  }, draft.contentsId);
  const address = page.locator('.address-bar input');
  const target = `${draft.url}?navigated=1`;
  await address.fill(target);
  await address.press('Enter');
  await waitFor(
    () => application.evaluate(() => !!globalThis.finishNavigation),
    Boolean,
    'Navigation did not start',
  );
  await address.fill('keep-this-newer.example');
  await application.evaluate(() => globalThis.finishNavigation());
  await waitFor(
    snapshot,
    (state) => state.tabs[0].url === target && !state.tabs[0].loading,
    'Navigation did not finish',
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await address.inputValue(), 'keep-this-newer.example');
  await page.evaluate(() => window.desktop.activateTab('home'));
  await page.evaluate((id) => window.desktop.activateTab(id), draft.id);
  await page.waitForFunction(
    (url) => document.querySelector('.address-bar input').value === url,
    target,
  );
});

await test('overflow list is conditional, keyboard accessible, and preserves embedded pages', async (t) => {
  const { application, page, snapshot, open } = await launch(t);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 680),
  );
  assert.equal(await page.locator('#all-tabs-trigger').count(), 0);
  const pages = [];
  for (let index = 0; index < 5; index += 1) {
    pages.push(await open(`overflow-list-${index}`));
    const tab = pages.at(-1);
    await application.evaluate(
      async ({ webContents }, { id, title }) => {
        await webContents.fromId(id).executeJavaScript(`document.title = ${JSON.stringify(title)}`);
      },
      { id: tab.contentsId, title: `Workspace document ${index} · 完整的项目资料与设计参考标题` },
    );
  }
  const trigger = page.locator('#all-tabs-trigger');
  await trigger.waitFor();
  assert.equal(await trigger.textContent(), '全部标签 (5)');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '全部标签 (5)', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.tab-list-choice').count(), 5);
  assert.equal(
    await dialog
      .locator('.tab-list-choice[aria-current="page"]')
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await dialog.locator('.tab-list-copy strong').first().textContent(),
    'Workspace document 0 · 完整的项目资料与设计参考标题',
  );
  assert.equal(
    await dialog.locator('.tab-list-copy small').first().textContent(),
    new URL(pages[0].url).host,
  );
  await waitFor(
    () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
      ),
    Boolean,
    'Embedded views hide beneath the list',
  );
  await page.screenshot({
    path: join(uiResults, 'all-tabs-light-zh-900.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'all-tabs-trigger');
  await waitFor(
    () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()),
      ),
    Boolean,
    'Embedded page returns after dismissing the list',
  );

  await trigger.click();
  await dialog.locator('.tab-list-choice').first().focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await snapshot()).activeTabId, pages[0].id);
  assert.deepEqual(
    (await snapshot()).tabs.map((tab) => tab.id),
    pages.map((tab) => tab.id),
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length,
    ),
    5,
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1060, 680),
  );
  await trigger.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1040, 680),
  );
  await trigger.waitFor();
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'en', theme: 'dark' }));
  await page.getByRole('button', { name: 'All tabs (5)', exact: true }).waitFor();
  await trigger.click();
  await page.getByRole('dialog', { name: 'All tabs (5)', exact: true }).waitFor();
  await page.getByText('Current', { exact: true }).waitFor();
  await page.screenshot({ path: join(uiResults, 'all-tabs-dark-en.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1400, 680),
  );
  await trigger.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
