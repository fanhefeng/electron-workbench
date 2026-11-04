import {
  WebContentsView,
  session,
  type BrowserWindow,
  type RestoreOptions,
  type Session,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { normalizeURL } from '../shared/validation.ts';
import { MAX_TABS, type Bounds, type Page, type ShellCommand, type Tab } from '../shared/model.ts';
import { loadFavicon } from './favicon.ts';

interface TabHost {
  readonly window: BrowserWindow;
  tabs: Tab[];
  activeTabId: string;
  htmlInCanvas(): boolean;
  visible(): boolean;
  changed(persist?: boolean): void;
  activity(kind: 'opened' | 'closed', label: string): void;
  onSession(session: Session): void;
  command(command: ShellCommand): void;
  page(page: Page): void;
  report(error: unknown): void;
}

/** Owns every embedded WebContents, including its destruction and native bounds. */
export class Tabs {
  private views = new Map<string, WebContentsView>();
  private appliedCanvas = new WeakMap<WebContentsView, boolean>();
  private retaining = new WeakSet<WebContentsView>();
  private closing = new WeakMap<WebContentsView, Promise<boolean>>();
  private viewport: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  private readonly allowLocal = process.env.WORKBENCH_TEST === '1';
  private readonly webSession: Session;
  constructor(private host: TabHost) {
    this.webSession = session.fromPartition('persist:web-pages');
    this.webSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.webSession.setPermissionCheckHandler(() => false);
    this.webSession.setDevicePermissionHandler(() => false);
    host.onSession(this.webSession);
  }
  open(input: string): void {
    const url = normalizeURL(input, this.allowLocal);
    const existing = this.host.tabs.find((tab) => tab.url === url);
    if (existing) {
      this.activate(existing.id);
      return;
    }
    if (this.host.tabs.length >= MAX_TABS) throw new Error(`At most ${MAX_TABS} tabs`);
    const tab: Tab = {
      id: randomUUID(),
      title: new URL(url).hostname,
      url,
      loading: true,
      canGoBack: false,
      canGoForward: false,
    };
    const previous = this.host.activeTabId;
    this.host.tabs.push(tab);
    this.host.activeTabId = tab.id;
    try {
      this.ensureView(tab);
    } catch (error) {
      this.host.tabs.pop();
      this.host.activeTabId = previous;
      this.layout();
      this.host.changed();
      throw error;
    }
    this.host.activity('opened', tab.title);
    this.layout();
    this.host.changed(true);
  }
  activate(id: string): void {
    const tab = this.host.tabs.find((t) => t.id === id);
    if (id !== 'home' && !tab) throw new Error('Unknown tab');
    if (tab) this.ensureView(tab);
    this.host.activeTabId = id;
    this.layout();
    this.host.changed(true);
  }
  async close(id: string): Promise<boolean> {
    const tab = this.host.tabs.find((tab) => tab.id === id);
    if (!tab) return false;
    const view = this.views.get(id);
    if (!view) {
      this.removeTab(id);
      return true;
    }
    this.retaining.delete(view);
    const closed = await this.requestClose(view);
    if (closed && this.views.get(id) === view) this.removeTab(id);
    return closed;
  }
  private removeTab(id: string): void {
    const index = this.host.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = this.host.tabs.splice(index, 1);
    if (this.host.activeTabId === id)
      this.host.activeTabId = this.host.tabs[index - 1]?.id ?? this.host.tabs[0]?.id ?? 'home';
    this.destroyView(id);
    this.ensureActiveView();
    this.host.activity('closed', tab.title);
    this.layout();
    this.host.changed(true);
  }
  private ensureActiveView(): void {
    const active = this.host.tabs.find((t) => t.id === this.host.activeTabId);
    if (active) {
      try {
        this.ensureView(active);
      } catch (error) {
        active.loading = false;
        active.error = String(error);
        this.host.report(error);
      }
    }
  }
  reorder(from: string, to: string): void {
    const start = this.host.tabs.findIndex((t) => t.id === from);
    const end = this.host.tabs.findIndex((t) => t.id === to);
    if (start < 0 || end < 0 || start === end) return;
    const [tab] = this.host.tabs.splice(start, 1);
    this.host.tabs.splice(end, 0, tab);
    this.host.changed(true);
  }
  navigate(id: string, url: string): void {
    const target = normalizeURL(url, this.allowLocal);
    const view = this.get(id);
    void view.webContents.loadURL(target).catch(() => {
      /* did-fail-load supplies the error state. */
    });
  }
  async action(
    id: string,
    action: 'back' | 'forward' | 'reload' | 'stop' | 'devtools',
  ): Promise<void> {
    const wc = this.get(id).webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    if (action === 'reload') await this.reload(id);
    if (action === 'stop') wc.stop();
    if (action === 'devtools') wc.openDevTools({ mode: 'detach' });
  }
  async reload(id: string, ignoreCache = false): Promise<void> {
    const tab = this.host.tabs.find((item) => item.id === id);
    if (!tab) throw new Error('Unknown tab');
    const view = this.get(id);
    const wc = view.webContents;
    if (this.retaining.has(view)) return;
    if (this.appliedCanvas.get(view) === this.host.htmlInCanvas()) {
      if (ignoreCache) wc.reloadIgnoringCache();
      else wc.reload();
      return;
    }
    const history: RestoreOptions = {
      entries: wc.navigationHistory.getAllEntries().map((entry) => ({
        ...entry,
        url: normalizeURL(entry.url, this.allowLocal),
      })),
      index: wc.navigationHistory.getActiveIndex(),
    };
    const focused = wc.isFocused();
    const zoom = wc.getZoomFactor();
    const muted = wc.isAudioMuted();
    this.retaining.add(view);
    try {
      if (!(await this.requestClose(view))) return;
      if (this.views.get(id) !== view || !this.host.tabs.includes(tab)) return;
      this.views.delete(id);
      this.host.window.contentView.removeChildView(view);
      tab.loading = true;
      tab.error = undefined;
      try {
        const next = this.ensureView(tab, history, ignoreCache);
        next.webContents.setZoomFactor(zoom);
        next.webContents.setAudioMuted(muted);
        this.layout();
        if (focused && this.host.visible()) next.webContents.focus();
      } catch (error) {
        tab.loading = false;
        tab.error = String(error);
      }
      this.host.changed();
    } finally {
      this.retaining.delete(view);
    }
  }
  private requestClose(view: WebContentsView): Promise<boolean> {
    const pending = this.closing.get(view);
    if (pending) return pending;
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) return Promise.resolve(true);
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    const finish = (closed: boolean) => {
      cleanup();
      resolve(closed);
    };
    const destroyed = () => finish(true);
    const cancelled = (event: Electron.Event) => {
      // A later listener may allow unload. Check after every listener has run.
      queueMicrotask(() => {
        if (!event.defaultPrevented && !wc.isDestroyed()) finish(false);
      });
    };
    const cleanup = () => {
      wc.removeListener('destroyed', destroyed);
      wc.removeListener('will-prevent-unload', cancelled);
      this.closing.delete(view);
    };
    this.closing.set(view, promise);
    wc.once('destroyed', destroyed);
    wc.once('will-prevent-unload', cancelled);
    try {
      wc.close({ waitForBeforeUnload: true });
    } catch (error) {
      cleanup();
      reject(error);
    }
    return promise;
  }
  get(id: string): WebContentsView {
    const tab = this.host.tabs.find((t) => t.id === id);
    if (!tab) throw new Error('Unknown tab');
    return this.ensureView(tab);
  }
  setViewport(bounds: Bounds): void {
    this.viewport = bounds;
    this.layout();
  }
  layout(): void {
    const [width, height] = this.host.window.getContentSize();
    const zoom = this.host.window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round(this.viewport.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(this.viewport.y * zoom)));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(this.viewport.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(this.viewport.height * zoom))),
    };
    for (const [id, view] of this.views) {
      view.setBounds(bounds);
      view.setVisible(
        bounds.width > 0 &&
          bounds.height > 0 &&
          this.host.visible() &&
          id === this.host.activeTabId,
      );
    }
  }
  dispose(): void {
    for (const id of this.views.keys()) this.destroyView(id);
  }
  async closeViews(): Promise<boolean> {
    let closed = false;
    try {
      for (const [id, view] of this.views) {
        if (this.retaining.has(view)) return false;
        this.retaining.add(view);
        try {
          if (!(await this.requestClose(view))) return false;
          if (this.views.get(id) === view) this.destroyView(id);
        } finally {
          this.retaining.delete(view);
        }
      }
      closed = true;
      return true;
    } finally {
      if (!closed && !this.host.window.isDestroyed()) {
        this.ensureActiveView();
        this.layout();
        this.host.changed();
      }
    }
  }
  private destroyView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    try {
      const window = this.host.window;
      if (!window.isDestroyed() && window.contentView.children.includes(view))
        window.contentView.removeChildView(view);
    } catch (error) {
      this.host.report(error);
    } finally {
      const tab = this.host.tabs.find((tab) => tab.id === id);
      if (tab)
        Object.assign(tab, {
          loading: false,
          canGoBack: false,
          canGoForward: false,
          favicon: undefined,
        });
      // Native destruction can clear this property before the View is detached.
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    }
  }
  private ensureView(tab: Tab, history?: RestoreOptions, ignoreCache = false): WebContentsView {
    const existing = this.views.get(tab.id);
    if (existing) return existing;
    try {
      return this.createView(tab, history, ignoreCache);
    } catch (error) {
      this.destroyView(tab.id);
      throw error;
    }
  }
  private createView(tab: Tab, history?: RestoreOptions, ignoreCache = false): WebContentsView {
    const htmlInCanvas = this.host.htmlInCanvas();
    const view = new WebContentsView({
      webPreferences: {
        session: this.webSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        ...(htmlInCanvas
          ? { enableBlinkFeatures: 'CanvasDrawElement' }
          : { disableBlinkFeatures: 'CanvasDrawElement' }),
        // Remote pages intentionally receive NO preload and NO native bridge.
      },
    });
    this.views.set(tab.id, view);
    this.appliedCanvas.set(view, htmlInCanvas);
    this.host.window.contentView.addChildView(view);
    view.setVisible(false);
    const wc = view.webContents;
    const current = () => this.views.get(tab.id) === view && !wc.isDestroyed();
    let faviconRequest: AbortController | undefined;
    const clearFavicon = () => {
      faviconRequest?.abort();
      faviconRequest = undefined;
      if (this.views.get(tab.id) === view) tab.favicon = undefined;
    };
    wc.once('destroyed', () => {
      clearFavicon();
      if (this.views.get(tab.id) === view && !this.retaining.has(view)) this.removeTab(tab.id);
    });
    const update = (persist = false) => {
      if (!current()) return;
      const url = wc.getURL();
      if (url && url !== 'about:blank') tab.url = url;
      tab.canGoBack = wc.navigationHistory.canGoBack();
      tab.canGoForward = wc.navigationHistory.canGoForward();
      this.host.changed(persist);
    };
    const guard = (event: Electron.Event, url: string) => {
      try {
        if (normalizeURL(url, this.allowLocal) !== new URL(url).href) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (!current()) return { action: 'deny' };
      try {
        this.open(url);
      } catch {
        /* Invalid URL or tab limit: deny popup. */
      }
      return { action: 'deny' };
    });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!current() || !isMainFrame || isInPlace) return;
      clearFavicon();
      update();
    });
    wc.on('page-favicon-updated', (_event, urls) => {
      if (!current()) return;
      faviconRequest?.abort();
      const request = new AbortController();
      faviconRequest = request;
      const timeout = setTimeout(() => request.abort(), 5000);
      void (async () => {
        try {
          for (const url of urls.slice(0, 4)) {
            if (request.signal.aborted) return;
            try {
              const favicon = await loadFavicon(
                this.webSession,
                url,
                request.signal,
                this.allowLocal,
              );
              if (request.signal.aborted || faviconRequest !== request || !current()) return;
              tab.favicon = favicon;
              update();
              return;
            } catch {
              // Try the next declared icon; unavailable icons keep the globe fallback.
            }
          }
          if (!request.signal.aborted && faviconRequest === request && current()) {
            tab.favicon = undefined;
            update();
          }
        } finally {
          clearTimeout(timeout);
          if (faviconRequest === request) faviconRequest = undefined;
        }
      })();
    });
    wc.on('did-start-loading', () => {
      if (!current()) return;
      tab.loading = true;
      tab.error = undefined;
      update();
      this.layout();
    });
    wc.on('did-stop-loading', () => {
      if (!current()) return;
      tab.loading = false;
      update(true);
    });
    wc.on('did-navigate', () => update(true));
    wc.on('did-navigate-in-page', () => update(true));
    wc.on('page-title-updated', (_event, title) => {
      if (!current()) return;
      tab.title = title.slice(0, 120) || new URL(tab.url).hostname;
      update();
    });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!current() || !isMainFrame || code === -3) return;
      tab.error = description;
      tab.loading = false;
      update();
      this.layout();
    });
    wc.on('render-process-gone', (_event, details) => {
      if (!current()) return;
      tab.error = details.reason;
      tab.loading = false;
      update();
      this.layout();
    });
    wc.on('before-input-event', (event, input) => {
      if (!current() || input.type !== 'keyDown' || input.isComposing || input.alt) return;
      const key = input.key.toLowerCase();
      const primary =
        process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
      if ((key === 'f5' && !input.meta) || (primary && key === 'r')) {
        event.preventDefault();
        void this.reload(tab.id, input.shift || (key === 'f5' && input.control)).catch((error) =>
          this.host.report(error),
        );
        return;
      }
      if (!primary || input.shift) return;
      if (['t', 'l', 'w', ','].includes(key)) event.preventDefault();
      if (key === 't') this.host.command('new-tab');
      if (key === 'l') this.host.command('focus-address');
      if (key === 'w') void this.close(tab.id).catch((error) => this.host.report(error));
      if (key === ',') this.host.page('settings');
    });
    const load = history?.entries.length
      ? wc.navigationHistory.restore(history)
      : wc.loadURL(tab.url);
    void load
      .then(() => {
        if (history && ignoreCache && current()) wc.reloadIgnoringCache();
      })
      .catch(() => {
        /* Handled by did-fail-load. */
      });
    return view;
  }
}
