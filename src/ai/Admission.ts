/** Small, process-local safety budget: no queue, no unbounded promise buildup. */
export const AI_USER_COOLDOWN_MS = 5_000;
export const AI_USER_MINUTE_WINDOW_MS = 60_000;
export const AI_USER_MINUTE_LIMIT = 5;

export type AiAdmissionDeniedReason =
  | "daily_limit"
  | "user_inflight"
  | "user_cooldown"
  | "user_minute_limit"
  | "global_busy"
  | "guild_busy";

export type AiAdmissionResult =
  | { ok: true; release: () => void }
  | {
      ok: false;
      reason: AiAdmissionDeniedReason;
      retryAfterSeconds?: number;
    };

export class AiAdmission {
  private readonly activeUsers = new Set<string>();
  private readonly guildActive = new Map<string, number>();
  private active = 0;
  private day = "";
  private used = 0;
  private readonly lastByUser = new Map<string, number>();
  private readonly recentByUser = new Map<string, number[]>();

  constructor(
    private readonly dailyLimit: number,
    private readonly now = () => Date.now()
  ) {}

  tryAcquire(userId: string, guildId: string): AiAdmissionResult {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      this.used = 0;
    }

    if (this.used >= this.dailyLimit)
      return { ok: false, reason: "daily_limit" };

    if (this.activeUsers.has(userId))
      return { ok: false, reason: "user_inflight" };

    // A rolling window, rather than a fixed-minute bucket, prevents bursts
    // across minute boundaries. Rejected attempts never consume quota.
    const recent = (this.recentByUser.get(userId) ?? []).filter(
      (startedAt) => now - startedAt < AI_USER_MINUTE_WINDOW_MS
    );
    if (recent.length === 0) this.recentByUser.delete(userId);
    else this.recentByUser.set(userId, recent);
    if (recent.length >= AI_USER_MINUTE_LIMIT)
      return {
        ok: false,
        reason: "user_minute_limit",
        retryAfterSeconds: Math.ceil(
          (AI_USER_MINUTE_WINDOW_MS - (now - recent[0])) / 1000
        ),
      };

    // Prioritise the minute-limit explanation once the fifth request is used;
    // otherwise the user sees a misleading short cooldown first.
    const remainingMs =
      AI_USER_COOLDOWN_MS - (now - (this.lastByUser.get(userId) ?? -Infinity));
    if (remainingMs > 0)
      return {
        ok: false,
        reason: "user_cooldown",
        retryAfterSeconds: Math.ceil(remainingMs / 1000),
      };

    if (this.active >= 2) return { ok: false, reason: "global_busy" };

    if ((this.guildActive.get(guildId) ?? 0) >= 2)
      return { ok: false, reason: "guild_busy" };

    this.used++;
    this.active++;
    this.activeUsers.add(userId);
    this.guildActive.set(guildId, (this.guildActive.get(guildId) ?? 0) + 1);
    this.lastByUser.set(userId, now);
    recent.push(now);
    this.recentByUser.set(userId, recent);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.activeUsers.delete(userId);
        const n = (this.guildActive.get(guildId) ?? 1) - 1;
        if (n === 0) this.guildActive.delete(guildId);
        else this.guildActive.set(guildId, n);
      },
    };
  }

  /** Existing callers can continue using the simple acquire/release API. */
  acquire(userId: string, guildId: string): (() => void) | null {
    const result = this.tryAcquire(userId, guildId);
    return result.ok ? result.release : null;
  }
}
