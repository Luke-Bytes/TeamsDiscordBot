import fs from "fs";
import path from "path";
import { GameInstance } from "../database/GameInstance";
import { AnniClass } from "@prisma/client";
import { getRandomAnniClass } from "../util/Utils";

interface Modifier {
  name: string;
  weight: number;
}
interface Category {
  name: string;
  maxPerRun: number;
  modifiers: Modifier[];
}
interface Config {
  categories: Category[];
}

export class ModifierSelector {
  private categories: Category[];

  constructor(
    configPath = path.resolve(process.cwd(), "modifiers-config.json")
  ) {
    const raw = fs.readFileSync(configPath, "utf-8");
    this.categories = (JSON.parse(raw) as Config).categories;
  }

  public select(): { category: string; name: string }[] {
    const results: { category: string; name: string }[] = [];
    for (const cat of this.categories) {
      const pool = [...cat.modifiers];
      const defaultName = cat.modifiers[0].name;
      for (let i = 0; i < cat.maxPerRun && pool.length; i++) {
        const total = pool.reduce((sum, m) => sum + m.weight, 0);
        let r = Math.random() * total;
        let idx = 0;
        for (; idx < pool.length; idx++) {
          r -= pool[idx].weight;
          if (r <= 0) break;
        }
        const pick = pool.splice(idx, 1)[0];
        if (pick.name !== defaultName) {
          results.push({ category: cat.name, name: pick.name });
        }
      }
    }
    return results;
  }

  public static runSelection(): void {
    const selector = new ModifierSelector();
    const mods = selector.select();

    GameInstance.getInstance().settings.modifiers = mods;

    for (const { category, name } of mods) {
      if (category === "Class Bans") {
        this.handleClassBans(name);
      }
    }
  }

  private static handleClassBans(name: string) {
    const game = GameInstance.getInstance();
    const banned = game.settings.bannedClasses;

    switch (name) {
      case "No Bans":
        game.setClassBanLimit(0);
        break;

      case "1 Random Ban":
        game.setClassBanLimit(0);
        {
          let cls: AnniClass;
          do {
            cls = getRandomAnniClass();
          } while (banned.includes(cls));
          banned.push(cls);
        }
        break;

      case "2 Random Bans":
        game.setClassBanLimit(0);
        for (let i = 0; i < 2; i++) {
          let cls: AnniClass;
          do {
            cls = getRandomAnniClass();
          } while (banned.includes(cls));
          banned.push(cls);
        }
        break;

      case "All Movement Classes Banned":
        game.setClassBanLimit(0);
        [
          AnniClass.ACROBAT,
          AnniClass.DASHER,
          AnniClass.NEPTUNE,
          AnniClass.SCOUT,
          AnniClass.ROBINHOOD,
          AnniClass.TRANSPORTER,
        ].forEach((c) => {
          if (!banned.includes(c)) banned.push(c);
        });
        break;

      case "All Combat Classes Banned":
        game.setClassBanLimit(0);
        [
          AnniClass.ALCHEMIST,
          AnniClass.BERSERKER,
          AnniClass.BLOODMAGE,
          AnniClass.LUMBERJACK,
          AnniClass.MERCENARY,
          AnniClass.WARRIOR,
        ].forEach((c) => {
          if (!banned.includes(c)) banned.push(c);
        });
        break;

      case "2 Captain Bans":
        game.setClassBanLimit(2);
        break;

      case "4 Captain Bans":
        game.setClassBanLimit(4);
        break;
    }
  }
}
