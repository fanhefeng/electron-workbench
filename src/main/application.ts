import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type {
  Activity,
  Bounds,
  DesktopAPI,
  Page,
  ShellCommand,
  Snapshot,
} from '../shared/model.ts';
import { normalizeURL, settingsPatch } from '../shared/validation.ts';
import { Storage, type SavedState } from './storage.ts';
import { Tabs } from './tabs.ts';
import { Native } from './native.ts';
import { Updater } from './updater.ts';

function windowColors(dark: boolean) {
  return {
    background: dark ? '#1f2125' : '#ffffff',
    overlay: {
      color: dark ? '#25282d' : '#f6f7f8',
      symbolColor: dark ? '#e9ecf0' : '#24272d',
      height: 52,
    },
  };
}

export class Application {
  private win!: BrowserWindow;
  private tabs!: Tabs;
  private native!: Native;
  private updater: Updater;
  private state: Snapshot;
  private overlay = false;
  private quitting = false;
  private shellReady = false;
  private windowClose?: Promise<boolean>;
  private windowCloseApproved = false;
  private watchedSessions = new WeakSet<Session>();
  private readonly pendingCommands = new Set<ShellCommand>();
  private readonly entry =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? `${process.env.ELECTRON_RENDERER_URL}/`
      : 'workbench-app://shell/';

  constructor(
    private storage: Storage,
    saved: SavedState,
    private log: (action: string, detail?: string) => void,
  ) {
    this.state = {
      revision: 0,
      page: 'workspace',
      settings: saved.settings,
      dark: false,
      tabs: saved.settings.restoreTabs
        ? saved.tabs.map((t) => ({ ...t, loading: false, canGoBack: false, canGoForward: false }))
        : [],
      activeTabId: 'home',
      downloads: [],
      activity: [],
      update: { status: 'unconfigured' },
    };
    if (saved.settings.restoreTabs && this.state.tabs.some((t) => t.id === saved.activeTabId))
      this.state.activeTabId = saved.activeTabId;
    this.updater = new Updater(
      () => {
        this.state.update = this.updater.state;
        if (this.state.update.status === 'error') this.tabs?.resume();
        this.changed();
      },
      () => this.requestWindowClose(),
    );
    autoUpdater.on('before-quit-for-update', () => {
      this.quitting = true;
    });
    this.applyTheme();
    nativeTheme.on('updated', () => {
      this.updateWindowTheme();
      this.changed();
    });
    app.setAboutPanelOptions({
      applicationName: 'Workbench',
      applicationVersion: app.getVersion(),
      credits: 'Electron · React · TypeScript',
    });
    this.registerIPC();
  }
  createWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.show();
      return;
    }
    const colors = windowColors(this.state.dark);
    this.win = new BrowserWindow({
      name: 'workbench-main',
      windowStatePersistence: true,
      width: 1240,
      height: 820,
      minWidth: 860,
      minHeight: 600,
      show: false,
      title: 'Workbench',
      backgroundColor: colors.background,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 18, y: 20 },
      titleBarOverlay: process.platform === 'darwin' ? false : colors.overlay,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    });
    const window = this.win;
    this.windowClose = undefined;
    this.windowCloseApproved = false;
    const state = this.state;
    this.tabs = new Tabs({
      window: this.win,
      htmlInCanvas: () => this.state.settings.htmlInCanvas,
      get tabs() {
        return state.tabs;
      },
      get activeTabId() {
        return state.activeTabId;
      },
      set activeTabId(id) {
        state.activeTabId = id;
      },
      visible: () =>
        this.shellReady &&
        this.state.page === 'workspace' &&
        !this.overlay &&
        !this.state.tabs.find((t) => t.id === this.state.activeTabId)?.error,
      changed: (persist) => this.changed(persist),
      activity: (kind, label) => this.addActivity(kind, label),
      onSession: (session) => this.watchDownloads(session),
      command: (command) => this.command(command),
      page: (page) => this.setPage(page),
      report: (error) => this.log('tab-error', String(error)),
    });
    const tabs = this.tabs;
    this.native?.dispose();
    this.native = new Native({
      window: () => this.win,
      settings: () => this.state.settings,
      command: (command) => this.command(command),
      page: (page) => this.setPage(page),
      show: () => this.show(),
      quit: () => {
        app.quit();
      },
      closeTab: () => {
        if (this.win.isDestroyed()) return;
        if (this.state.activeTabId === 'home') this.win.close();
        else
          void this.tabs
            .close(this.state.activeTabId)
            .catch((error) => this.log('tab-error', String(error)));
      },
      reloadTab: (ignoreCache) => this.reloadActive(ignoreCache),
      nextTab: (offset) => {
        this.show();
        const ids = ['home', ...this.state.tabs.map((t) => t.id)];
        this.tabs.activate(
          ids[(ids.indexOf(this.state.activeTabId) + offset + ids.length) % ids.length],
        );
        this.setPage('workspace');
      },
    });
    const native = this.native;
    this.native.configure();
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (window !== this.win || window.isDestroyed() || !isMainFrame || isInPlace) return;
      this.shellReady = false;
      this.tabs.layout();
    });
    this.win.webContents.on('render-process-gone', (_event, details) => {
      if (window !== this.win || window.isDestroyed()) return;
      this.shellReady = false;
      this.tabs.layout();
      this.log('shell-renderer-gone', details.reason);
      if (!this.quitting)
        void this.win
          .loadURL(this.entry)
          .catch((error) => this.log('shell-recovery-failed', String(error)));
    });
    this.win.webContents.on('will-navigate', (event, url) => {
      if (url !== this.entry) event.preventDefault();
    });
    this.win.webContents.on('will-redirect', (event) => event.preventDefault());
    this.win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F5' && !input.isComposing) {
        event.preventDefault();
        this.reloadActive(input.shift || input.control);
      }
    });
    this.win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    this.win.webContents.session.setPermissionCheckHandler(() => false);
    this.win.webContents.on('did-finish-load', () => {
      if (window !== this.win || window.isDestroyed()) return;
      this.shellReady = true;
      this.overlay = false;
      this.tabs.activate(this.state.activeTabId);
      this.changed();
      const pending = [...this.pendingCommands];
      this.pendingCommands.clear();
      pending.forEach((command) => this.deliverCommand(command));
    });
    this.win.on('ready-to-show', () => {
      this.win.show();
    });
    this.win.on('resize', () => {
      this.tabs.layout();
    });
    this.win.on('close', (event) => {
      if (this.state.settings.closeToTray && !this.quitting) {
        event.preventDefault();
        if (this.windowCloseApproved) tabs.resume();
        this.win.hide();
        return;
      }
      if (this.windowCloseApproved) {
        queueMicrotask(() => {
          if (event.defaultPrevented) tabs.resume();
        });
        return;
      }
      if (this.quitting || event.defaultPrevented) return;
      const preventDefault = event.preventDefault;
      let cancelled = false;
      // Distinguish a later listener's cancellation from our asynchronous close gate.
      event.preventDefault = () => {
        cancelled = true;
        preventDefault.call(event);
      };
      preventDefault.call(event);
      queueMicrotask(() => {
        event.preventDefault = preventDefault;
        if (cancelled || window.isDestroyed()) return;
        void this.requestWindowClose()
          .then((closed) => {
            if (!closed || window.isDestroyed()) return;
            this.windowCloseApproved = true;
            try {
              window.close();
            } finally {
              this.windowCloseApproved = false;
            }
          })
          .catch((error) => this.log('window-close-error', String(error)));
      });
    });
    this.win.on('closed', () => {
      if (window === this.win) {
        this.shellReady = false;
        this.pendingCommands.clear();
      }
      tabs.dispose();
      native.dispose();
    });
    void this.win
      .loadURL(this.entry)
      .catch((error) => this.log('shell-load-failed', String(error)));
    this.log('window-created');
  }
  show(): void {
    if (!this.win || this.win.isDestroyed()) {
      this.createWindow();
      return;
    }
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
  openURL(url: string): void {
    this.show();
    this.tabs.open(url);
    this.setPage('workspace');
  }
  async shutdown(): Promise<boolean> {
    if (!this.quitting && !(await this.requestWindowClose())) return false;
    this.quitting = true;
    try {
      await this.storage.flush();
      return true;
    } catch (error) {
      this.quitting = false;
      this.tabs.resume();
      throw error;
    }
  }
  private requestWindowClose(): Promise<boolean> {
    if (!this.win || this.win.isDestroyed()) return Promise.resolve(true);
    if (this.windowClose) return this.windowClose;
    const tabs = this.tabs;
    const task = this.storage
      .flush()
      .then(async () => {
        if (!(await tabs.closeViews())) return false;
        await this.storage.flush();
        return true;
      })
      .catch((error: unknown) => {
        tabs.resume();
        throw error;
      })
      .finally(() => {
        if (this.windowClose === task) this.windowClose = undefined;
      });
    this.windowClose = task;
    return task;
  }
  private applyTheme(): void {
    nativeTheme.themeSource = this.state.settings.theme;
    this.updateWindowTheme();
  }
  private updateWindowTheme(): void {
    this.state.dark = nativeTheme.shouldUseDarkColors;
    if (!this.win || this.win.isDestroyed()) return;
    const colors = windowColors(this.state.dark);
    this.win.setBackgroundColor(colors.background);
    if (process.platform !== 'darwin') this.win.setTitleBarOverlay(colors.overlay);
  }
  private changed(persist = false): void {
    this.state.revision++;
    if (
      this.shellReady &&
      this.win &&
      !this.win.isDestroyed() &&
      !this.win.webContents.isDestroyed()
    )
      this.win.webContents.send('desktop:snapshot', this.state);
    if (persist)
      this.storage.save({
        settings: this.state.settings,
        tabs: this.state.tabs.map(({ id, title, url }) => ({ id, title, url })),
        activeTabId: this.state.activeTabId,
      });
  }
  private addActivity(kind: Activity['kind'], label: string): void {
    this.state.activity.unshift({ id: randomUUID(), time: Date.now(), kind, label });
    this.state.activity = this.state.activity.slice(0, 50);
    this.log(kind, label.slice(0, 120));
  }
  private setPage(page: Page): void {
    this.show();
    this.state.page = page;
    this.tabs.layout();
    this.changed();
    this.win.webContents.focus();
  }
  private reloadActive(ignoreCache = false): void {
    if (this.win.isDestroyed()) return;
    if (this.state.page !== 'workspace' || this.state.activeTabId === 'home') return;
    void this.tabs
      .reload(this.state.activeTabId, ignoreCache)
      .catch((error) => this.log('tab-error', String(error)));
  }
  private command(command: ShellCommand): void {
    this.show();
    if (!this.shellReady) {
      this.pendingCommands.add(command);
      return;
    }
    this.deliverCommand(command);
  }
  private deliverCommand(command: ShellCommand): void {
    this.setPage('workspace');
    if (command === 'new-tab') {
      this.overlay = true;
      this.tabs.layout();
    }
    this.win.webContents.focus();
    this.win.webContents.send('desktop:command', command);
  }
  private trusted(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    const origin =
      this.entry === 'workbench-app://shell/'
        ? 'workbench-app://shell'
        : new URL(this.entry).origin;
    if (
      !this.win ||
      this.win.isDestroyed() ||
      event.sender !== this.win.webContents ||
      !frame ||
      frame !== this.win.webContents.mainFrame ||
      frame.url !== this.entry ||
      frame.origin !== origin
    )
      throw new Error('Untrusted IPC sender');
  }
  private registerIPC(): void {
    const handlers = {
      getSnapshot: async () => this.state,
      getInfo: async () => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        packaged: app.isPackaged,
      }),
      openTab: async (url: string) => {
        this.tabs.open(url);
        this.setPage('workspace');
      },
      activateTab: async (id: string) => {
        this.tabs.activate(this.id(id));
        this.setPage('workspace');
      },
      closeTab: async (id: string) => this.tabs.close(this.id(id)),
      reorderTabs: async (from: string, to: string) =>
        this.tabs.reorder(this.id(from), this.id(to)),
      navigateTab: async (id: string, url: string) => this.tabs.navigate(this.id(id), url),
      tabAction: async (id: string, action: Parameters<DesktopAPI['tabAction']>[1]) => {
        if (
          ![
            'back',
            'forward',
            'reload',
            'stop',
            'devtools',
            'external',
            'copy',
            'capture',
          ].includes(action)
        )
          throw new Error('Invalid tab action');
        const view = this.tabs.get(this.id(id));
        const url = view.webContents.getURL() || this.state.tabs.find((t) => t.id === id)?.url;
        if (action === 'external') await shell.openExternal(normalizeURL(url));
        else if (action === 'copy')
          await this.native.copy(normalizeURL(url, process.env.WORKBENCH_TEST === '1'));
        else if (action === 'capture') await this.native.capture(view.webContents);
        else
          await this.tabs.action(id, action as 'back' | 'forward' | 'reload' | 'stop' | 'devtools');
        this.log(`tab-${action}`);
      },
      setPage: async (page: Page) => {
        if (!['workspace', 'settings', 'activity'].includes(page)) throw new Error('Invalid page');
        this.setPage(page);
      },
      setViewport: async (bounds: Bounds) => {
        if (
          !bounds ||
          !['x', 'y', 'width', 'height'].every((key) =>
            Number.isFinite(bounds[key as keyof Bounds]),
          )
        )
          throw new Error('Invalid bounds');
        this.tabs.setViewport(bounds);
      },
      setOverlay: async (open: boolean) => {
        if (typeof open !== 'boolean') throw new Error('Invalid overlay');
        this.overlay = open;
        this.tabs.layout();
      },
      updateSettings: async (input: unknown) => {
        const patch = settingsPatch(input);
        if ('openAtLogin' in patch) {
          if (!app.isPackaged || process.platform === 'linux')
            throw new Error('Login items require a packaged macOS or Windows app');
        }
        const previous = this.state.settings;
        this.state.settings = { ...this.state.settings, ...patch };
        try {
          this.applyTheme();
          this.native.configure();
          if ('openAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
        } catch (error) {
          this.state.settings = previous;
          for (const restore of [() => this.applyTheme(), () => this.native.configure()]) {
            try {
              restore();
            } catch (restoreError) {
              this.log('settings-rollback-error', String(restoreError));
            }
          }
          this.changed();
          throw error;
        }
        this.addActivity('settings', Object.keys(patch).join(', '));
        this.changed(true);
      },
      nativeAction: async (action: Parameters<DesktopAPI['nativeAction']>[0]) => {
        if (!['notify', 'logs', 'data', 'about'].includes(action))
          throw new Error('Invalid native action');
        await this.native.action(action);
        this.log(`native-${action}`);
      },
      showDownload: async (id: string) => {
        const key = this.id(id);
        const download = this.state.downloads.find((d) => d.id === key);
        if (download?.state === 'completed' && download.path) shell.showItemInFolder(download.path);
      },
      updateAction: async (action: 'check' | 'download' | 'install') => {
        if (!['check', 'download', 'install'].includes(action))
          throw new Error('Invalid update action');
        await this.updater.action(action);
      },
    } satisfies Omit<DesktopAPI, 'onSnapshot' | 'onCommand'>;
    for (const [name, handler] of Object.entries(handlers)) {
      const channel = `desktop:${name}`;
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        this.trusted(event);
        try {
          return await (handler as (...args: unknown[]) => unknown)(...args);
        } catch (error) {
          this.log(`ipc-error:${name}`, String(error));
          throw error;
        }
      });
    }
  }
  private id(input: unknown): string {
    if (typeof input !== 'string' || !input || input.length > 100) throw new Error('Invalid ID');
    return input;
  }
  private watchDownloads(session: Session): void {
    if (this.watchedSessions.has(session)) return;
    this.watchedSessions.add(session);
    session.on('will-download', (_event, item) => {
      const download = {
        id: randomUUID(),
        name: basename(item.getFilename()),
        received: 0,
        total: item.getTotalBytes(),
        state: 'progressing' as const,
      };
      this.state.downloads.unshift(download);
      this.state.downloads = this.state.downloads.slice(0, 30);
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), download.name) });
      const updated = (_event: Electron.Event, status: 'progressing' | 'interrupted') => {
        Object.assign(download, { received: item.getReceivedBytes(), state: status });
        this.changed();
      };
      item.on('updated', updated);
      item.once('done', (_event, status) => {
        item.removeListener('updated', updated);
        Object.assign(download, {
          state: status,
          received: item.getReceivedBytes(),
          path: status === 'completed' ? item.getSavePath() : undefined,
        });
        this.addActivity('download', download.name);
        this.changed();
      });
      this.changed();
    });
  }
}
