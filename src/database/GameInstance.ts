import { $Enums, AnniMap, Team } from "@prisma/client";
import { CacheType, CacheTypeReducer, Guild, Snowflake } from "discord.js";
import { PlayerInstance } from "./PlayerInstance";
import { MapVoteManager } from "../logic/MapVoteManager";
import { MojangAPI } from "../api/MojangAPI";
import { MinerushVoteManager } from "../logic/MinerushVoteManager";
import { prismaClient } from "./prismaClient";
import { ConfigManager } from "../ConfigManager";
import { DiscordUtil } from "../util/DiscordUtil";
import { activateFeed } from "../logic/gameFeed/ActivateFeed";
import { Channels } from "../Channels";
import { addRegisteredPlayersFeed } from "../logic/gameFeed/RegisteredGameFeed";
import { addTeamsGameFeed } from "../logic/gameFeed/TeamsGameFeed";
import { Elo } from "../logic/Elo";

// wrapper class for Game
export class GameInstance {
  private static instance: GameInstance;
  gameId?: string;
  isFinished?: boolean;
  announced = false;
  isRestarting = false;
  isDoubleElo = false;
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
  lateSignups: Set<string> = new Set();

  blueMeanElo?: number;
  redMeanElo?: number;
  blueExpectedScore?: number;
  redExpectedScore?: number;

  gameWinner?: "RED" | "BLUE";
  teamsDecidedBy?: "DRAFT" | "RANDOMISED" | null;

  MVPPlayerBlue?: string;
  MVPPlayerRed?: string;

  organiser?: string | null;
  host?: string | null;

  mapVoteManager?: MapVoteManager;
  minerushVoteManager?: MinerushVoteManager;
  private readonly mvpVoters = new Set<string>();

  private mvpVotes: {
    RED: Record<string, number>;
    BLUE: Record<string, number>;
  } = {
    RED: {},
    BLUE: {},
  };

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
    this.isFinished = undefined;
    this.announced = false;
    this.isRestarting = false;
    this.isDoubleElo = false;
    this.startTime = undefined;
    this.endTime = undefined;
    this.settings = {
      minerushing: undefined,
      bannedClasses: undefined,
      map: undefined,
    };
    this.teams = { RED: [], BLUE: [], UNDECIDED: [] };
    this.teamsDecidedBy = null;
    this.mapVoteManager = undefined;
    this.minerushVoteManager = undefined;
    this.mvpVoters.clear();
    this.mvpVotes = { RED: {}, BLUE: {} };
    this.MVPPlayerBlue = "";
    this.MVPPlayerRed = "";
  }

  public static async resetGameInstance() {
    const currentInstance = this.getInstance();
    if (currentInstance) {
      await prismaClient.game.saveGameFromInstance(currentInstance);
    }
    this.instance = new GameInstance();
    this.instance.reset();
  }

  public startMinerushVote() {
    if (this.minerushVoteManager) {
      this.minerushVoteManager.cancelVote();
    }
    this.minerushVoteManager = new MinerushVoteManager();
    this.minerushVoteManager.on("pollEnd", (minerushWinner) => {
      this.setMinerushing(minerushWinner);
    });
  }

  public startMapVote(maps: AnniMap[]) {
    if (this.mapVoteManager) {
      this.mapVoteManager.cancelVote();
    }
    this.mapVoteManager = new MapVoteManager(maps);
    this.mapVoteManager.on("pollEnd", (winningMap) => {
      this.setMap(winningMap);
    });
  }

  public closePolls() {
    if (this.mapVoteManager) {
      this.mapVoteManager.cancelVote();
      console.log("Map vote has been closed.");
    }

    if (this.minerushVoteManager) {
      this.minerushVoteManager.cancelVote();
      console.log("Minerush vote has been closed.");
    }
  }

  public setMap(map: AnniMap) {
    this.settings.map = map;
    console.log("The winning map was: " + map);
  }

  public setMinerushing(minerush: boolean) {
    this.settings.minerushing = minerush;
    console.log("Minerushing is: " + minerush);
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

  public addLateSignup(discordSnowflake: string): void {
    this.lateSignups.add(discordSnowflake);
  }

  public isLateSignup(discordSnowflake: string): boolean {
    return this.lateSignups.has(discordSnowflake);
  }

  public async addPlayerByDiscordId(
    discordSnowflake: Snowflake,
    ignUsed: string,
    uuid?: string
  ) {
    const player = await PlayerInstance.byDiscordSnowflake(discordSnowflake);

    if (!uuid) {
      if (ignUsed === "") {
        uuid = player.primaryMinecraftAccount ?? undefined;
      } else {
        const fetchedUuid = await MojangAPI.usernameToUUID(ignUsed);
        if (fetchedUuid) {
          uuid = fetchedUuid;
        } else {
          console.warn(
            `No UUID found for IGN ${ignUsed}. Proceeding with fallback.`
          );
        }
      }
    }

    let ign: string | null = ignUsed;
    if (uuid) {
      const resolvedIgn = await MojangAPI.uuidToUsername(uuid);
      if (resolvedIgn) {
        ign = resolvedIgn;
      } else {
        console.warn(`UUID ${uuid} does not resolve to a valid IGN.`);
      }
    }

    if (!uuid || !ign) {
      console.warn(
        `Fallback triggered for player ${discordSnowflake} with IGN ${ignUsed}.`
      );

      player.ignUsed = ignUsed;

      this.teams["UNDECIDED"].push(player);

      return {
        error: false,
        playerInstance: player,
        fallback: true,
      } as const;
    }

    if (uuid && !player.primaryMinecraftAccount) {
      await prismaClient.player.update({
        where: { id: player.playerId },
        data: { primaryMinecraftAccount: uuid },
      });
      player.primaryMinecraftAccount = uuid;
    }

    if (ign && !player.minecraftAccounts.includes(ign)) {
      const result = await prismaClient.player.update({
        where: { id: player.playerId },
        data: {
          minecraftAccounts: {
            push: ign,
          },
        },
      });

      if (!result) {
        console.error(
          `Failed to register IGN for discord user ${discordSnowflake} with IGN ${ign}.`
        );
        return {
          error: "Something went wrong while adding the IGN! Is it valid?",
        } as const;
      }

      player.minecraftAccounts.push(ign);
    }

    if (ign) {
      await prismaClient.player.update({
        where: { id: player.playerId },
        data: { latestIGN: ign },
      });
      player.ignUsed = ign;
    }

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
    const combined = new Set([
      ...this.teams["UNDECIDED"],
      ...this.teams["RED"],
      ...this.teams["BLUE"],
    ]);
    this.teams["UNDECIDED"] = Array.from(combined);
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

  public setTeamCaptain(team: Team, player: PlayerInstance) {
    const oldTeamCaptain = this.getCaptainOfTeam(team);

    if (oldTeamCaptain) {
      oldTeamCaptain.captain = false;
    }

    player.captain = true;

    Object.keys(this.teams).forEach((teamKey) => {
      const index = this.teams[teamKey as Team].indexOf(player);
      if (index !== -1) this.teams[teamKey as Team].splice(index, 1);
    });

    if (!this.teams[team].includes(player)) {
      this.teams[team].push(player);
    }

    return {
      oldCaptain: oldTeamCaptain?.discordSnowflake,
      newCaptain: player.discordSnowflake,
    };
  }

  public getCaptainOfTeam(team: Team) {
    return this.teams[team].find((p) => p.captain === true);
  }

  public async testValues(fillOption: "red-blue" | "undecided" | "none") {
    console.info(
      `[GAME] Initializing test values with fillOption: ${fillOption}`
    );

    // this.gameId = "default-game-id";
    this.isFinished = false;
    this.announced = true;
    this.startTime = new Date(Date.now() + 6 * 60 * 1000); // 6m from now for polls
    this.endTime = new Date("2025-01-01T02:00:00Z");
    this.settings = {
      minerushing: true,
      bannedClasses: ["SNIPER"],
      map: "DUELSTAL",
    };
    this.MVPPlayerBlue = "Ungenes";
    this.teams.RED = [];
    this.teams.BLUE = [];
    this.teams.UNDECIDED = [];

    await activateFeed(Channels.gameFeed, addRegisteredPlayersFeed);
    await activateFeed(Channels.gameFeed, addTeamsGameFeed);

    if (fillOption !== "none") {
      console.info(`[GAME] Filling teams with test players...`);
      await this.fillTeamsWithTestPlayers(3, fillOption);
      console.info(`[GAME] Teams filled. Current teams:`, this.teams);

      this.teams.RED.forEach((player) => {
        this.mvpVotes.RED[player.discordSnowflake] = Math.floor(
          Math.random() * 20
        );
      });
      this.teams.BLUE.forEach((player) => {
        this.mvpVotes.BLUE[player.discordSnowflake] = Math.floor(
          Math.random() * 20
        );
      });

      console.info(`[GAME] MVP votes populated with test players.`);
    }

    this.mapVoteManager = new MapVoteManager([
      "AFTERMATH1V1",
      "ANDORRA1V1",
      "DUELSTAL",
    ] as AnniMap[]);

    this.minerushVoteManager = new MinerushVoteManager();

    if (this.mapVoteManager) {
      await this.mapVoteManager.startMapVote();
    }
    if (this.minerushVoteManager) {
      await this.minerushVoteManager.startMinerushVote();
    }

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

  public async addPlayerByNameOrDiscord(
    identifier: string,
    team: Team | "UNDECIDED",
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const player = await this.findPlayerByNameOrDiscord(identifier);
    if (!player || !this.isPlayerInUndecided(player)) return false;

    this.removePlayerFromAllTeams(player);
    if (!guild) {
      console.error(`Guild not found for ID: ${player.discordSnowflake}`);
      return false;
    }
    const member = await guild.members
      .fetch(player.discordSnowflake)
      .catch(() => null);
    if (!member) {
      console.error(`GuildMember not found for ID: ${player.discordSnowflake}`);
      return false;
    }

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (team === "BLUE") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
      await DiscordUtil.assignRole(member, blueTeamRoleId);
    } else if (team === "RED") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
      await DiscordUtil.assignRole(member, redTeamRoleId);
    }

    this.teams[team].push(player);
    return true;
  }

  public async removePlayerByNameOrDiscord(
    identifier: string,
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const player = await this.findPlayerByNameOrDiscord(identifier);
    if (!player) return false;

    this.removePlayerFromAllTeams(player);

    if (!guild) {
      console.error(`Guild not found for ID: ${player.discordSnowflake}`);
      return false;
    }

    const member = await guild.members
      .fetch(player.discordSnowflake)
      .catch(() => null);
    if (!member) {
      console.error(`GuildMember not found for ID: ${player.discordSnowflake}`);
      return false;
    }

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (member.roles.cache.has(blueTeamRoleId)) {
      await DiscordUtil.removeRole(member, blueTeamRoleId);
    }
    if (member.roles.cache.has(redTeamRoleId)) {
      await DiscordUtil.removeRole(member, redTeamRoleId);
    }
    return true;
  }

  public async findPlayerByNameOrDiscord(
    identifier: string
  ): Promise<PlayerInstance | null> {
    const lowerIdentifier = identifier.toLowerCase();

    const playerByName = this.getPlayers().find(
      (p) => p.ignUsed?.toLowerCase() === lowerIdentifier
    );
    if (playerByName) return playerByName;

    const playerByDiscord =
      await prismaClient.player.byDiscordSnowflake(identifier);
    return playerByDiscord
      ? this.getPlayers().find(
          (p) => p.discordSnowflake === playerByDiscord.discordSnowflake
        ) || null
      : null;
  }

  private isPlayerInUndecided(player: PlayerInstance): boolean {
    return this.teams["UNDECIDED"]?.includes(player) || false;
  }

  private removePlayerFromAllTeams(player: PlayerInstance): void {
    for (const team of Object.keys(this.teams) as Array<Team | "UNDECIDED">) {
      this.teams[team] = this.teams[team].filter((p) => p !== player);
    }
  }

  public async replacePlayerByNameOrDiscord(
    oldIdentifier: string,
    newIdentifier: string,
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    const oldPlayer = await this.findPlayerByNameOrDiscord(oldIdentifier);
    const newPlayer = await this.findPlayerByNameOrDiscord(newIdentifier);

    if (
      !oldPlayer ||
      !newPlayer ||
      this.isPlayerInUndecided(oldPlayer) ||
      !this.isPlayerInUndecided(newPlayer)
    ) {
      return false;
    }

    const oldPlayerTeam = this.getPlayersTeam(oldPlayer);
    if (!oldPlayerTeam || oldPlayerTeam === "UNDECIDED") {
      return false;
    }

    if (!guild) {
      console.error(
        `Guild not found for replacing players: ${oldPlayer.discordSnowflake}, ${newPlayer.discordSnowflake}`
      );
      return false;
    }

    const oldMember = await guild.members
      .fetch(oldPlayer.discordSnowflake)
      .catch(() => null);
    const newMember = await guild.members
      .fetch(newPlayer.discordSnowflake)
      .catch(() => null);

    if (!oldMember || !newMember) {
      console.error(
        `Guild members not found for players: ${oldPlayer.discordSnowflake}, ${newPlayer.discordSnowflake}`
      );
      return false;
    }

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (oldMember.roles.cache.has(blueTeamRoleId)) {
      await DiscordUtil.removeRole(oldMember, blueTeamRoleId);
    }
    if (oldMember.roles.cache.has(redTeamRoleId)) {
      await DiscordUtil.removeRole(oldMember, redTeamRoleId);
    }

    if (newMember.roles.cache.has(blueTeamRoleId)) {
      await DiscordUtil.removeRole(newMember, blueTeamRoleId);
    }
    if (newMember.roles.cache.has(redTeamRoleId)) {
      await DiscordUtil.removeRole(newMember, redTeamRoleId);
    }

    if (oldPlayerTeam === "BLUE") {
      await DiscordUtil.assignRole(newMember, blueTeamRoleId);
    } else if (oldPlayerTeam === "RED") {
      await DiscordUtil.assignRole(newMember, redTeamRoleId);
    }

    this.removePlayerFromAllTeams(oldPlayer);
    this.removePlayerFromAllTeams(newPlayer);
    this.teams[oldPlayerTeam].push(newPlayer);

    return true;
  }

  getPlayersTeam(player: PlayerInstance): Team | "UNDECIDED" | null {
    return (
      (Object.keys(this.teams) as Array<Team | "UNDECIDED">).find((team) =>
        this.teams[team]?.includes(player)
      ) ?? null
    );
  }

  public async movePlayerBetweenTeams(
    playerName: string,
    fromTeam: Team | "UNDECIDED",
    toTeam: Team | "UNDECIDED",
    guild: CacheTypeReducer<CacheType, Guild, null>
  ): Promise<boolean> {
    if (
      !["RED", "BLUE", "UNDECIDED"].includes(fromTeam) ||
      !["RED", "BLUE", "UNDECIDED"].includes(toTeam)
    ) {
      console.error("Invalid teams specified:", { fromTeam, toTeam });
      return false;
    }

    const player = await this.findPlayerByNameOrDiscord(playerName);
    if (!player || this.getPlayersTeam(player) !== fromTeam) {
      console.error("Player lookup failed or team mismatch:", {
        playerName,
        fromTeam,
      });
      return false;
    }

    if (!guild) {
      console.error(
        `Guild not found for moving player: ${player.discordSnowflake}`
      );
      return false;
    }

    const member = await guild.members
      .fetch(player.discordSnowflake)
      .catch(() => null);
    if (!member) {
      console.error(
        `GuildMember not found for moving player: ${player.discordSnowflake}`
      );
      return false;
    }

    const config = ConfigManager.getConfig();
    const blueTeamRoleId = config.roles.blueTeamRole;
    const redTeamRoleId = config.roles.redTeamRole;

    if (fromTeam === "BLUE") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
    } else if (fromTeam === "RED") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
    }

    if (toTeam === "BLUE") {
      if (member.roles.cache.has(redTeamRoleId)) {
        await DiscordUtil.removeRole(member, redTeamRoleId);
      }
      await DiscordUtil.assignRole(member, blueTeamRoleId);
    } else if (toTeam === "RED") {
      if (member.roles.cache.has(blueTeamRoleId)) {
        await DiscordUtil.removeRole(member, blueTeamRoleId);
      }
      await DiscordUtil.assignRole(member, redTeamRoleId);
    }

    this.removePlayerFromAllTeams(player);
    this.teams[toTeam].push(player);
    console.info(
      `Player ${playerName} successfully moved from ${JSON.stringify(fromTeam)} to ${JSON.stringify(toTeam)}.`
    );
    return true;
  }

  public async setGameWinner(team: Team) {
    this.gameWinner = team;
  }

  public voteMvp(voterId: string, targetId: string): { error?: string } {
    if (!this.isFinished) {
      return { error: "The game is not finished yet." };
    }

    if (this.mvpVoters.has(voterId)) {
      return { error: "You have already voted for MVP." };
    }

    const voterPlayer = this.getPlayers().find(
      (p) => p.discordSnowflake === voterId
    );
    const targetPlayer = this.getPlayers().find(
      (p) => p.discordSnowflake === targetId
    );

    if (!voterPlayer || !targetPlayer) {
      return { error: "Voter or target player not found in the game." };
    }

    const voterTeam = this.getPlayersTeam(voterPlayer);
    const targetTeam = this.getPlayersTeam(targetPlayer);

    if (
      !voterTeam ||
      voterTeam === "UNDECIDED" ||
      !targetTeam ||
      targetTeam === "UNDECIDED"
    ) {
      return { error: "Both voter and target must be on a decided team." };
    }

    if (voterTeam !== targetTeam) {
      return { error: "You can only vote for a player on your own team!" };
    }

    if (voterId === targetId) {
      return { error: "You cannot vote for yourself." };
    }

    if (!this.mvpVotes[voterTeam][targetId]) {
      this.mvpVotes[voterTeam][targetId] = 0;
    }
    this.mvpVotes[voterTeam][targetId] += 1;

    this.mvpVoters.add(voterId);

    return {};
  }

  public async countMVPVotes() {
    console.log("Starting to count MVP votes now...");
    this.MVPPlayerRed = await this.determineTeamMVP("RED");
    console.log("Determined red team MVP.");
    this.MVPPlayerBlue = await this.determineTeamMVP("BLUE");
    console.log("Determined blue team MVP.");
    const redMVP = this.MVPPlayerRed ?? "no body";
    const blueMVP = this.MVPPlayerBlue ?? "no body";
    console.log("Sending MVPees announcement");
    await DiscordUtil.sendMessage("gameFeed", "\u200b");

    const messageText = `🏆 **Game MVPs** 🏆\n🔴 **RED Team:** ${redMVP}\n🔵 **BLUE Team:** ${blueMVP}`;
    await DiscordUtil.sendMessage("gameFeed", messageText);
    await DiscordUtil.sendMessage("gameFeed", "\u200b");
  }

  private async determineTeamMVP(team: Team): Promise<string> {
    console.log("Determining MVP for", team);
    const teamVotes = this.mvpVotes[team];
    const entries = Object.entries(teamVotes);

    if (entries.length === 0) return "";

    console.log("Finding the maximum votes...");
    const maxVotes = Math.max(...entries.map(([, votes]) => votes));
    const tiedPlayers = entries
      .filter(([, votes]) => votes === maxVotes)
      .map(([playerId]) => playerId);

    let selectedPlayerId: string;
    if (tiedPlayers.length > 1) {
      console.log("A tie detected among players: ", tiedPlayers);
      selectedPlayerId =
        tiedPlayers[Math.floor(Math.random() * tiedPlayers.length)];
      console.log(
        `Randomly selected ${selectedPlayerId} as the MVP in case of a tie.`
      );
      await DiscordUtil.sendMessage(
        "gameFeed",
        `💥 There has been a tie for the MVP of ${team} team! There can only be one, one of them will be randomly selected.`
      );
    } else {
      selectedPlayerId = tiedPlayers[0];
    }

    console.log("Finding and returning MVP player...");
    const player = this.getPlayers().find(
      (p) => p.discordSnowflake === selectedPlayerId
    );

    return player?.ignUsed ?? "";
  }

  public changeHowTeamsDecided(type: "DRAFT" | "RANDOMISED" | null) {
    this.teamsDecidedBy = typeof type === "string" ? type : null;
  }

  public calculateMeanEloAndExpectedScore() {
    const { blueMeanElo, redMeanElo, blueExpectedScore, redExpectedScore } =
      Elo.calculateMeanEloAndExpectedScore(this.teams);

    this.blueMeanElo = blueMeanElo;
    this.redMeanElo = redMeanElo;
    this.blueExpectedScore = blueExpectedScore;
    this.redExpectedScore = redExpectedScore;
  }
}
