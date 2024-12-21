export class MaintenanceLoggingUtil {
  static startLogging() {
    const now = new Date();
    const nextHalfHour = new Date(now);

    if (now.getMinutes() < 30) {
      nextHalfHour.setMinutes(30, 0, 0);
    } else {
      nextHalfHour.setHours(nextHalfHour.getHours() + 1, 0, 0, 0);
    }

    const delay = nextHalfHour.getTime() - now.getTime();

    setTimeout(() => {
      this.logBotStatus();
      setInterval(() => this.logBotStatus(), 30 * 60 * 1000); // Every 30m rounded
    }, delay);
  }

  private static logBotStatus() {
    const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    console.info(`Bot is online. Memory usage: ${memoryUsage.toFixed(2)} MB`);
  }
}
