import { $Enums, Game, PrismaPromise, Team } from "@prisma/client";
import { prismaClient } from "./prismaClient";
import { Snowflake } from "discord.js";
import { TeamsPlayer } from "./TeamsPlayer";

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

  constructor() {}

  public async addPlayerByDiscordId(
    discordSnowflake: Snowflake,
    ignUsed: string,
    team: Team
  ) {
    const player = await TeamsPlayer.byDiscordSnowflake(discordSnowflake);

    player.ignUsed = ignUsed;

    this.teams[team].push(player);

    return {
      error: false,
    };
  }

  public getPlayers() {
    return Object.values(this.teams).flat(1);
  }

  public getPlayersOfTeam(team: Team) {
    return this.teams[team];
  }

  public reset() {
    Object.entries(this.teams).forEach((v) => {
      v[1] = [];
    });
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
}
