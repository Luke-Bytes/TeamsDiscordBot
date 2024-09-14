export class GameData {
    private _players: string[] = [];
    private _bluePlayers: string[] = [];
    private _redPlayers: string[] = [];
    private _mapVotes: string[] = [];
    private _mvpVotes: string[] = [];
    private _minerushingVotes: string[] = [];
    private _bannedClassesVotes: string[] = [];

    constructor() {
        this.setDefaultValues();
    }

    private setDefaultValues() {
        this._players = Array.from({ length: 10 }, (_, i) => `Player${i + 1}`);
        // this._players = []; 
        this._bluePlayers = [];
        this._redPlayers = [];
        this._mapVotes = [];
        this._mvpVotes = [];
        this._minerushingVotes = [];
        this._bannedClassesVotes = [];
    }

    public getPlayers(): string[] {
        return this._players;
    }

    public getBluePlayers(): string[] {
        return this._bluePlayers;
    }

    public getRedPlayers(): string[] {
        return this._redPlayers;
    }

    public getMapVotes(): string[] {
        return this._mapVotes;
    }

    public getMvpVotes(): string[] {
        return this._mvpVotes;
    }

    public getMinerushingVotes(): string[] {
        return this._minerushingVotes;
    }

    public getBannedClassesVotes(): string[] {
        return this._bannedClassesVotes;
    }

    public addPlayers(player: string) {
        this._players.push(player);
    }

    public addMapVote(vote: string) {
        this._mapVotes.push(vote);
    }

    public addMvpVote(vote: string) {
        this._mvpVotes.push(vote);
    }

    public addMinerushingVote(vote: string) {
        this._minerushingVotes.push(vote);
    }

    public addBannedClassesVote(vote: string) {
        this._bannedClassesVotes.push(vote);
    }

    public resetVotes() {
        this.setDefaultValues();
    }

    public set bluePlayers(players: string[]) {
        this._bluePlayers = players;
    }

    public set redPlayers(players: string[]) {
        this._redPlayers = players;
    }
}
