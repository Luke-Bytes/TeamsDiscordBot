import { $Enums, AnniMap, Team } from "@prisma/client";
import { Snowflake } from "discord.js";
import { PlayerInstance } from "./PlayerInstance";
import { MapVoteManager } from "../logic/MapVoteManager";
import { MojangAPI } from "../api/MojangAPI";
import { MinerushVoteManager } from "../logic/MinerushVoteManager";
import { prismaClient } from "./prismaClient";

// wrapper class for Game
export class GameInstance {
  private static instance: GameInstance;
  gameId?: string;
  finished?: boolean;
  announced = false;
  startTime?: Date;
  endTime?: Date;
  settings: {
    minerushing?: boolean;
    bannedClasses?: $Enums.AnniClass[];
    map?: $Enums.AnniMap;
  } = {};

  teams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };

  mapVoteManager?: MapVoteManager;
  minerushVoteManager?: MinerushVoteManager;

  private constructor() {
    this.reset();
  }

  public static getInstance(): GameInstance {
    if (!GameInstance.instance) {
      GameInstance.instance = new GameInstance();
    }
    return GameInstance.instance;
  }

  public reset() {
    this.gameId = undefined;
    this.finished = undefined;
    this.announced = false;
    this.startTime = undefined;
    this.endTime = undefined;
    this.settings = {
      minerushing: undefined,
      bannedClasses: undefined,
      map: undefined,
    };
    this.teams = { RED: [], BLUE: [], UNDECIDED: [] };
    this.mapVoteManager = undefined;
    this.minerushVoteManager = undefined;
  }

  public static async resetGameInstance() {
    const currentInstance = this.getInstance();
    if (currentInstance) {
      // FIXME commit to database method here
    }
    this.instance = new GameInstance();
  }

  public startMinerushVote() {
    this.minerushVoteManager = new MinerushVoteManager();
    this.minerushVoteManager.on("pollEnd", (answer) => {
      this.settings.minerushing = answer;
    });
  }

  public startMapVote(maps: AnniMap[]) {
    this.mapVoteManager = new MapVoteManager(maps);
    this.mapVoteManager.on("pollEnd", (winningMap) => {
      this.setMap(winningMap);
    });
  }

  public setMap(map: AnniMap) {
    if (this.mapVoteManager) {
      this.mapVoteManager.cancelVote();
    }

    this.settings.map = map;
  }

  public async announce() {
    this.announced = true;

    if (this.mapVoteManager) {
      await this.mapVoteManager.startMapVote();
    }
    if (this.minerushVoteManager) {
      await this.minerushVoteManager.startMinerushVote();
    }
  }

  private getTeamWithLeastPlayers() {
    return Object.keys(this.teams).sort(
      (a, b) => this.teams[a as Team].length - this.teams[b as Team].length
    )[0] as Team;
  }

  public async addPlayerByDiscordId(
    discordSnowflake: Snowflake,
    ignUsed: string
  ) {
    const player = await PlayerInstance.byDiscordSnowflake(discordSnowflake);
    let uuid: string | undefined | null;

    if (ignUsed === "") {
      uuid = player.primaryMinecraftAccount;
    } else {
      uuid = await MojangAPI.usernameToUUID(ignUsed);
      if (!uuid) {
        return {
          error: "That IGN doesn't exist! Did you spell it correctly?",
        } as const;
      }
    }

    if (!uuid) {
      return {
        error: "The player does not have a primary minecraft account.",
      } as const;
    }

    if (!player.minecraftAccounts.includes(uuid)) {
      const result = await prismaClient.player.addMcAccount(
        discordSnowflake,
        uuid
      );
      if (result.error) {
        console.error(
          `Failed to register UUID for discord user ${discordSnowflake} with UUID ${uuid}: ${result.error}`
        );
        return {
          error: "Something went wrong while adding the IGN! Is it valid?",
        } as const;
      }
      player.minecraftAccounts.push(uuid);
    }

    const ign = ignUsed === "" ? await MojangAPI.uuidToUsername(uuid) : ignUsed;

    if (!ign) {
      return {
        error: "Could not locate IGN of player.",
      } as const;
    }

    player.ignUsed = ign;

    this.teams["UNDECIDED"].push(player);

    return {
      error: false,
      playerInstance: player,
    } as const;
  }

  public async removePlayerByDiscordId(discordSnowflake: Snowflake) {
    const playerIndex = Object.keys(this.teams).find((team) =>
      this.teams[team as Team].some(
        (player) => player.discordSnowflake === discordSnowflake
      )
    );

    if (!playerIndex) {
      return {
        error: "Player not found in any team.",
      } as const;
    }

    this.teams[playerIndex as Team] = this.teams[playerIndex as Team].filter(
      (player) => player.discordSnowflake !== discordSnowflake
    );
  }

  public getPlayers() {
    return Object.values(this.teams).flat(1);
  }

  public getPlayersOfTeam(team: Team | "UNDECIDED") {
    return this.teams[team];
  }

  public resetTeams() {
    this.teams["UNDECIDED"].push(...this.teams["RED"], ...this.teams["BLUE"]);
    this.teams["RED"] = [];
    this.teams["BLUE"] = [];
  }

  public createTeams(createMethod: "random") {
    switch (createMethod) {
      case "random": {
        const simulatedTeams = this.simulateShuffledTeams();
        this.teams.BLUE = simulatedTeams.BLUE;
        this.teams.RED = simulatedTeams.RED;
        break;
      }
    }
  }

  public simulateShuffledTeams(): Record<Team, PlayerInstance[]> {
    const undecidedPlayers = Array.from(this.getPlayersOfTeam("UNDECIDED"));
    const shuffled = undecidedPlayers.sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);

    return {
      BLUE: shuffled.slice(0, half),
      RED: shuffled.slice(half),
    };
  }

  public getCaptainOfTeam(team: Team) {
    return this.teams[team].find((p) => p.captain);
  }

  public setTeamCaptain(team: Team, player: PlayerInstance) {
    const oldTeamCaptain = this.getCaptainOfTeam(team);

    if (oldTeamCaptain) {
      oldTeamCaptain.captain = false;
    }

    player.captain = true;

    if (!this.teams[team].includes(player)) {
      const otherTeam = team === "RED" ? "BLUE" : "RED";

      if (this.teams["UNDECIDED"].includes(player)) {
        this.teams["UNDECIDED"].splice(this.teams["UNDECIDED"].indexOf(player));
      }

      if (this.teams[otherTeam].includes(player)) {
        this.teams[otherTeam].splice(this.teams[otherTeam].indexOf(player));
      }

      this.teams[team].push(player);
    }
    return {
      oldCaptain: oldTeamCaptain?.discordSnowflake,
      newCaptain: player.discordSnowflake,
    };
  }

  public async testValues(fillOption: "red-blue" | "undecided" | "none") {
    console.info(
      `[GAME] Initializing test values with fillOption: ${fillOption}`
    );

    this.gameId = "default-game-id";
    this.finished = false;
    this.announced = true;
    this.startTime = new Date("2025-01-01T00:00:00Z");
    this.endTime = new Date("2025-01-01T02:00:00Z");
    this.settings = {
      minerushing: true,
      bannedClasses: ["SNIPER"],
      map: "DUELSTAL",
    };

    this.teams.RED = [];
    this.teams.BLUE = [];
    this.teams.UNDECIDED = [];

    if (fillOption !== "none") {
      console.info(`[GAME] Filling teams with test players...`);
      await this.fillTeamsWithTestPlayers(4, fillOption);
      console.info(`[GAME] Teams filled. Current teams:`, this.teams);
    }

    this.mapVoteManager = new MapVoteManager([
      "AFTERMATH1V1",
      "ANDORRA1V1",
      "DUELSTAL",
    ] as AnniMap[]);

    this.minerushVoteManager = new MinerushVoteManager();

    const pollVotes = false;
    if (pollVotes) {
      console.info(`[GAME] Starting map and minerush votes.`);
      await this.mapVoteManager.startMapVote();
      await this.minerushVoteManager.startMinerushVote();
    }
  }

  private async fillTeamsWithTestPlayers(
    playerCount: number,
    fillOption: "red-blue" | "undecided"
  ) {
    console.info(`[GAME] Creating ${playerCount} test player instances...`);

    const playerInstances: PlayerInstance[] = [];
    for (let i = 0; i < playerCount; i++) {
      const player = await PlayerInstance.testValues();
      playerInstances.push(player);
    }

    if (fillOption === "red-blue") {
      playerInstances.forEach((player, index) => {
        if (index % 2 === 0) {
          this.teams.RED.push(player);
        } else {
          this.teams.BLUE.push(player);
        }
      });
      console.info(`[GAME] Players assigned to RED and BLUE teams.`);
    } else if (fillOption === "undecided") {
      this.teams.UNDECIDED.push(...playerInstances);
      console.info(`[GAME] Players assigned to UNDECIDED team.`);
    }

    console.info(`[GAME] Final team state:`, this.teams);
  }
}
