export class GameHistory {
    private date: Date;
    private map: string;
    private minerushing: boolean;
    private bannedClasses: string[];
    private teamColorWinner: string;
    private teamCaptainWinner: string;
    private mvpWinner: string;
    private teamCaptainLoser: string;
    private mvpLoser: string;
    private winnerTeamPlayers: string[];
    private loserTeamPlayers: string[];

    constructor(
        map: string, bannedClasses: string[], minerushing: boolean, teamColorWinner: string, teamCaptainWinner: string,
        mvpWinner: string, teamCaptainLoser: string, mvpLoser: string, winnerTeamPlayers: string[], loserTeamPlayers: string[]
    ) {
        this.date = new Date();
        this.map = map;
        this.bannedClasses = bannedClasses;
        this.minerushing = minerushing;
        this.teamColorWinner = teamColorWinner;
        this.teamCaptainWinner = teamCaptainWinner;
        this.mvpWinner = mvpWinner;
        this.teamCaptainLoser = teamCaptainLoser;
        this.mvpLoser = mvpLoser;
        this.winnerTeamPlayers = winnerTeamPlayers;
        this.loserTeamPlayers = loserTeamPlayers;
    }

    public getDate(): Date {
        return this.date;
    }

    public getMap(): string {
        return this.map;
    }

    public getMinerushing(): boolean {
        return this.minerushing;
    }

    public getBannedClasses(): string[] {
        return this.bannedClasses;
    }

    public getTeamColorWinner(): string {
        return this.teamColorWinner;
    }

    public getTeamCaptainWinner(): string {
        return this.teamCaptainWinner;
    }

    public getMvpWinner(): string {
        return this.mvpWinner;
    }

    public getTeamCaptainLoser(): string {
        return this.teamCaptainLoser;
    }

    public getMvpLoser(): string {
        return this.mvpLoser;
    }

    public getWinnerTeamPlayers(): string[] {
        return this.winnerTeamPlayers;
    }

    public getLoserTeamPlayers(): string[] {
        return this.loserTeamPlayers;
    }
}
