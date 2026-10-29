/**
 * Fail-closed process gate for incomplete match shutdowns. This is NOT
 * automatic reconciliation. A committed match requiring Discord cleanup must
 * be checked by an operator before another match is announced.
 */
export class MatchRecoveryGate {
  private static reason: string | null = null;

  static markUnchecked(): void {
    this.reason = "Match recovery status has not been verified at startup";
  }

  static block(reason: string): void {
    this.reason = reason;
  }

  static getBlockReason(): string | null {
    return this.reason;
  }

  static async inspectPending(
    loadPendingMatchIds: () => Promise<string[]>
  ): Promise<void> {
    this.markUnchecked();
    try {
      const ids = await loadPendingMatchIds();
      this.reason = ids.length
        ? `Match cleanup is unresolved for ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? " and additional matches" : ""}`
        : null;
    } catch (error) {
      console.error("[match-recovery] Cannot inspect incomplete matches", error);
      this.block("Cannot verify incomplete match cleanup against the database");
    }
    if (this.reason) {
      console.error(`[match-recovery] New announcements blocked: ${this.reason}`);
    }
  }
}
