import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker registration (spec §2).
 *
 * Registered in `prompt` mode on purpose: an automatic reload could swap the bundle out
 * from under a captain who is mid-order at a venue. Instead the app pre-caches
 * immediately (so it works offline right away) and surfaces an explicit "update" action
 * that the captain takes when it suits them.
 */
type UpdateListener = (apply: () => void) => void;

let pendingApply: (() => void) | null = null;
let listener: UpdateListener | null = null;
let offlineReady = false;

export function initServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pendingApply = () => void updateSW(true);
      listener?.(pendingApply);
    },
    onOfflineReady() {
      offlineReady = true;
    },
  });
}

/** Subscribes to "an update is waiting". Fires immediately if one already is. */
export function onUpdateAvailable(next: UpdateListener): () => void {
  listener = next;
  if (pendingApply) next(pendingApply);
  return () => {
    listener = null;
  };
}

export function isOfflineReady(): boolean {
  return offlineReady;
}
