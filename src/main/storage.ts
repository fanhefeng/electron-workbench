import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSettings, normalizeURL } from '../shared/validation.ts';
import { DEFAULT_SETTINGS, MAX_TABS, type Settings } from '../shared/model.ts';

export interface SavedState {
  settings: Settings;
  tabs: { id: string; title: string; url: string }[];
  activeTabId: string;
}

/** One writer, atomic replacement. A failed write never poisons subsequent writes. */
export class Storage {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: SavedState;
  private generation = 0;
  private readonly file: string;
  constructor(
    private readonly directory: string,
    private readonly report: (error: unknown) => void,
  ) {
    this.file = join(directory, 'workspace.json');
  }
  async load(): Promise<SavedState> {
    const fallback: SavedState = {
      settings: { ...DEFAULT_SETTINGS },
      tabs: [],
      activeTabId: 'home',
    };
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid workspace');
      const tabs: SavedState['tabs'] = [];
      if (Array.isArray(raw.tabs))
        for (const item of raw.tabs.slice(0, MAX_TABS)) {
          try {
            if (
              typeof item.id !== 'string' ||
              !item.id ||
              item.id.length > 100 ||
              item.id === 'home' ||
              tabs.some((t) => t.id === item.id)
            )
              continue;
            tabs.push({
              id: item.id,
              title: String(item.title).slice(0, 120),
              url: normalizeURL(item.url),
            });
          } catch {
            /* Drop an invalid entry; preserve the rest of the workspace. */
          }
        }
      return {
        settings: readSettings(raw.settings),
        tabs,
        activeTabId: typeof raw.activeTabId === 'string' ? raw.activeTabId : 'home',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.report(error);
        await rename(this.file, `${this.file}.broken-${Date.now()}`).catch(this.report);
      }
      return fallback;
    }
  }
  save(state: SavedState): void {
    this.pending = structuredClone(state);
    this.generation++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(this.report);
    }, 250);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const state = this.pending;
    this.pending = undefined;
    if (!state) return this.queue;
    const generation = this.generation;
    const content = JSON.stringify(state, null, 2);
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        const temporary = `${this.file}.tmp`;
        try {
          await writeFile(temporary, content, { mode: 0o600 });
          await rename(temporary, this.file);
        } catch (error) {
          if (generation === this.generation && !this.pending) this.pending = state;
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
    return this.queue;
  }
}
