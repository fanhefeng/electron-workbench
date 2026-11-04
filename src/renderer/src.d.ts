import type { DesktopAPI } from '../shared/model.ts';
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
