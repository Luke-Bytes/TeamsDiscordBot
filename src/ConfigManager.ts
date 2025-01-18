import { writeFileSync } from "fs";
import conf from "../config.json";

export type Config = {
  mvpBonus: number;
  captainBonus: number;
  roles: {
    blueTeamRole: string;
    redTeamRole: string;
    captainRole: string;
    organiserRole: string;
  };
  channels: {
    registration: string;
    announcements: string;
    gameFeed: string;
    teamPickingVC: string;
    teamPickingChat: string;
    redTeamVC: string;
    blueTeamVC: string;
    redTeamChat: string;
    blueTeamChat: string;
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
      this.config = conf;
    }
    return this.config;
  }

  static writeConfig(newConfig: Config) {
    writeFileSync("./config.json", JSON.stringify(newConfig, null, 2), "utf8");
    this.config = newConfig;
  }
}
