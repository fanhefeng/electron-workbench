import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateState } from '../shared/model.ts';

export class Updater {
  state: UpdateState = { status: 'unconfigured' };
  private updater?: import('electron-updater').AppUpdater;
  private initializing: Promise<void>;
  constructor(
    private changed: () => void,
    private prepareInstall: () => Promise<boolean>,
  ) {
    this.initializing = this.initialize().catch((error: unknown) => {
      this.state = { status: 'error', error: String(error) };
      this.changed();
    });
  }
  private async initialize(): Promise<void> {
    if (!app.isPackaged) return;
    const config = JSON.parse(
      await readFile(join(process.resourcesPath, 'resources/update.json'), 'utf8'),
    );
    if (!config.url) return;
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('HTTPS update feed required');
    const module = await import('electron-updater');
    this.updater = module.default.autoUpdater;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    // electron-builder writes app-update.yml from the same resources/update.json.
    // Let electron-updater read that manifest; no client-side provider override.
    const set = (state: UpdateState) => {
      this.state = state;
      this.changed();
    };
    this.updater.on('checking-for-update', () => set({ status: 'checking' }));
    this.updater.on('update-available', (info) =>
      set({ status: 'available', version: info.version }),
    );
    this.updater.on('update-not-available', () => set({ status: 'current' }));
    this.updater.on('download-progress', (progress) =>
      set({ status: 'downloading', progress: progress.percent }),
    );
    this.updater.on('update-downloaded', (info) =>
      set({ status: 'downloaded', version: info.version }),
    );
    this.updater.on('error', (error) => set({ status: 'error', error: error.message }));
    set({ status: 'idle' });
  }
  async action(action: 'check' | 'download' | 'install'): Promise<void> {
    await this.initializing;
    if (!this.updater) {
      this.changed();
      return;
    }
    if (
      action === 'check' &&
      !['checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)
    )
      await this.updater.checkForUpdates();
    if (action === 'download' && this.state.status === 'available') {
      this.state = { ...this.state, status: 'downloading', progress: 0 };
      this.changed();
      await this.updater.downloadUpdate();
    }
    if (action === 'install' && this.state.status === 'downloaded') {
      const downloaded = this.state;
      this.state = { ...this.state, status: 'installing' };
      this.changed();
      try {
        if (!(await this.prepareInstall())) {
          this.state = downloaded;
          this.changed();
          return;
        }
        this.updater.quitAndInstall();
      } catch (error) {
        this.state = { status: 'error', error: String(error) };
        this.changed();
        throw error;
      }
    }
  }
}
