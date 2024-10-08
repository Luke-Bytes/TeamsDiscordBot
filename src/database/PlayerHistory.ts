import { Snowflake } from 'discord.js';

export class PlayerHistory {
    private readonly discordUserId: Snowflake;
    private discordUserName: string;
    private inGameName: string;
    private elo: number;
    private wins: number;
    private losses: number;
    private captainCount: number;
    private mvpCount: number;

    constructor(
        discordUserId: Snowflake,
        discordUserName: string,
        inGameName: string,
        elo: number = 1000,
        wins: number = 0,
        losses: number = 0,
        captainCount: number = 0,
        mvpCount: number = 0
    ) {
        this.discordUserId = discordUserId;
        this.discordUserName = discordUserName;
        this.inGameName = inGameName;
        this.elo = elo;
        this.wins = wins;
        this.losses = losses;
        this.captainCount = captainCount;
        this.mvpCount = mvpCount;
    }

    public getDiscordUserId(): Snowflake {
        return this.discordUserId;
    }

    public getDiscordUserName(): string {
        return this.discordUserName;
    }

    public updateDiscordUserName(newName: string): void {
        this.discordUserName = newName;
    }

    public getInGameName(): string {
        return this.inGameName;
    }

    public updateInGameName(newName: string): void {
        this.inGameName = newName;
    }

    public getElo(): number {
        return this.elo;
    }

    public updateElo(newElo: number): void {
        this.elo = newElo;
    }

    public getWins(): number {
        return this.wins;
    }

    public addWin(): void {
        this.wins += 1;
    }

    public getLosses(): number {
        return this.losses;
    }

    public addLoss(): void {
        this.losses += 1;
    }

    public getCaptainCount(): number {
        return this.captainCount;
    }

    public incrementCaptainCount(): void {
        this.captainCount += 1;
    }

    public getMvpCount(): number {
        return this.mvpCount;
    }

    public incrementMvpCount(): void {
        this.mvpCount += 1;
    }
}
