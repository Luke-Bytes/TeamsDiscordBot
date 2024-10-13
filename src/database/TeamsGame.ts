import {
  $Enums,
  AnniClass,
  Game,
  Player,
  PrismaPromise,
  Team,
} from "@prisma/client";
import { prismaClient } from "./prismaClient";
import { Snowflake } from "discord.js";
import { TeamsPlayer } from "./TeamsPlayer";
import { error } from "console";
import { MapVoteManager } from "logic/MapVoteManager";

// wrapper class for Game
// todo bad naming
export class TeamsGame {
  gameId?: string;

  finished?: boolean;
  startTime?: Date;
  endTime?: Date;
  settings?: {
    minerushing: boolean;
    bannedClasses: $Enums.AnniClass[];
    map: $Enums.AnniMap;
  };

  teams: Record<Team, TeamsPlayer[]> = { RED: [], BLUE: [] };
  mapVoteManager?: MapVoteManager;

  constructor() {}

  private getTeamWithLeastPlayers() {
    return Object.keys(this.teams).sort(
      (a, b) => this.teams[a as Team].length - this.teams[b as Team].length
    )[0] as Team;
  }

  public async addPlayerByDiscordId(
    discordSnowflake: Snowflake,
    ignUsed: string
  ): Promise<
    | {
        error: true;
        message: string;
      }
    | {
        error: false;
        team: Team;
      }
  > {
    const player = await TeamsPlayer.byDiscordSnowflake(discordSnowflake);

    if (!player.minecraftAccounts.includes(ignUsed)) {
      return {
        error: true,
        message:
          "You have not registered this in-game name. Please use /register",
      };
    }

    player.ignUsed = ignUsed;

    const team = this.getTeamWithLeastPlayers();
    this.teams[team].push(player);

    return {
      error: false,
      team: team,
    };
  }

  public getPlayers() {
    return Object.values(this.teams).flat(1);
  }

  public getPlayersOfTeam(team: Team) {
    return this.teams[team];
  }

  public reset() {
    this.teams["BLUE"] = [];
    this.teams["RED"] = [];
  }

  public shuffleTeams(shuffleMethod: "random") {
    switch (shuffleMethod) {
      case "random":
        const shuffled = this.getPlayers().sort(() => Math.random() - 0.5);
        const half = Math.ceil(shuffled.length / 2);

        const blue = shuffled.slice(0, half);
        const red = shuffled.slice(half);

        this.teams.BLUE = blue;
        this.teams.RED = red;
    }
  }

  public getCaptainOfTeam(team: Team) {
    return this.teams[team].find((p) => p.captain);
  }

  public setTeamCaptain(team: Team, player: TeamsPlayer) {
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
  }
}
