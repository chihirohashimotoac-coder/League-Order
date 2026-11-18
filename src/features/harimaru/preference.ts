/**
 * ハリマルの表示設定 (見た目だけの設定)。
 *
 * 表示テーマと同じく端末ごとの好みなので、チームのデータ・JSON バックアップには含めず、この端末の
 * localStorage (`league-order:harimaru`) にだけ保存する。初期値は ON。保存できない環境
 * (プライベートモードなど) でも例外を出さず、その場の選択はこのタブの中では反映される。
 */
import { useSyncExternalStore } from 'react';

export const HARIMARU_STORAGE_KEY = 'league-order:harimaru';

type Listener = () => void;
const listeners = new Set<Listener>();
/** 保存できなかった選択 (このタブの中だけで有効)。null なら保存値に従う。 */
let override: boolean | null = null;

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 保存された設定。未保存・不正な値・読めない環境では ON。 */
export function readHarimaruEnabled(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  if (override !== null) return override;
  try {
    return storage?.getItem(HARIMARU_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** 設定を保存して知らせる。保存できたら true (できなくても、このタブの表示は切り替わる)。 */
export function saveHarimaruEnabled(enabled: boolean, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  let saved = false;
  try {
    storage?.setItem(HARIMARU_STORAGE_KEY, enabled ? 'on' : 'off');
    saved = storage !== null;
  } catch {
    saved = false;
  }
  override = saved ? null : enabled;
  for (const listener of [...listeners]) listener();
  return saved;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  // 別のタブで変えた設定にも追従する。
  const onStorage = (event: StorageEvent): void => {
    if (event.key === HARIMARU_STORAGE_KEY || event.key === null) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** 現在の表示設定 (設定画面とキャラクターの描画で共有)。 */
export function useHarimaruEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => readHarimaruEnabled(), () => true);
}

/** テスト用: タブ内だけの選択を消す。 */
export function resetHarimaruPreferenceForTests(): void {
  override = null;
}
