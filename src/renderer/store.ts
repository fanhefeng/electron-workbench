import { useSyncExternalStore } from 'react';
import type { Snapshot } from '../shared/model.ts';

let current: { state: Snapshot | null; failure: string | null } = { state: null, failure: null };
let active = true;
const listeners = new Set<() => void>();
const update = (next: Snapshot) => {
  if (active && (!current.state || next.revision > current.state.revision)) {
    current = { state: next, failure: null };
    listeners.forEach((fn) => fn());
  }
};
let unsubscribe: (() => void) | undefined;
if (window.desktop) {
  // Subscribe before pulling. Monotonic revision prevents a late pull replacing a live push.
  unsubscribe = window.desktop.onSnapshot(update);
  void window.desktop
    .getSnapshot()
    .then(update)
    .catch((error) => {
      if (!active || current.state) return;
      current = { state: null, failure: String(error) };
      listeners.forEach((fn) => fn());
    });
} else current = { state: null, failure: 'Please launch the Electron app with npm run dev.' };
import.meta.hot?.dispose(() => {
  active = false;
  unsubscribe?.();
  listeners.clear();
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useDesktopState() {
  return useSyncExternalStore(subscribe, () => current);
}
