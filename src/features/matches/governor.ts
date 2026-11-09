/**
 * One request budget for every match screen (n01 manual §7: about 300 requests a minute per
 * IP, then HTTP 429 with Retry-After).
 *
 * League Order aims at half of that — a venue's Wi-Fi puts many phones behind one IP, and the
 * scorers' own n01 traffic may share it. Every read of MATCH RESULTS / LIVE MATCH takes a slot
 * from this sliding one-minute window; a 429 pauses all of them at once. There is no way to
 * know how many other phones share the IP, so 429 is also the signal to slow down.
 */

export interface GovernorStatus {
  /** Requests in the last minute. */
  used: number;
  perMinute: number;
  /** Epoch ms until which every request waits after n01 said "too many requests". */
  pausedUntil: number | null;
}

export class RequestGovernor {
  private stamps: number[] = [];
  private pausedUntil = 0;
  private readonly listeners = new Set<(status: GovernorStatus) => void>();

  constructor(
    readonly perMinute = 150,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  status(): GovernorStatus {
    const now = this.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 60_000);
    return { used: this.stamps.length, perMinute: this.perMinute, pausedUntil: this.pausedUntil > now ? this.pausedUntil : null };
  }

  subscribe(listener: (status: GovernorStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  /** Waits for a slot (or the end of a pause), then takes it. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const now = this.now();
      if (this.pausedUntil > now) {
        await this.sleep(Math.min(this.pausedUntil - now, 5_000));
        continue;
      }
      this.stamps = this.stamps.filter((stamp) => now - stamp < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        this.emit();
        return;
      }
      await this.sleep(Math.max(250, 60_000 - (now - this.stamps[0])));
    }
  }

  /** n01 answered 429: everybody waits `seconds` (+ up to 30 % so phones do not return together). */
  pause(seconds = 60, jitter = Math.random()): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + seconds * 1000 * (1 + 0.3 * jitter));
    this.emit();
  }
}

/** The app's one budget. Tests make their own. */
export const sharedGovernor = new RequestGovernor();
