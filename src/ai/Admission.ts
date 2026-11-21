/** Small, process-local safety budget: no queue, no unbounded promise buildup. */
export class AiAdmission {
  private readonly activeUsers = new Set<string>();
  private readonly guildActive = new Map<string, number>();
  private active = 0;
  private day = "";
  private used = 0;
  private readonly lastByUser = new Map<string, number>();
  constructor(
    private readonly dailyLimit: number,
    private readonly now = () => Date.now()
  ) {}

  acquire(userId: string, guildId: string): (() => void) | null {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      this.used = 0;
    }
    if (
      this.used >= this.dailyLimit ||
      this.active >= 2 ||
      this.activeUsers.has(userId) ||
      (this.guildActive.get(guildId) ?? 0) >= 2 ||
      now - (this.lastByUser.get(userId) ?? -Infinity) < 30_000
    )
      return null;
    this.used++;
    this.active++;
    this.activeUsers.add(userId);
    this.guildActive.set(guildId, (this.guildActive.get(guildId) ?? 0) + 1);
    this.lastByUser.set(userId, now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.activeUsers.delete(userId);
      const n = (this.guildActive.get(guildId) ?? 1) - 1;
      if (n === 0) this.guildActive.delete(guildId);
      else this.guildActive.set(guildId, n);
    };
  }
}
