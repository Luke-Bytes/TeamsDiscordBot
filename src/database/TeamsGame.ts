import { $Enums, AnniMap, Team } from "@prisma/client";
import { Snowflake } from "discord.js";
import { TeamsPlayer } from "./TeamsPlayer";
import { MapVoteManager } from "../logic/MapVoteManager";
import { MinerushVoteManager } from "logic/MinerushVoteManager";
import { MojangAPI } from "api/MojangAPI";

// wrapper class for Game
// todo bad naming
export class TeamsGame {
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

  teams: Record<Team, TeamsPlayer[]> = { RED: [], BLUE: [] };
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
    const player = await TeamsPlayer.byDiscordSnowflake(discordSnowflake);
    const uuid = await MojangAPI.usernameToUUID(ignUsed);
    if (!uuid) {
      return {
        error: "This in-game name doesn't exist.",
      } as const;
    }

    if (!player.minecraftAccounts.includes(uuid)) {
      return {
        error:
          "You have not registered this in-game name. Please use `/ign add`",
      } as const;
    }

    player.ignUsed = ignUsed;

    const team = this.getTeamWithLeastPlayers();
    this.teams[team].push(player);

    return {
      error: false,
      team: team,
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
