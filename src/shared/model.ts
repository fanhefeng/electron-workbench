export type Page = 'workspace' | 'activity' | 'settings';
export type Theme = 'system' | 'light' | 'dark';
export type Locale = 'zh' | 'en';
export type ShellCommand = 'new-tab' | 'focus-address';
export const MAX_TABS = 12;
export interface Settings {
  theme: Theme;
  accent: 'graphite' | 'moss' | 'clay';
  locale: Locale;
  restoreTabs: boolean;
  closeToTray: boolean;
  notifications: boolean;
  openAtLogin: boolean;
  htmlInCanvas: boolean;
}
export interface Tab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
  error?: string;
}
export interface Download {
  id: string;
  name: string;
  received: number;
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  path?: string;
}
export interface Activity {
  id: string;
  time: number;
  kind: 'opened' | 'closed' | 'download' | 'settings';
  label: string;
}
export interface UpdateState {
  status:
    | 'unconfigured'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'current'
    | 'error';
  version?: string;
  progress?: number;
  error?: string;
}
export interface Snapshot {
  revision: number;
  page: Page;
  tabs: Tab[];
  activeTabId: string;
  settings: Settings;
  dark: boolean;
  downloads: Download[];
  activity: Activity[];
  update: UpdateState;
}
export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  packaged: boolean;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  accent: 'graphite',
  locale: 'zh',
  restoreTabs: true,
  closeToTray: false,
  notifications: true,
  openAtLogin: false,
  htmlInCanvas: false,
};
export interface DesktopAPI {
  getSnapshot(): Promise<Snapshot>;
  getInfo(): Promise<AppInfo>;
  openTab(url: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<boolean>;
  reorderTabs(from: string, to: string): Promise<void>;
  navigateTab(id: string, url: string): Promise<void>;
  tabAction(
    id: string,
    action: 'back' | 'forward' | 'reload' | 'stop' | 'devtools' | 'external' | 'copy' | 'capture',
  ): Promise<void>;
  setPage(page: Page): Promise<void>;
  setViewport(bounds: Bounds): Promise<void>;
  setOverlay(open: boolean): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  nativeAction(action: 'notify' | 'logs' | 'data' | 'about'): Promise<void>;
  showDownload(id: string): Promise<void>;
  updateAction(action: 'check' | 'download' | 'install'): Promise<void>;
  onSnapshot(listener: (state: Snapshot) => void): () => void;
  onCommand(listener: (command: ShellCommand) => void): () => void;
}
