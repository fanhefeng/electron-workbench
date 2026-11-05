import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { clearTimeout } from 'node:timers';
import { waitForBrowserWindow } from './electron-window.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const server = createServer((req, res) => {
  if (req.url === '/favicon.svg' || req.url === '/second-favicon.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    const color = req.url === '/favicon.svg' ? '#4d715a' : '#99604f';
    res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="${color}"/><path d="M4 5v6h3V8h2v3h3V5" fill="#fff"/></svg>`,
    );
    return;
  }
  if (req.url === '/missing-icon.svg') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.url?.startsWith('/canvas')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Canvas probe</title>
      <canvas id="canvas" width="80" height="60" layoutsubtree>
        <div id="source" style="width:80px;height:60px;background:rgb(17,34,51)">HTML</div>
      </canvas>
      <script>
        window.canvasProbe = new Promise((resolve, reject) => {
          const canvas = document.getElementById('canvas');
          const context = canvas.getContext('2d');
          if (typeof context.drawElementImage !== 'function') {
            resolve({ supported: false });
            return;
          }
          const timeout = setTimeout(() => reject(new Error('Canvas paint timed out')), 3000);
          canvas.onpaint = () => {
            try {
              context.drawElementImage(document.getElementById('source'), 0, 0);
              clearTimeout(timeout);
              resolve({ supported: true, pixel: Array.from(context.getImageData(50, 40, 1, 1).data) });
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          };
          canvas.requestPaint();
        });
      </script>`);
    return;
  }
  if (req.url === '/broken') {
    req.socket.destroy();
    return;
  }
  if (req.url === '/file') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="workbench-test.txt"',
    });
    res.end('A real Electron download.');
    return;
  }
  const second = req.url === '/second';
  const icon = second ? '/second-favicon.svg' : '/favicon.svg';
  const title = req.url?.startsWith('/overflow-')
    ? `Long workspace page title ${req.url.slice('/overflow-'.length)} · 项目资料与设计参考`
    : second
      ? 'Second page'
      : 'First page';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!doctype html><title>${title}</title><link rel="icon" href="${icon}"><h1>${second ? 'Second' : 'First'} page</h1><a href="/second">Next page</a><a href="/file">Download</a><a href="/popup" target="_blank">Popup</a>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;
const data = await mkdtemp(join(tmpdir(), 'workbench-e2e-'));
const results = resolve('test-results');
await mkdir(results, { recursive: true });
let application;
const errors = [];
const launch = async ({ heading = '工作区', entry = '.', rendererURL } = {}) => {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  if (rendererURL) env.ELECTRON_RENDERER_URL = rendererURL;
  else delete env.ELECTRON_RENDERER_URL;
  application = await electron.launch({
    executablePath: electronPath,
    args: [entry],
    env,
    timeout: 30000,
  });
  const child = application.process();
  const deadline = setTimeout(() => {
    console.error('Electron smoke timed out');
    child.kill('SIGKILL');
  }, 60000);
  child.once('exit', () => clearTimeout(deadline));
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => window.location.href !== 'about:blank' && !!window.desktop);
  if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  return page;
};
const snapshot = (page) => page.evaluate(() => window.desktop.getSnapshot());
const canvasResult = (url) =>
  application.evaluate(async ({ webContents }, target) => {
    const wc = webContents.getAllWebContents().find((view) => view.getURL() === target);
    if (!wc) throw new Error('Canvas test page is missing');
    return wc.executeJavaScript('window.canvasProbe');
  }, url);
const viewState = (url) =>
  application.evaluate(({ webContents }, target) => {
    const wc = webContents.getAllWebContents().find((item) => item.getURL() === target);
    if (!wc) return null;
    return {
      id: wc.id,
      loading: wc.isLoading(),
      history: wc.navigationHistory.getAllEntries().map((entry) => entry.url),
      index: wc.navigationHistory.getActiveIndex(),
      zoom: wc.getZoomFactor(),
      muted: wc.isAudioMuted(),
    };
  }, url);
const waitReplacement = async (url, previousId) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await viewState(url);
    if (state && state.id !== previousId && !state.loading) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Refreshed view did not settle');
};
const waitState = async (target, predicate, argument) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await target.evaluate(predicate, argument)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`State did not settle: ${predicate}`);
};
try {
  let page = await launch();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const info = await page.evaluate(() => window.desktop.getInfo());
  assert.equal(info.electron, manifest.devDependencies.electron);
  assert.equal(info.version, manifest.version);
  assert.equal(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    await application.evaluate(async ({ net }) => {
      const response = await net.fetch('workbench-app://shell/');
      await response.body?.cancel();
      return response.headers.get('Content-Security-Policy');
    }),
    'production HTML and protocol headers must enforce the same CSP',
  );
  await page.evaluate(() => window.desktop.setPage('settings'));
  await assert.rejects(page.evaluate(() => window.desktop.openTab('file:///etc/passwd')));
  assert.equal((await snapshot(page)).page, 'settings');
  await assert.rejects(page.evaluate(() => window.desktop.activateTab('missing')));
  assert.equal((await snapshot(page)).page, 'settings');
  const settingsBeforeFailure = (await snapshot(page)).settings;
  const themeBeforeFailure = await application.evaluate(
    ({ nativeTheme }) => nativeTheme.themeSource,
  );
  await application.evaluate(({ Menu }) => {
    const set = Menu.setApplicationMenu;
    Menu.setApplicationMenu = () => {
      Menu.setApplicationMenu = set;
      throw new Error('Native configuration failed');
    };
  });
  await assert.rejects(
    page.evaluate(() => window.desktop.updateSettings({ theme: 'dark', closeToTray: true })),
    /Native configuration failed/,
  );
  assert.deepEqual(
    (await snapshot(page)).settings,
    settingsBeforeFailure,
    'native failure rolls settings back',
  );
  assert.equal(
    await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    themeBeforeFailure,
  );
  const contentsBeforeFailure = await application.evaluate(
    ({ webContents }) => webContents.getAllWebContents().length,
  );
  await application.evaluate(({ BrowserWindow }) => {
    const root = BrowserWindow.getAllWindows()[0].contentView;
    const add = root.addChildView;
    root.addChildView = () => {
      root.addChildView = add;
      throw new Error('Attach failed');
    };
  });
  await assert.rejects(
    page.evaluate((url) => window.desktop.openTab(url), `${local}/attach-failure`),
    /Attach failed/,
  );
  assert.equal(
    (await snapshot(page)).tabs.length,
    0,
    'failed creation rolls back the tab descriptor',
  );
  assert.equal(
    (await snapshot(page)).page,
    'settings',
    'creation failure preserves the current page',
  );
  await waitState(
    application,
    ({ webContents }, count) => webContents.getAllWebContents().length === count,
    contentsBeforeFailure,
  );
  await page.evaluate(() => window.desktop.setPage('workspace'));
  await page.screenshot({ path: join(results, 'workspace-light.png') });
  const homeInput = page.locator('.open-form input');
  await homeInput.click();
  assert.deepEqual(
    await homeInput.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return { border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle };
    }),
    { border: '1px', shadow: 'none', outline: 'none' },
    'click focus uses a single thin border without an outer ring',
  );
  const workspaceButton = page.getByRole('button', { name: '工作区', exact: true });
  await workspaceButton.click();
  assert.equal(
    await workspaceButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'none',
  );
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('button', { name: '活动', exact: true })
      .evaluate((el) => window.getComputedStyle(el).outlineWidth),
    '1px',
  );
  const newTabButton = page.getByRole('button', { name: '新建标签页', exact: true });
  await newTabButton.click();
  await page.getByRole('dialog').waitFor();
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'none',
  );
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).borderTopColor),
    'rgba(0, 0, 0, 0)',
  );
  await page.keyboard.press('Escape');
  assert.equal(await newTabButton.evaluate((el) => el === document.activeElement), true);
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'none',
    'a mouse-opened dialog must not leave a keyboard focus ring on its trigger after Escape',
  );
  await page.screenshot({ path: join(results, 'new-tab-pointer-focus.png') });
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(await newTabButton.evaluate((el) => el === document.activeElement), true);
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'solid',
    'Tab navigation must still show the keyboard focus indicator',
  );
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await newTabButton.evaluate((el) => el === document.activeElement), true);
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'solid',
    'a keyboard-opened dialog must restore visible keyboard focus',
  );
  for (const name of ['取消', '关闭']) {
    await newTabButton.click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    assert.equal(await newTabButton.evaluate((el) => el === document.activeElement), true);
    assert.equal(
      await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
      'none',
    );
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await waitState(application, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
  await application.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers });
  });
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  for (const patch of [{ theme: ['dark'] }, { accent: ['moss'] }, { locale: ['en'] }])
    await assert.rejects(page.evaluate((input) => window.desktop.updateSettings(input), patch));
  assert.equal((await snapshot(page)).settings.locale, 'zh');
  await newTabButton.click();
  await page.locator('#new-url').pressSequentially('example.com');
  await page.keyboard.press('Escape');
  assert.equal(
    await newTabButton.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'none',
  );
  await newTabButton.click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#new-url').fill('file:///etc/passwd');
  await page.getByRole('dialog').getByRole('button', { name: '打开页面' }).click();
  await page.getByRole('alert').filter({ hasText: 'HTTPS' }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate((url) => window.desktop.openTab(url), `${local}/first`);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some((t) => t.title === 'First page' && !t.loading),
  );
  const first = (await snapshot(page)).tabs[0];
  assert.ok(
    await application.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      return ['will-navigate', 'will-redirect'].every((name) => {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
        };
        wc.emit(name, event, 'example.com:8443');
        return event.defaultPrevented;
      });
    }, `${local}/first`),
    'navigation guards must reject URLs which require protocol completion',
  );
  if (info.platform === 'darwin') {
    for (const key of ['t', 'l', 'w'])
      await page.locator('.address-bar input').press(`Control+${key}`);
    assert.equal((await snapshot(page)).tabs.length, 1, 'Control must not close macOS tabs');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await application.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      await wc.executeJavaScript(`
        window.controlKeys = [];
        window.addEventListener('keydown', event => window.controlKeys.push(event.key.toLowerCase()));
      `);
      wc.focus();
      for (const keyCode of ['T', 'L', 'W']) {
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
        if (!wc.isDestroyed())
          wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
      }
    }, `${local}/first`);
    await waitState(
      application,
      async ({ webContents }, url) => {
        const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
        return !wc || wc.executeJavaScript("window.controlKeys.at(-1) === 'w'");
      },
      `${local}/first`,
    );
    assert.equal((await snapshot(page)).tabs.length, 1);
    assert.deepEqual(
      await application.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((wc) => wc.getURL() === url)
            .executeJavaScript('window.controlKeys'),
        `${local}/first`,
      ),
      ['t', 'l', 'w'],
    );
  }
  for (const zoom of [1.5, 0.8, 1]) {
    await application.evaluate(
      ({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),
      zoom,
    );
    await waitState(
      application,
      async ({ BrowserWindow }, zoom) => {
        const win = BrowserWindow.getAllWindows()[0];
        const view = win.contentView.children.find((view) => view.getVisible());
        if (!view) return false;
        const rect = await win.webContents.executeJavaScript(
          "document.querySelector('.web-viewport').getBoundingClientRect().toJSON()",
        );
        const bounds = view.getBounds();
        return ['x', 'y', 'width', 'height'].every(
          (key) => Math.abs(bounds[key] - Math.round(rect[key] * zoom)) <= 1,
        );
      },
      zoom,
    );
  }
  await application.evaluate(({ BrowserWindow, webContents }, url) => {
    BrowserWindow.getAllWindows()[0].focus();
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers });
  }, `${local}/first`);
  await waitState(page, async () => (await window.desktop.getSnapshot()).page === 'settings');
  assert.ok(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
    ),
  );
  await page.evaluate((id) => window.desktop.activateTab(id), first.id);
  const selfClosingURL = `${local}/self-close`;
  await page.evaluate((url) => window.desktop.openTab(url), selfClosingURL);
  await waitState(
    page,
    async (url) =>
      (await window.desktop.getSnapshot()).tabs.some((tab) => tab.url === url && !tab.loading),
    selfClosingURL,
  );
  const closingContents = await application.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    const id = wc.id;
    wc.close();
    return id;
  }, selfClosingURL);
  await waitState(application, ({ webContents }, id) => !webContents.fromId(id), closingContents);
  await waitState(
    page,
    async (url) => !(await window.desktop.getSnapshot()).tabs.some((tab) => tab.url === url),
    selfClosingURL,
  );
  const favicon = page.locator(`#tab-${first.id} .tab-leading img`);
  await favicon.waitFor({ timeout: 3000 });
  await page.waitForFunction(
    (id) => {
      const image = document.querySelector(`#tab-${id} .tab-leading img`);
      return image?.complete && image.naturalWidth > 0;
    },
    first.id,
    { timeout: 3000 },
  );
  const firstIcon = await favicon.getAttribute('src');
  assert.ok(firstIcon.startsWith('data:image/svg+xml;base64,'));
  // A remote document must never receive the local native bridge or Node globals.
  assert.deepEqual(
    await application.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
      return wc.executeJavaScript('[typeof window.desktop, typeof require, typeof process]');
    }, `${local}/first`),
    ['undefined', 'undefined', 'undefined'],
  );
  await page
    .evaluate((id) => window.desktop.navigateTab(id, 'file:///etc/passwd'), first.id)
    .then(
      () => assert.fail('unsafe navigation accepted'),
      () => {},
    );
  const remotePage = application
    .context()
    .pages()
    .find((p) => p.url() === `${local}/first`);
  assert.ok(remotePage, 'embedded page is attached to the real browser context');
  await remotePage.getByRole('link', { name: 'Next page', exact: true }).click();
  await waitState(page, async () => (await window.desktop.getSnapshot()).tabs[0]?.canGoBack);
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs[0]?.url.endsWith('/first'),
  );
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs[0]?.url.endsWith('/second'),
  );
  await page.waitForFunction(
    ({ id, previous }) => {
      const image = document.querySelector(`#tab-${id} .tab-leading img`);
      return image?.complete && image.naturalWidth > 0 && image.src !== previous;
    },
    { id: first.id, previous: firstIcon },
  );
  const addressInput = page.locator('.address-bar input');
  await page.locator(`#tab-${first.id}`).click();
  assert.equal(
    await page.locator(`#tab-${first.id}`).evaluate((el) => window.getComputedStyle(el).boxShadow),
    'none',
  );
  await addressInput.click();
  assert.equal(
    await page.locator('.address-bar').evaluate((el) => window.getComputedStyle(el).boxShadow),
    'none',
  );
  const copyButton = page.getByRole('button', { name: '复制地址', exact: true });
  await copyButton.click();
  assert.equal(await copyButton.evaluate((el) => window.getComputedStyle(el).outlineStyle), 'none');
  await page.getByRole('status').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: join(results, 'browser-toolbar.png') });
  await remotePage.evaluate(() => {
    document.querySelector('link[rel="icon"]').href = '/missing-icon.svg';
  });
  await page.waitForFunction(
    (id) => !document.querySelector(`#tab-${id} .tab-leading img`),
    first.id,
  );
  assert.ok(await page.locator(`#tab-${first.id} .tab-leading svg`).isVisible());
  await page.evaluate(({ id, url }) => window.desktop.navigateTab(id, url), {
    id: first.id,
    url: `${local}/broken`,
  });
  await waitState(page, async () => !!(await window.desktop.getSnapshot()).tabs[0]?.error);
  await page.getByRole('heading', { name: '暂时无法打开这个页面' }).waitFor();
  await page.evaluate(({ id, url }) => window.desktop.navigateTab(id, url), {
    id: first.id,
    url: `${local}/second`,
  });
  await waitState(page, async () => {
    const tab = (await window.desktop.getSnapshot()).tabs[0];
    return !tab.error && !tab.loading && tab.url.endsWith('/second');
  });
  assert.ok(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()),
    ),
    'recovered page becomes visible again',
  );
  await page.evaluate((url) => window.desktop.openTab(url), `${local}/third`);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some(
      (tab) => tab.url.endsWith('/third') && !tab.loading,
    ),
  );
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.every((tab) => !tab.loading),
  );
  const second = (await snapshot(page)).tabs[1];
  const firstReorderURL = (await snapshot(page)).tabs.find((tab) => tab.id === first.id).url;
  const firstViewBeforeReorder = await viewState(firstReorderURL);
  const secondViewBeforeReorder = await viewState(second.url);
  const dragTab = async (from, to, x) => {
    await page.bringToFront();
    // A committed reorder can arrive before the native drag has ended.
    await Promise.all([
      page.evaluate(
        () =>
          new Promise((resolve) => {
            document.addEventListener('dragend', () => window.requestAnimationFrame(resolve), {
              once: true,
            });
          }),
      ),
      page.locator(`#tab-${from}`).dragTo(page.locator(`#tab-${to}`), {
        sourcePosition: { x: 50, y: 18 },
        targetPosition: { x, y: 18 },
      }),
    ]);
  };
  // Exercise real native drag events, including both halves of the destination.
  await dragTab(first.id, second.id, 140);
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[0].id === id,
    second.id,
  );
  await dragTab(first.id, second.id, 20);
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[0].id === id,
    first.id,
  );
  await dragTab(second.id, first.id, 20);
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[0].id === id,
    second.id,
  );
  assert.equal((await snapshot(page)).tabs[0].id, second.id);
  assert.equal((await snapshot(page)).activeTabId, second.id, 'reordering preserves selection');
  assert.deepEqual(await viewState(firstReorderURL), firstViewBeforeReorder);
  assert.deepEqual(await viewState(second.url), secondViewBeforeReorder);
  await page.locator(`#tab-${second.id}`).press('Alt+ArrowRight');
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[1].id === id,
    second.id,
  );
  assert.equal(
    await page.locator(`#tab-${second.id}`).evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press('Alt+ArrowLeft');
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[0].id === id,
    second.id,
  );
  await page.keyboard.press('Alt+ArrowLeft');
  assert.equal(
    (await snapshot(page)).activeTabId,
    second.id,
    'sorting cannot move into the pinned home tab',
  );
  await page.evaluate((id) => window.desktop.activateTab(id), first.id);
  await application
    .context()
    .pages()
    .find((p) => p.url().endsWith('/second'))
    .getByRole('link', { name: 'Popup', exact: true })
    .click();
  await waitState(page, async () => (await window.desktop.getSnapshot()).tabs.length === 3);
  const popup = (await snapshot(page)).tabs.find((tab) => tab.url.endsWith('/popup'));
  assert.ok(popup, 'window.open is converted into an isolated managed tab');
  await page.evaluate((id) => window.desktop.closeTab(id), popup.id);
  await page.evaluate((id) => window.desktop.activateTab(id), first.id);
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  const hidden = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
  );
  assert.ok(hidden, 'modal must hide every native web view');
  await page.screenshot({ path: join(results, 'new-page.png') });
  await page.keyboard.press('Escape');
  await page.evaluate((id) => window.desktop.tabAction(id, 'copy'), first.id);
  assert.equal(
    await application.evaluate(async ({ clipboard }) => await clipboard.readText()),
    `${local}/second`,
  );
  const longURL = await remotePage.evaluate(() => {
    window.history.pushState({}, '', `#${'x'.repeat(5000)}`);
    return window.location.href;
  });
  await waitState(
    page,
    async ({ id, url }) =>
      (await window.desktop.getSnapshot()).tabs.find((tab) => tab.id === id)?.url === url,
    { id: first.id, url: longURL },
  );
  await page.evaluate((id) => window.desktop.tabAction(id, 'copy'), first.id);
  assert.equal(await application.evaluate(async ({ clipboard }) => clipboard.readText()), longURL);
  await page.evaluate((id) => window.desktop.tabAction(id, 'devtools'), first.id);
  await waitState(
    application,
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === url)
        .isDevToolsOpened(),
    longURL,
  );
  await application.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === url)
        .closeDevTools(),
    longURL,
  );
  const shot = join(data, 'capture.png');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, shot);
  await page.evaluate((id) => window.desktop.tabAction(id, 'capture'), first.id);
  assert.ok((await readFile(shot)).length > 100);
  await page.evaluate((id) => window.desktop.tabAction(id, 'stop'), first.id);
  await assert.rejects(
    page.evaluate((id) => window.desktop.tabAction(id, 'external'), first.id),
    /HTTPS required/,
  );
  await Promise.all([
    remotePage.waitForEvent('load'),
    page.evaluate((id) => window.desktop.tabAction(id, 'reload'), first.id),
  ]);
  for (const [action, url] of [
    ['back', `${local}/second`],
    ['forward', longURL],
    ['back', `${local}/second`],
  ]) {
    await page.evaluate(({ id, action }) => window.desktop.tabAction(id, action), {
      id: first.id,
      action,
    });
    await waitState(
      page,
      async ({ id, url }) => {
        const tab = (await window.desktop.getSnapshot()).tabs.find((tab) => tab.id === id);
        return tab?.url === url && !tab.loading;
      },
      { id: first.id, url },
    );
  }
  await application.evaluate(
    ({ session }, filePath) => {
      const web = session.fromPartition('persist:web-pages');
      web.on('will-download', (_event, item) => {
        item.setSavePath(filePath);
        item.once('done', () => {
          web.testProgressListeners = item.listenerCount('updated');
        });
      });
    },
    join(data, 'download.txt'),
  );
  await application.evaluate(async ({ webContents }, url) => {
    await webContents
      .getAllWebContents()
      .find((w) => w.getURL().endsWith('/second'))
      .executeJavaScript(`location.href=${JSON.stringify(url)}`);
  }, `${local}/file`);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).downloads.some((d) => d.state === 'completed'),
  );
  assert.equal(await readFile(join(data, 'download.txt'), 'utf8'), 'A real Electron download.');
  assert.equal(
    await application.evaluate(
      ({ session }) => session.fromPartition('persist:web-pages').testProgressListeners,
    ),
    0,
    'completed downloads release progress listeners',
  );
  await page.getByRole('button', { name: '活动', exact: true }).click();
  await page.getByRole('heading', { name: '活动', exact: true }).waitFor();
  await page.screenshot({ path: join(results, 'activity.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const themeSelect = page.getByLabel('主题', { exact: true });
  assert.equal(
    await themeSelect.evaluate((el) => window.getComputedStyle(el).appearance),
    'base-select',
  );
  await page.screenshot({ path: join(results, 'settings-light.png') });
  await themeSelect.click();
  await page.waitForFunction(() => document.getElementById('theme').matches(':open'));
  assert.ok(
    await themeSelect
      .locator('option')
      .evaluateAll((options) =>
        options.every((option) => window.getComputedStyle(option).outlineStyle === 'none'),
      ),
  );
  await page.screenshot({ path: join(results, 'select-open.png') });
  await page.keyboard.press('Escape');
  assert.equal(await themeSelect.evaluate((el) => el.matches(':open')), false);
  assert.equal(await themeSelect.evaluate((el) => el === document.activeElement), true);
  await themeSelect.press('Space');
  await page.waitForFunction(() => document.getElementById('theme').matches(':open'));
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitState(
    page,
    async () => (await window.desktop.getSnapshot()).settings.theme === 'light',
  );
  const restoreSwitch = page.getByRole('switch', { name: '启动时恢复页面', exact: true });
  await restoreSwitch.focus();
  await page.keyboard.press('Space');
  await waitState(page, async () => !(await window.desktop.getSnapshot()).settings.restoreTabs);
  await page.keyboard.press('Space');
  await waitState(page, async () => (await window.desktop.getSnapshot()).settings.restoreTabs);
  assert.equal(
    await page.getByRole('switch', { name: '登录后自动启动', exact: true }).isDisabled(),
    true,
  );
  const canvasSwitch = page.getByRole('switch', { name: 'HTML-in-Canvas', exact: true });
  assert.equal(await canvasSwitch.isChecked(), false);
  const originalView = await application.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url).id,
    `${local}/second`,
  );
  const originalFeature = () =>
    application.evaluate(
      ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript('typeof CanvasRenderingContext2D.prototype.drawElementImage'),
      originalView,
    );
  assert.equal(await originalFeature(), 'undefined');
  await canvasSwitch.focus();
  await canvasSwitch.press('Space');
  await waitState(page, async () => (await window.desktop.getSnapshot()).settings.htmlInCanvas);
  await page.screenshot({ path: join(results, 'settings-canvas-on.png'), animations: 'disabled' });
  const canvasURL = `${local}/canvas`;
  await page.evaluate((url) => window.desktop.openTab(url), canvasURL);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some((t) => t.title === 'Canvas probe' && !t.loading),
  );
  const canvasTab = (await snapshot(page)).tabs.find((tab) => tab.url === canvasURL);
  assert.deepEqual(await canvasResult(canvasURL), { supported: true, pixel: [17, 34, 51, 255] });
  assert.equal(await originalFeature(), 'undefined', 'existing pages keep their renderer state');
  assert.deepEqual(
    await application.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getURL() === url)
          .executeJavaScript('[typeof window.desktop, typeof require, typeof process]'),
      canvasURL,
    ),
    ['undefined', 'undefined', 'undefined'],
  );
  const canvasCurrent = `${canvasURL}?middle`;
  for (const url of [canvasCurrent, `${canvasURL}?last`]) {
    await page.evaluate(({ id, url }) => window.desktop.navigateTab(id, url), {
      id: canvasTab.id,
      url,
    });
    await waitState(
      page,
      async (target) =>
        (await window.desktop.getSnapshot()).tabs.some((tab) => tab.url === target && !tab.loading),
      url,
    );
  }
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some(
      (tab) => tab.url.endsWith('?middle') && !tab.loading,
    ),
  );
  await application.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((item) => item.getURL() === url);
    wc.setZoomFactor(1.25);
    wc.setAudioMuted(true);
  }, canvasCurrent);
  const beforeRefresh = await viewState(canvasCurrent);
  const tabOrder = (await snapshot(page)).tabs.map((tab) => tab.id);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await canvasSwitch.click();
  assert.equal(
    await canvasSwitch.evaluate((el) => window.getComputedStyle(el).outlineStyle),
    'none',
  );
  await waitState(page, async () => !(await window.desktop.getSnapshot()).settings.htmlInCanvas);
  assert.equal((await canvasResult(canvasCurrent)).supported, true);
  await page.getByRole('tab', { name: 'Canvas probe', exact: true }).click();
  // A page which cancels unload must keep its existing runtime and remain usable.
  const canvasPage = application
    .context()
    .pages()
    .find((item) => item.url() === canvasCurrent);
  await canvasPage.locator('canvas').click();
  await canvasPage.evaluate(() => {
    window.onbeforeunload = () => false;
  });
  await application.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    wc.once('will-prevent-unload', () => {
      wc.testReloadCancelled = true;
    });
  }, beforeRefresh.id);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  const cancelDeadline = Date.now() + 5000;
  while (
    !(await application.evaluate(
      ({ webContents }, id) => webContents.fromId(id)?.testReloadCancelled,
      beforeRefresh.id,
    ))
  ) {
    if (Date.now() > cancelDeadline) throw new Error('Unload cancellation was not respected');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal((await viewState(canvasCurrent)).id, beforeRefresh.id);
  await application.evaluate(({ webContents }, id) => {
    webContents.fromId(id).once('will-prevent-unload', (event) => event.preventDefault());
  }, beforeRefresh.id);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  const refreshed = await waitReplacement(canvasCurrent, beforeRefresh.id);
  assert.deepEqual(await canvasResult(canvasCurrent), { supported: false });
  assert.deepEqual({ ...refreshed, id: beforeRefresh.id }, beforeRefresh);
  assert.deepEqual(
    (await snapshot(page)).tabs.map((tab) => tab.id),
    tabOrder,
  );
  assert.equal((await snapshot(page)).activeTabId, canvasTab.id);
  assert.equal(
    await application.evaluate(({ webContents }, id) => !!webContents.fromId(id), beforeRefresh.id),
    false,
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length,
    ),
    3,
  );
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some(
      (tab) => tab.url.endsWith('?last') && !tab.loading,
    ),
  );
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some(
      (tab) => tab.url.endsWith('?middle') && !tab.loading,
    ),
  );
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  assert.equal(
    (await viewState(canvasCurrent)).id,
    refreshed.id,
    'unchanged settings use ordinary reload',
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await canvasSwitch.click();
  await waitState(page, async () => (await window.desktop.getSnapshot()).settings.htmlInCanvas);
  await page.getByRole('tab', { name: 'Canvas probe', exact: true }).click();
  // CDP key dispatch bypasses Electron's before-input-event; use native key events.
  await application.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((item) => item.getURL() === url);
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers });
    if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers });
  }, canvasCurrent);
  const keyboardRefresh = await waitReplacement(canvasCurrent, refreshed.id);
  assert.deepEqual(await canvasResult(canvasCurrent), {
    supported: true,
    pixel: [17, 34, 51, 255],
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await canvasSwitch.click();
  await waitState(page, async () => !(await window.desktop.getSnapshot()).settings.htmlInCanvas);
  await page.getByRole('tab', { name: 'Canvas probe', exact: true }).click();
  await application.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((item) => item.getURL() === url);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
    if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
  }, canvasCurrent);
  const f5Refresh = await waitReplacement(canvasCurrent, keyboardRefresh.id);
  assert.deepEqual(await canvasResult(canvasCurrent), { supported: false });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await canvasSwitch.click();
  await waitState(page, async () => (await window.desktop.getSnapshot()).settings.htmlInCanvas);
  await page.getByRole('tab', { name: 'Canvas probe', exact: true }).click();
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('reload-page').click(),
  );
  const menuRefresh = await waitReplacement(canvasCurrent, f5Refresh.id);
  assert.deepEqual(menuRefresh.history, beforeRefresh.history);
  assert.deepEqual(await canvasResult(canvasCurrent), {
    supported: true,
    pixel: [17, 34, 51, 255],
  });
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length,
    ),
    3,
  );
  await page.evaluate((id) => window.desktop.closeTab(id), canvasTab.id);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await themeSelect.selectOption('dark');
  await page.getByLabel('强调色', { exact: true }).selectOption('moss');
  await page.getByLabel('语言', { exact: true }).selectOption('en');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.screenshot({ path: join(results, 'settings-dark.png'), animations: 'disabled' });
  await page.evaluate(() => window.desktop.updateSettings({ closeToTray: true }));
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
      return win.isVisible();
    }),
    false,
  );
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.evaluate(() => window.desktop.updateSettings({ closeToTray: false }));
  await page.evaluate(() => window.desktop.nativeAction('notify'));
  await page.evaluate(() => window.desktop.updateAction('check'));
  assert.equal((await snapshot(page)).update.status, 'unconfigured');
  await page.evaluate((id) => window.desktop.closeTab(id), second.id);
  assert.equal(
    await application.evaluate(
      ({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getURL().startsWith('http://127.0.0.1'))
          .length,
    ),
    1,
  );
  // Use an HTTPS tab for persistence: test-only HTTP pages are intentionally not restored.
  await page.evaluate(() => window.desktop.openTab('https://example.com/'));
  const unicodeURL = `https://example.com/?saved-tab=${'汉'.repeat(500)}`;
  await page.evaluate((url) => window.desktop.openTab(url), unicodeURL);
  const savedTabs = (await snapshot(page)).tabs.filter((tab) => tab.url.startsWith('https:'));
  await dragTab(savedTabs[1].id, savedTabs[0].id, 20);
  const savedOrder = (await snapshot(page)).tabs
    .filter((tab) => tab.url.startsWith('https:'))
    .map((tab) => tab.id);
  await page.evaluate(() => window.desktop.activateTab('home'));
  await application.close();
  application = undefined;
  // Second launch restores settings and descriptors but does not eagerly create remote processes.
  page = await launch({ heading: 'Workspace' });
  const restored = await snapshot(page);
  assert.equal(restored.settings.theme, 'dark');
  assert.equal(restored.settings.locale, 'en');
  assert.equal(restored.settings.htmlInCanvas, true);
  assert.ok(restored.tabs.some((t) => t.url === 'https://example.com/'));
  assert.ok(restored.tabs.some((t) => t.url === new URL(unicodeURL).href));
  assert.deepEqual(
    restored.tabs.map((tab) => tab.id),
    savedOrder,
    'dragged order survives restart',
  );
  assert.equal(
    await application.evaluate(
      ({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getURL().startsWith('https:')).length,
    ),
    0,
  );
  await page.evaluate(() =>
    window.desktop.updateSettings({ locale: 'zh', theme: 'light', accent: 'graphite' }),
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 680),
  );
  await page.screenshot({ path: join(results, 'workspace-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'en' }));
  await page.evaluate((url) => window.desktop.openTab(url), `${local}/second`);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some((t) => t.title === 'Second page' && !t.loading),
  );
  await page.getByRole('button', { name: 'Open in browser', exact: true }).waitFor();
  await page.screenshot({ path: join(results, 'browser-compact.png'), animations: 'disabled' });
  assert.ok(
    await page.locator('.browser-toolbar').evaluate((el) => el.scrollWidth <= el.clientWidth),
    'icon toolbar fits the compact window with English labels',
  );
  assert.ok(
    await page.locator('.address-bar').evaluate((el) => el.getBoundingClientRect().width >= 200),
    'address field stays usable next to toolbar actions',
  );
  await page.evaluate((url) => window.desktop.openTab(url), canvasURL);
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.some((t) => t.title === 'Canvas probe' && !t.loading),
  );
  assert.deepEqual(await canvasResult(canvasURL), { supported: true, pixel: [17, 34, 51, 255] });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(
    await page.getByRole('switch', { name: 'HTML-in-Canvas', exact: true }).isChecked(),
    true,
  );
  await page.screenshot({ path: join(results, 'settings-compact.png'), animations: 'disabled' });
  assert.ok(await page.locator('.content').evaluate((el) => el.scrollWidth <= el.clientWidth));
  // Fill the compact window to the real tab limit and exercise the hidden overflow.
  for (let index = (await snapshot(page)).tabs.length; index < 12; index++) {
    await page.evaluate((url) => window.desktop.openTab(url), `${local}/overflow-${index}`);
  }
  await waitState(page, async () =>
    (await window.desktop.getSnapshot()).tabs.every((tab) => !tab.loading),
  );
  const overflowTabs = (await snapshot(page)).tabs;
  const scroll = page.locator('.tab-scroll');
  assert.ok(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth));
  assert.deepEqual(
    await scroll.evaluate((el) => ({
      scrollbar: window.getComputedStyle(el).scrollbarWidth,
      height: el.clientHeight,
      tabHeight: el.querySelector('.tab').clientHeight,
    })),
    { scrollbar: 'none', height: 37, tabHeight: 37 },
    'overflow keeps full-height tabs without a scrollbar gutter',
  );
  const lastOverflow = overflowTabs.at(-1).id;
  const visibleInStrip = (id) =>
    page.locator(`#tab-${id}`).evaluate((el) => {
      const tab = el.parentElement.getBoundingClientRect();
      const viewport = el.closest('.tab-scroll').getBoundingClientRect();
      return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
    });
  assert.ok(await visibleInStrip(lastOverflow), 'new active tab is revealed');
  const pinnedHome = await page.locator('#tab-home').boundingBox();
  const pinnedNew = await page.getByRole('button', { name: 'New tab', exact: true }).boundingBox();
  await scroll.hover();
  await page.mouse.wheel(0, -5000);
  await page.waitForFunction(() => document.querySelector('.tab-scroll').scrollLeft === 0);
  await page.mouse.wheel(520, 0);
  await page.waitForFunction(() => document.querySelector('.tab-scroll').scrollLeft > 400);
  assert.deepEqual(await page.locator('#tab-home').boundingBox(), pinnedHome);
  assert.deepEqual(
    await page.getByRole('button', { name: 'New tab', exact: true }).boundingBox(),
    pinnedNew,
  );
  await page.locator('#tab-home').click();
  await page.locator('#tab-home').press('End');
  assert.ok(await visibleInStrip(lastOverflow), 'keyboard selection reveals the last tab');
  await page.keyboard.press('Alt+Home');
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs[0].id === id,
    lastOverflow,
  );
  assert.ok(await visibleInStrip(lastOverflow), 'keyboard reorder reveals the moved tab');
  await page.keyboard.press('Alt+End');
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs.at(-1).id === id,
    lastOverflow,
  );

  // Scroll while holding a real drag at the edge, then cancel with Escape.
  const startDrag = async (id) => {
    const box = await page.locator(`#tab-${id}`).boundingBox();
    await page.mouse.move(box.x + 45, box.y + 18);
    await page.mouse.down();
    await page.mouse.move(box.x + 56, box.y + 18, { steps: 5 });
    await page.mouse.move(box.x + 64, box.y + 18);
    await page.locator('.tab[data-dragging="true"]').waitFor();
  };
  const orderBeforeCancel = (await snapshot(page)).tabs.map((tab) => tab.id);
  const scrollBox = await scroll.boundingBox();
  await startDrag(lastOverflow);
  await page.mouse.move(scrollBox.x + 5, scrollBox.y + 18, { steps: 12 });
  await page.waitForFunction(() => document.querySelector('.tab-scroll').scrollLeft < 2);
  await page.locator('[data-drop-edge]').waitFor();
  await page.screenshot({ path: join(results, 'tabs-drag-overflow.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.locator('.tab[data-dragging="true"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-drop-edge]').count(), 0);
  assert.deepEqual(
    (await snapshot(page)).tabs.map((tab) => tab.id),
    orderBeforeCancel,
  );
  const cancelledScroll = await scroll.evaluate((el) => el.scrollLeft);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(
    await scroll.evaluate((el) => el.scrollLeft),
    cancelledScroll,
    'cancel stops auto-scroll',
  );

  // The opposite edge can move an inactive first tab all the way to the end.
  const firstOverflow = (await snapshot(page)).tabs[0];
  const firstOverflowView = await viewState(firstOverflow.url);
  await startDrag(firstOverflow.id);
  await page.mouse.move(scrollBox.x + scrollBox.width - 4, scrollBox.y + 18, { steps: 12 });
  await page.waitForFunction(() => {
    const el = document.querySelector('.tab-scroll');
    return el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
  });
  // Releasing without another mouse move must work after the scroll changes the hit target.
  await page.locator(`[data-tab-id="${lastOverflow}"][data-drop-edge="after"]`).waitFor();
  await page.mouse.up();
  await waitState(
    page,
    async (id) => (await window.desktop.getSnapshot()).tabs.at(-1).id === id,
    firstOverflow.id,
  );
  assert.equal(
    (await snapshot(page)).activeTabId,
    lastOverflow,
    'dragging an inactive tab preserves selection',
  );
  assert.deepEqual(
    await viewState(firstOverflow.url),
    firstOverflowView,
    'overflow reorder keeps native page state',
  );

  // Check both languages and themes with real overflow and long titles.
  await page.evaluate(() => window.desktop.activateTab('home'));
  await page.screenshot({
    path: join(results, 'tabs-overflow-light-en.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'zh', theme: 'dark' }));
  await page.screenshot({
    path: join(results, 'tabs-overflow-dark-zh.png'),
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.desktop.updateSettings({ locale: 'en' }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (info.platform === 'darwin') {
    const ownedContents = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.map((view) => view.webContents.id),
    );
    const cancelled = await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.once('close', (event) => event.preventDefault());
      win.close();
      return {
        alive: !win.isDestroyed(),
        contents: win.contentView.children.map((view) => view.webContents.id),
      };
    });
    assert.equal(cancelled.alive, true);
    assert.deepEqual(
      cancelled.contents,
      ownedContents,
      'a cancelled window close preserves every page',
    );
    const listeners = await application.evaluate(({ session }) => {
      const web = session.fromPartition('persist:web-pages');
      web.on('will-download', () => {});
      return web.listenerCount('will-download');
    });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
    await waitState(
      application,
      ({ webContents }, ids) => ids.every((id) => !webContents.fromId(id)),
      ownedContents,
    );
    [page] = await Promise.all([
      waitForBrowserWindow(application),
      application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          .items.flatMap((menu) => menu.submenu?.items ?? [])
          .find((item) => item.accelerator === 'CmdOrCtrl+,');
        item.click();
      }),
    ]);
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    assert.equal(
      await application.evaluate(({ session }) =>
        session.fromPartition('persist:web-pages').listenerCount('will-download'),
      ),
      listeners,
      'window recreation does not duplicate download listeners',
    );
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
    [page] = await Promise.all([
      waitForBrowserWindow(application),
      application.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          .items.flatMap((menu) => menu.submenu?.items ?? [])
          .find((item) => item.accelerator === 'CmdOrCtrl+T')
          .click(),
      ),
    ]);
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.getByRole('dialog').waitFor();
    assert.ok(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
      ),
    );
    await page.keyboard.press('Escape');
  }
  await page.evaluate((url) => window.desktop.openTab(url), canvasURL);
  await waitState(
    page,
    async (url) =>
      (await window.desktop.getSnapshot()).tabs.some((tab) => tab.url === url && !tab.loading),
    canvasURL,
  );
  await page.evaluate(() => window.desktop.setPage('settings'));
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((item) => item.accelerator === 'CmdOrCtrl+L')
      .click(),
  );
  await page.waitForFunction(() => {
    const input = document.querySelector('.address-bar input');
    return (
      input === document.activeElement &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length
    );
  });
  await waitState(application, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()),
  );
  const beforeRenderFailure = await snapshot(page);
  await application.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:snapshot', {
        ...state,
        revision: state.revision + 100,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? { ...tab, url: 'invalid', error: 'Render failure probe' }
            : tab,
        ),
      }),
    beforeRenderFailure,
  );
  await page.getByText('界面遇到问题 / Something went wrong.', { exact: true }).waitFor();
  await waitState(application, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
  );
  await page.getByRole('button', { name: '重新载入 / Reload', exact: true }).click();
  await page.locator('.address-bar input').waitFor();
  assert.equal((await snapshot(page)).activeTabId, beforeRenderFailure.activeTabId);
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    ipcMain.removeHandler('desktop:getSnapshot');
    ipcMain.handle('desktop:getSnapshot', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error('Snapshot unavailable');
    });
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const send = wc.send.bind(wc);
    wc.send = (channel, ...args) => {
      if (channel !== 'desktop:snapshot') send(channel, ...args);
    };
  });
  await page.reload();
  await page.getByText('Snapshot unavailable', { exact: false }).waitFor();
  await application.close();
  application = undefined;
  const packagedEntry = join(data, 'packaged-entry.cjs');
  const root = resolve('.');
  // Exercise the production entry decision with the real Application and IPC handlers.
  await writeFile(
    packagedEntry,
    `
    const { app } = require('electron');
    try {
      Object.defineProperty(app, 'isPackaged', { value: true });
      Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(root)} });
      app.setAppPath(${JSON.stringify(root)});
      require(${JSON.stringify(join(root, 'out/main/index.js'))});
    } catch (error) {
      console.error('Packaged-entry fixture failed', error);
      app.exit(1);
    }
  `,
  );
  page = await launch({ heading: null, entry: packagedEntry, rendererURL: local });
  assert.equal(
    page.url(),
    'workbench-app://shell/',
    'production ignores the development renderer URL',
  );
  assert.equal((await page.evaluate(() => window.desktop.getInfo())).packaged, true);
  assert.equal((await snapshot(page)).page, 'workspace');
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `PASS: Electron ${info.electron}, isolated pages, native tab drag/drop and keyboard reorder, overflow scrolling and cancellation, clipboard, screenshot, download, settings, HTML-in-Canvas refresh on/off, real painting, preserved navigation history, native shortcuts/menu, unload cancellation, restart persistence, compact layout.`,
  );
} catch (error) {
  console.error('Smoke failure:', error);
  if (application) {
    const shell = application
      .context()
      .pages()
      .find((page) => page.url().startsWith('workbench-app://shell/'));
    const details = await Promise.allSettled([
      application.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((w) => ({
          id: w.id,
          url: w.getURL(),
          title: w.getTitle(),
          back: w.navigationHistory.canGoBack(),
          entries: w.navigationHistory.getAllEntries(),
        })),
      ),
      shell
        ? shell.evaluate(() => window.desktop.getSnapshot())
        : Promise.resolve('No shell window'),
    ]);
    details.forEach((result, index) =>
      console.error(
        ['Live pages:', 'Snapshot:'][index],
        result.status === 'fulfilled' ? result.value : String(result.reason),
      ),
    );
  }
  throw error;
} finally {
  try {
    if (application) await application.close();
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(data, { recursive: true, force: true });
  }
}
