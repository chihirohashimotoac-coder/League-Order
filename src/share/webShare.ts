/**
 * Web Share API, clipboard and download (要件 §1, docs/DESIGN.md 追補 §S8).
 *
 * Every entry point degrades explicitly rather than silently failing, and reports what
 * actually happened so the UI can tell the captain ("共有しました" vs "保存しました").
 */

export type ShareMethod = 'share' | 'download' | 'clipboard' | 'cancelled' | 'failed';

export interface ShareOutcome {
  method: ShareMethod;
  ok: boolean;
  message: string;
}

/** True when the browser exposes the Web Share API at all. */
export function canUseWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** True when this browser can put *files* into the OS share sheet. */
export function canShareFiles(): boolean {
  if (!canUseWebShare() || typeof navigator.canShare !== 'function') return false;
  try {
    // A representative probe file: `canShare` is type- and size-sensitive on iOS.
    const probe = new File([new Uint8Array([0])], 'probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copies text, preferring the async clipboard API and falling back to a textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or an insecure context — fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Downloads arbitrary text (JSON export, order text). */
export function downloadText(text: string, fileName: string, mime = 'application/json'): void {
  triggerDownload(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
}

export function dataUrlToFile(dataUrl: string, fileName: string): File {
  return new File([dataUrlToBlob(dataUrl)], fileName, { type: 'image/png' });
}

/**
 * Hands PNGs to the OS share sheet (LINE, Messenger, Discord, AirDrop, …).
 *
 * Falls back to downloading every page when file sharing is unavailable, so the captain
 * always ends up with the image either way (要件 §1).
 */
export async function shareImages(
  dataUrls: readonly string[],
  baseName: string,
  title: string,
  text?: string,
): Promise<ShareOutcome> {
  if (dataUrls.length === 0) {
    return { method: 'failed', ok: false, message: '画像を生成できませんでした' };
  }

  const files = dataUrls.map((dataUrl, index) =>
    dataUrlToFile(dataUrl, dataUrls.length === 1 ? `${baseName}.png` : `${baseName}-${index + 1}.png`),
  );

  if (canUseWebShare() && typeof navigator.canShare === 'function') {
    try {
      if (navigator.canShare({ files })) {
        await navigator.share({ files, title, ...(text ? { text } : {}) });
        return { method: 'share', ok: true, message: '共有しました' };
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        return { method: 'cancelled', ok: false, message: '共有を中止しました' };
      }
      // Anything else (a share target rejecting the payload) falls through to download.
    }
  }

  for (const file of files) triggerDownload(file, file.name);
  return {
    method: 'download',
    ok: true,
    message:
      dataUrls.length === 1 ? '画像を保存しました' : `画像を ${dataUrls.length} 枚保存しました`,
  };
}

/** Saves PNGs without going through the share sheet. */
export function saveImages(dataUrls: readonly string[], baseName: string): ShareOutcome {
  if (dataUrls.length === 0) {
    return { method: 'failed', ok: false, message: '画像を生成できませんでした' };
  }
  dataUrls.forEach((dataUrl, index) =>
    triggerDownload(
      dataUrlToBlob(dataUrl),
      dataUrls.length === 1 ? `${baseName}.png` : `${baseName}-${index + 1}.png`,
    ),
  );
  return {
    method: 'download',
    ok: true,
    message: dataUrls.length === 1 ? '画像を保存しました' : `画像を ${dataUrls.length} 枚保存しました`,
  };
}

/** Shares plain text through the OS share sheet, falling back to the clipboard. */
export async function shareText(text: string, title: string): Promise<ShareOutcome> {
  if (canUseWebShare()) {
    try {
      await navigator.share({ title, text });
      return { method: 'share', ok: true, message: '共有しました' };
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        return { method: 'cancelled', ok: false, message: '共有を中止しました' };
      }
    }
  }
  const copied = await copyText(text);
  return copied
    ? { method: 'clipboard', ok: true, message: 'テキストをコピーしました' }
    : { method: 'failed', ok: false, message: 'コピーできませんでした' };
}
