import { $Enums, AnniMap, Team } from "@prisma/client";
import { Snowflake } from "discord.js";
import { PlayerInstance } from "./PlayerInstance";
import { MapVoteManager } from "../logic/MapVoteManager";
import { MinerushVoteManager } from "logic/MinerushVoteManager";
import { MojangAPI } from "api/MojangAPI";
import { prismaClient } from "database/prismaClient";

// wrapper class for Game
// todo bad naming
export class GameInstance {
  gameId?: string;

  finished?: boolean;
  announced = false;
  startTime?: Date;
  endTime?: Date;
  settings: {
    minerushing?: boolean;
    bannedClasses?: $Enums.AnniClass[];
    map?: $Enums.AnniMap;
  };

  teams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  mapVoteManager?: MapVoteManager;
  minerushVoteManager?: MinerushVoteManager;

  constructor() {
    this.settings = {};
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
    let uuid: string | undefined;

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

  public getPlayers() {
    return Object.values(this.teams).flat(1);
  }

  public getPlayersOfTeam(team: Team) {
    return this.teams[team];
  }

  public resetTeams() {
    this.teams["BLUE"] = [];
    this.teams["RED"] = [];
  }

  public shuffleTeams(shuffleMethod: "random") {
    switch (shuffleMethod) {
      case "random":
        {
          const shuffled = this.getPlayers().sort(() => Math.random() - 0.5);
          const half = Math.ceil(shuffled.length / 2);

          const blue = shuffled.slice(0, half);
          const red = shuffled.slice(half);

          this.teams.BLUE = blue;
          this.teams.RED = red;
        }
        break;
    }
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
}
