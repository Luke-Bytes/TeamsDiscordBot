import { Player } from "@prisma/client";
import * as fs from "fs";

//export class Elo {
//  private discordUserId: string;
//  private won: boolean;
//  private mvp: boolean;
//  private config: any;
//
//  constructor(discordUserId: string, won: boolean, mvp: boolean) {
//    this.discordUserId = discordUserId;
//    this.won = won;
//    this.mvp = mvp;
//
//    const configData = fs.readFileSync("./config.json", "utf-8");
//    this.config = JSON.parse(configData);
//  }
//
//  public calculateNewElo(player: Player): number {
//    let currentElo = player.getElo();
//    if (this.won) {
//      currentElo += this.config.winEloGain;
//    } else {
//      currentElo -= this.config.loseEloLoss;
//    }
//
//    if (this.mvp) {
//      currentElo += this.config.mvpBonus;
//    }
//
//    return currentElo;
//  }
//
//  public applyEloUpdate(player: PlayerData): void {
//    const newElo = this.calculateNewElo(player);
//    player.updateElo(newElo);
//  }
//}
