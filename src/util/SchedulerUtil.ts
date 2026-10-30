import { GameRecoveryCoordinator } from "../logic/ActiveGameRecovery";

export class Scheduler {
  private static readonly tasks: Map<string, NodeJS.Timeout> = new Map();

  static schedule(
    id: string,
    callback: () => Promise<void> | void,
    targetTime: Date
  ) {
    const now = new Date();
    const delay = targetTime.getTime() - now.getTime();

    if (delay > 0) {
      const existing = this.tasks.get(id);
      if (existing) {
        clearTimeout(existing);
        this.tasks.delete(id);
        console.info(`[INFO] Task '${id}' replaced; previous task canceled.`);
      }
      console.info(
        `Scheduling task '${id}' to run in ${delay / 1000}s at ${targetTime.toISOString()}`
      );

      const execute = async () => {
        if (this.tasks.get(id) !== timeout) return;
        const done = GameRecoveryCoordinator.enterOperation();
        if (!done) {
          const deferred = GameRecoveryCoordinator.deferUntilCaptureAborts(() => {
            if (this.tasks.get(id) === timeout) void execute();
          });
          if (!deferred && this.tasks.get(id) === timeout) this.tasks.delete(id);
          return;
        }
        try {
          await callback();
          console.info(`Task '${id}' executed successfully.`);
        } catch (error) {
          console.error(`Scheduled task '${id}' failed:`, error);
        } finally {
          if (this.tasks.get(id) === timeout) this.tasks.delete(id);
          done();
        }
      };
      const timeout = setTimeout(execute, delay);
      this.tasks.set(id, timeout);
    } else {
      console.warn(`Task '${id}' not scheduled: Target time already passed.`);
    }
  }

  static cancel(id: string) {
    const timeout = this.tasks.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.tasks.delete(id);
      console.info(`[INFO] Task '${id}' canceled.`);
    } else {
      console.warn(`[WARN] No task found with ID '${id}' to cancel.`);
    }
  }
}
