import { useEffect } from 'react';

let viewers = 0;
let pageHidden = false;
let generation = 0;
let busy = false;
let lock: WakeLockSentinel | null = null;

function shouldHold(): boolean {
  return viewers > 0 && !pageHidden && document.visibilityState === 'visible';
}

async function syncWakeLock(): Promise<void> {
  const wanted = shouldHold();
  if (!wanted) generation += 1;
  if (lock?.released) lock = null;
  if (busy || wanted === (lock !== null)) return;

  // 取得と解除を直列化し、非表示や観戦終了の前に始まった取得を無効にする。
  const attempt = generation;
  busy = true;
  try {
    if (wanted) {
      const acquired = await navigator.wakeLock.request('screen');
      if (attempt === generation && shouldHold()) lock = acquired;
      else await acquired.release();
    } else {
      const held = lock;
      lock = null;
      await held?.release();
    }
  } catch {
    // ブラウザや OS が拒否した場合は、次の画面復帰まで待つ。
  } finally {
    busy = false;
    if (shouldHold() && (!wanted || attempt !== generation)) void syncWakeLock();
  }
}

function onVisibilityChange(): void {
  void syncWakeLock();
}

function onPageHide(): void {
  pageHidden = true;
  void syncWakeLock();
}

function onPageShow(): void {
  pageHidden = false;
  void syncWakeLock();
}

/** 同じ画面で複数の対戦を観戦している間も、画面スリープ防止は一つだけ使う。 */
export function useScreenWakeLock(watching: boolean): void {
  useEffect(() => {
    if (!watching || typeof navigator.wakeLock?.request !== 'function') return;

    if (viewers++ === 0) {
      pageHidden = false;
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
      queueMicrotask(onVisibilityChange);
    }
    return () => {
      if (--viewers > 0) return;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      void syncWakeLock();
    };
  }, [watching]);
}
