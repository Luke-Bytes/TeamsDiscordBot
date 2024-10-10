import { Snowflake } from "discord.js";

export class PlayerData {
  static playerDataList: PlayerData[] = [];

  private readonly discordUserId: Snowflake;
  private discordUserName: string;
  private inGameName: string;
  private elo: number;
  private wins: number;
  private losses: number;
  private isCaptain: boolean;
  private isMvp: boolean;

  constructor(
    discordUserId: Snowflake,
    discordUserName: string,
    inGameName: string,
    elo: number = 1000,
    wins: number = 0,
    losses: number = 0,
    isCaptain: boolean = false,
    isMvp: boolean = false
  ) {
    this.discordUserId = discordUserId;
    this.discordUserName = discordUserName;
    this.inGameName = inGameName;
    this.elo = elo;
    this.wins = wins;
    this.losses = losses;
    this.isCaptain = isCaptain;
    this.isMvp = isMvp;

    PlayerData.playerDataList.push(this);
  }

  public getDiscordUserId(): Snowflake {
    return this.discordUserId;
  }

  public getDiscordUserName(): string {
    return this.discordUserName;
  }

  public getInGameName(): string {
    return this.inGameName;
  }

  public getElo(): number {
    return this.elo;
  }

  public getWins(): number {
    return this.wins;
  }

  public getLosses(): number {
    return this.losses;
  }

  public getIsCaptain(): boolean {
    return this.isCaptain;
  }

  public getIsMvp(): boolean {
    return this.isMvp;
  }

  // Updaters
  public updateInGameName(newName: string): void {
    this.inGameName = newName;
  }

  public updateDiscordUserName(newName: string): void {
    this.discordUserName = newName;
  }

  public updateElo(newElo: number): void {
    this.elo = newElo;
  }

  public addWin(): void {
    this.wins += 1;
  }

  public addLoss(): void {
    this.losses += 1;
  }

  public setCaptain(captain: boolean): void {
    this.isCaptain = captain;
  }

  public setMvp(mvp: boolean): void {
    this.isMvp = mvp;
  }

  public static getPlayerByInGameName(inGameName: string): PlayerData | null {
    return (
      PlayerData.playerDataList.find(
        (player) => player.getInGameName() === inGameName
      ) || null
    );
  }

  public static getAllPlayers(): PlayerData[] {
    return PlayerData.playerDataList;
  }

  public static clearPlayerDataList(): void {
    PlayerData.playerDataList = [];
  }
}
