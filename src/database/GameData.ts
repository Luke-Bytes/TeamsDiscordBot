export class GameData {
    private static _players: string[] = [];
    private static _bluePlayers: string[] = [];
    private static _redPlayers: string[] = [];
    private static _mapVotes: string[] = [];
    private static _mvpVotes: string[] = [];
    private static _minerushingVotes: string[] = [];
    private static _bannedClassesVotes: string[] = [];
    private static _gameWinner: 'blue' | 'red' | null = null;
    private static _startTime: Date = new Date();

    static setDefaultValues() {
        // this._players = [];
        this._players = Array.from({ length: 10 }, (_, i) => `Player${i + 1}`);
        this._bluePlayers = [];
        this._redPlayers = [];
        this._mapVotes = [];
        this._mvpVotes = [];
        this._minerushingVotes = [];
        this._bannedClassesVotes = [];
        this._gameWinner = null;
        this._startTime = new Date();
    }

    // Static getters to access globally stored values
    public static getPlayers(): string[] {
        return this._players;
    }

    public static getBluePlayers(): string[] {
        return this._bluePlayers;
    }

    public static getRedPlayers(): string[] {
        return this._redPlayers;
    }

    public static getMapVotes(): string[] {
        return this._mapVotes;
    }

    public static getMvpVotes(): string[] {
        return this._mvpVotes;
    }

    public static getMinerushingVotes(): string[] {
        return this._minerushingVotes;
    }

    public static getBannedClassesVotes(): string[] {
        return this._bannedClassesVotes;
    }

    public static getGameWinner(): 'blue' | 'red' | null {
        return this._gameWinner;
    }

    // Static methods to modify the globally stored data
    public static addPlayer(player: string) {
        this._players.push(player);
    }

    public static addMapVote(vote: string) {
        this._mapVotes.push(vote);
    }

    public static addMvpVote(vote: string) {
        this._mvpVotes.push(vote);
    }

    public static addMinerushingVote(vote: string) {
        this._minerushingVotes.push(vote);
    }

    public static addBannedClassesVote(vote: string) {
        this._bannedClassesVotes.push(vote);
    }

    public static setGameWinner(winner: 'blue' | 'red') {
        this._gameWinner = winner;
    }

    public static getStartTime(): Date {
        return this._startTime;
    }

    // Reset all votes globally
    public static resetVotes() {
        this.setDefaultValues();
    }

    // Static setters for blue and red players
    public static setBluePlayers(players: string[]): void {
        this._bluePlayers = players;
    }

    public static setRedPlayers(players: string[]): void {
        this._redPlayers = players;
    }
}
