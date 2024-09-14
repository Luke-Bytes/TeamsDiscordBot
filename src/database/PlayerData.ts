export class PlayerData {
    private discordUserId: string;
    private discordUserName: string;
    private inGameName: string;
    private elo: number;
    private wins: number;
    private losses: number;
    private isCaptain: boolean;
    private isMvp: boolean;

    constructor(discordUserId: string, discordUserName: string, inGameName: string, elo: number = 1000, wins: number = 0, losses: number = 0, isCaptain: boolean = false, isMvp: boolean = false) {
        this.discordUserId = discordUserId;
        this.discordUserName = discordUserName;
        this.inGameName = inGameName;
        this.elo = elo;
        this.wins = wins;
        this.losses = losses;
        this.isCaptain = isCaptain;
        this.isMvp = isMvp;
    }

    public getDiscordUserId(): string {
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

    public addWin() {
        this.wins += 1;
    }

    public addLoss() {
        this.losses += 1;
    }

    public updateElo(newElo: number) {
        this.elo = newElo;
    }

    public setCaptain(captain: boolean) {
        this.isCaptain = captain;
    }

    public setMvp(mvp: boolean) {
        this.isMvp = mvp;
    }

    public updateDiscordUserName(newName: string) {
        this.discordUserName = newName;
    }
}
