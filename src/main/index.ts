import { app, net, protocol } from 'electron';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application } from './application.ts';
import { Storage } from './storage.ts';
import { createLogger } from './log.ts';
import { parseDeepLink } from '../shared/validation.ts';
import { MAX_TABS } from '../shared/model.ts';
import { shellCSP } from '../shared/csp.ts';

const testing = process.env.WORKBENCH_TEST === '1';
const scheme = app.isPackaged ? 'workbench' : 'workbench-dev';
app.setName(app.isPackaged ? 'Workbench' : 'Workbench Dev');
if (testing) app.setPath('userData', resolve(process.env.WORKBENCH_TEST_DATA ?? '.test-data'));
else if (!app.isPackaged) app.setPath('userData', resolve(app.getPath('appData'), 'Workbench Dev'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'workbench-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();

let application: Application | undefined;
const pending: string[] = [];
const openOrQueue = (url: string) => {
  if (application) {
    try {
      application.openURL(url);
    } catch {
      /* Tab limit. */
    }
  } else if (pending.length < MAX_TABS) pending.push(url);
};
const accept = (value: string) => {
  const url = parseDeepLink(value, scheme);
  if (url) openOrQueue(url);
};
app.on('open-url', (event, url) => {
  event.preventDefault();
  accept(url);
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    argv.forEach(accept);
    application?.show();
  });
  app.on('activate', () => application?.show());
  let quitReady = false;
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitReady || !application) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void application
      .shutdown()
      .then((ready) => {
        if (!ready) return;
        quitReady = true;
        app.quit();
      })
      .catch((error: unknown) => console.error('Could not save workspace before exit', error))
      .finally(() => {
        quitting = false;
      });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app
    .whenReady()
    .then(async () => {
      const log = createLogger(app.getPath('logs'));
      const rendererRoot = resolve(import.meta.dirname, '../renderer');
      protocol.handle('workbench-app', async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== 'shell' || request.method !== 'GET')
          return new Response(null, { status: 403 });
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return new Response(null, { status: 400 });
        }
        const file = resolve(rendererRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
        const child = relative(rendererRoot, file);
        if (child.startsWith(`..${sep}`) || child === '..' || child.includes('\0'))
          return new Response(null, { status: 403 });
        try {
          const result = await net.fetch(pathToFileURL(file).href);
          const headers = new Headers(result.headers);
          headers.set('Content-Security-Policy', shellCSP());
          return new Response(result.body, { status: result.status, headers });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      if (!testing && app.isPackaged) app.setAsDefaultProtocolClient(scheme);
      else if (!testing && process.defaultApp)
        app.setAsDefaultProtocolClient(scheme, process.execPath, [app.getAppPath()]);
      const storage = new Storage(app.getPath('userData'), (error) =>
        log('storage-error', String(error)),
      );
      application = new Application(storage, await storage.load(), log);
      application.createWindow();
      process.argv.forEach(accept);
      pending.splice(0).forEach(openOrQueue);
      log('app-ready', `electron=${process.versions.electron}`);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
