import {
  app,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopAPI, Page, Settings, ShellCommand } from '../shared/model.ts';

interface NativeHost {
  window(): BrowserWindow;
  settings(): Settings;
  command(command: ShellCommand): void;
  page(page: Page): void;
  show(): void;
  quit(): void;
  closeTab(): void;
  nextTab(offset: number): void;
  reloadTab(ignoreCache?: boolean): void;
}

export class Native {
  private tray?: Tray;
  constructor(private host: NativeHost) {}
  configure(): void {
    const zh = this.host.settings().locale === 'zh';
    const label = (a: string, b: string) => (zh ? a : b);
    const template: MenuItemConstructorOptions[] = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: label('文件', 'File'),
        submenu: [
          {
            label: label('新建标签页', 'New tab'),
            accelerator: 'CmdOrCtrl+T',
            click: () => this.host.command('new-tab'),
          },
          {
            label: label('工作区', 'Workspace'),
            accelerator: 'CmdOrCtrl+1',
            click: () => this.host.page('workspace'),
          },
          {
            label: label('设置…', 'Settings…'),
            accelerator: 'CmdOrCtrl+,',
            click: () => this.host.page('settings'),
          },
          {
            label: label('关闭标签页', 'Close tab'),
            accelerator: 'CmdOrCtrl+W',
            click: () => this.host.closeTab(),
          },
          {
            label: label('地址栏', 'Address bar'),
            accelerator: 'CmdOrCtrl+L',
            click: () => this.host.command('focus-address'),
          },
          { type: 'separator' },
          {
            label: label('下一个标签页', 'Next tab'),
            accelerator: 'Ctrl+Tab',
            click: () => this.host.nextTab(1),
          },
          {
            label: label('上一个标签页', 'Previous tab'),
            accelerator: 'Ctrl+Shift+Tab',
            click: () => this.host.nextTab(-1),
          },
        ],
      },
      { role: 'editMenu' },
      {
        label: label('视图', 'View'),
        submenu: [
          {
            id: 'reload-page',
            label: label('刷新网页', 'Reload page'),
            accelerator: 'CmdOrCtrl+R',
            click: () => this.host.reloadTab(),
          },
          {
            id: 'force-reload-page',
            label: label('强制刷新网页', 'Force reload page'),
            accelerator: 'CmdOrCtrl+Shift+R',
            click: () => this.host.reloadTab(true),
          },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
      {
        label: label('帮助', 'Help'),
        submenu: [
          { label: label('关于 Workbench', 'About Workbench'), click: () => app.showAboutPanel() },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    if (this.host.settings().closeToTray && !this.tray) {
      const root = app.isPackaged
        ? join(process.resourcesPath, 'resources')
        : join(app.getAppPath(), 'resources');
      const image = nativeImage.createFromPath(join(root, 'tray.png'));
      image.setTemplateImage(true);
      this.tray = new Tray(image);
      this.tray.setToolTip('Workbench');
      this.tray.on('click', () => this.host.show());
    }
    if (!this.host.settings().closeToTray && this.tray) {
      this.tray.destroy();
      this.tray = undefined;
    }
    this.tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: label('打开 Workbench', 'Open Workbench'), click: () => this.host.show() },
        { type: 'separator' },
        { label: label('退出', 'Quit'), click: () => this.host.quit() },
      ]),
    );
  }
  async action(action: Parameters<DesktopAPI['nativeAction']>[0]): Promise<void> {
    if (action === 'notify') {
      if (!this.host.settings().notifications) throw new Error('Notifications are disabled');
      if (!Notification.isSupported()) throw new Error('Notifications are unavailable');
      const zh = this.host.settings().locale === 'zh';
      new Notification({
        title: 'Workbench',
        body: zh ? '桌面通知已就绪。' : 'Desktop notifications are ready.',
      }).show();
    }
    if (action === 'logs' || action === 'data') {
      const error = await shell.openPath(app.getPath(action === 'logs' ? 'logs' : 'userData'));
      if (error) throw new Error(error);
    }
    if (action === 'about') app.showAboutPanel();
  }
  async copy(url: string): Promise<void> {
    await clipboard.writeText(url);
  }
  async capture(contents: Electron.WebContents): Promise<void> {
    const image = await contents.capturePage();
    const result = await dialog.showSaveDialog(this.host.window(), {
      defaultPath: join(app.getPath('pictures'), `Workbench-${Date.now()}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, image.toPNG());
  }
  dispose(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
