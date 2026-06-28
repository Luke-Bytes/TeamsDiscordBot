import { writeFileSync } from "fs";
import conf from "../config.json";

export type TierListImageConfig = {
  enabled?: boolean;
  postChannel?: keyof Config["channels"] | string;
  headUrlTemplate?: string;
  width?: number;
  labelColumnWidth?: number;
  baseRowHeight?: number;
  cellSize?: number;
  gap?: number;
  padding?: number;
  fontSize?: number;
  maxImageHeight?: number;
  maxFileBytes?: number;
};

export type TierListConfig = {
  questionChannel?: keyof Config["channels"] | string;
  questionWindowSeconds?: number;
  maxCommunityAnswersPerPlayer?: number;
  askCommunityEveryNPlayers?: number;
  consistencyEveryNPlacements?: number;
  enabledCommunityQuestions?: boolean;
  image?: TierListImageConfig;
};

export type OllamaConfig = {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
};

export type ResolvedTierListConfig = Required<Omit<TierListConfig, "image">> & {
  image: Required<TierListImageConfig>;
};

export type ResolvedOllamaConfig = Required<OllamaConfig>;

export const DEFAULT_TIER_LIST_CONFIG: ResolvedTierListConfig = {
  questionChannel: "botCommands",
  questionWindowSeconds: 30,
  maxCommunityAnswersPerPlayer: 5,
  askCommunityEveryNPlayers: 1,
  consistencyEveryNPlacements: 10,
  enabledCommunityQuestions: true,
  image: {
    enabled: true,
    postChannel: "botCommands",
    headUrlTemplate: "https://mc-heads.net/avatar/{identifier}/{size}.png",
    width: 1816,
    labelColumnWidth: 223,
    baseRowHeight: 180,
    cellSize: 108,
    gap: 18,
    padding: 24,
    fontSize: 24,
    maxImageHeight: 4096,
    maxFileBytes: 8_000_000,
  },
};

export const DEFAULT_OLLAMA_CONFIG: ResolvedOllamaConfig = {
  enabled: true,
  baseUrl: "http://192.168.0.100:11434",
  model: "qwen3:14b",
  timeoutMs: 60000,
  temperature: 0.2,
};

export type Config = {
  season: number;
  mvpBonus: number;
  captainBonus: number;
  underdogMultiplier: number;
  roles: {
    blueTeamRole: string;
    redTeamRole: string;
    captainRole: string;
    organiserRole: string;
    clanLeaderRole: string;
    spectatorRole: string;
    gameNotify: string;
  };
  channels: {
    registration: string;
    announcements: string;
    gameFeed: string;
    botCommands: string;
    teamPickingVC: string;
    teamPickingChat: string;
    redTeamVC: string;
    blueTeamVC: string;
    redTeamChat: string;
    blueTeamChat: string;
    temporaryVoiceCategory: string;
  };
  dev: {
    enabled: boolean;
    guildId: string;
  };
  tierList?: TierListConfig;
  wiki?: {
    mapImageBaseUrl?: string;
    mapImageDir?: string;
  };
  llm?: {
    ollama?: OllamaConfig;
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
