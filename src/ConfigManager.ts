import { readFileSync, writeFileSync } from "fs";

type Config = {
  winEloGain: number;
  loseEloLoss: number;
  mvpBonus: number;
  roles: {
    blueTeamRole: string;
    redTeamRole: string;
    captainRole: string;
    organiserRole: string;
  };
  channels: {
    registration: string;
    announcements: string;
  };
  dev: {
    enabled: boolean;
    guildId: string;
  };
};

export class ConfigManager {
  private static config: Config;

  static getConfig() {
    if (!this.config) {
      this.config = JSON.parse(readFileSync("./config.json", "utf8"));
    }
    return this.config;
  }

  static writeConfig(newConfig: Config) {
    writeFileSync("./config.json", JSON.stringify(newConfig, null, 2), "utf8");
    this.config = newConfig;
  }
}
