import type { GameInstance } from "../../database/GameInstance";
import type { ScenarioCoordinator } from "./ScenarioCoordinator";
import { Channels } from "../../Channels";
import { Scheduler } from "../../util/SchedulerUtil";

const reminderKinds = new Set(["questionnaire", "preferences", "ballot", "hex"]);

/** Bounded, best-effort reminders. No timers or private messages are replayed on recovery. */
export class ScenarioReminderScheduler {
  private readonly pending = new Map<string, { task: string; at: number }>();
  private readonly reminded = new Set<string>();

  constructor(private readonly game: GameInstance, private readonly coordinator: ScenarioCoordinator) {}

  schedule(actionId: string, now = Date.now()): void {
    const guild = Channels.gameFeed?.guild;
    if (!guild || this.reminded.has(actionId) || this.pending.has(actionId)) return;
    const action = this.coordinator.availableActions(now).find((a) => a.id === actionId);
    if (!action || this.coordinator.actionComplete(action) || !reminderKinds.has(action.kind)) return;
    const deadline = Date.parse(action.deadline);
    const remaining = deadline - now;
    // Do not chase optional, short-lived wildcard turns or interrupt the last minute.
    if (remaining < 60_000) return;
    const at = deadline - Math.min(300_000, Math.floor(remaining / 2));
    const token = this.game.getLifecycleToken();
    const task = `scenario-reminder:${token}:${actionId}`;
    const scheduled = { task, at };
    this.pending.set(actionId, scheduled);
    Scheduler.schedule(task, async () => {
      if (this.pending.get(actionId) !== scheduled || Date.now() < at) return;
      this.pending.delete(actionId);
      if (token !== this.game.getLifecycleToken() || this.reminded.has(actionId)) return;
      const current = this.coordinator.availableActions().find((a) => a.id === actionId);
      if (!current || this.coordinator.actionComplete(current)) return;
      this.reminded.add(actionId);
      const { deliverScenarioAction } = await import("./ScenarioPromptDelivery");
      await deliverScenarioAction(this.game, current.ownerId, guild.client, actionId, true);
    }, new Date(at));
  }

  cancel(actionId: string): void {
    const scheduled = this.pending.get(actionId);
    if (!scheduled) return;
    this.pending.delete(actionId);
    Scheduler.cancel(scheduled.task);
  }

  clear(resetHistory = true): void {
    for (const actionId of this.pending.keys()) this.cancel(actionId);
    if (resetHistory) this.reminded.clear();
  }
}
