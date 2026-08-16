import fs from "fs";
import path from "path";
import { GameInstance } from "../database/GameInstance";
import { AnniClass } from "@prisma/client";
import { getRandomAnniClass } from "../util/Utils";

export interface ModifierOption {
  name: string;
  weight: number;
}
export interface ModifierCategory {
  name: string;
  maxPerRun: number;
  modifiers: ModifierOption[];
}
interface Config {
  categories: ModifierCategory[];
}

export interface SelectedModifier {
  category: string;
  name: string;
}

export class ModifierSelector {
  private readonly categories: ModifierCategory[];

  constructor(
    configPath = path.resolve(process.cwd(), "modifiers-config.json")
  ) {
    const raw = fs.readFileSync(configPath, "utf-8");
    this.categories = (JSON.parse(raw) as Config).categories;
  }

  public getCategories(): ModifierCategory[] {
    return this.categories.map((category) => ({
      ...category,
      modifiers: category.modifiers.map((modifier) => ({ ...modifier })),
    }));
  }

  public getDefaultChoices(): Record<string, string> {
    return Object.fromEntries(
      this.categories.map((category) => [
        category.name,
        category.modifiers[0].name,
      ])
    );
  }

  public selectionsFromChoices(
    choices: Record<string, string>
  ): SelectedModifier[] {
    return this.categories.flatMap((category) => {
      const selectedName = choices[category.name] ?? category.modifiers[0].name;
      const selected = category.modifiers.find(
        (modifier) => modifier.name === selectedName
      );
      if (!selected) {
        throw new Error(
          `Unknown modifier '${selectedName}' for category '${category.name}'.`
        );
      }

      return selected.name === category.modifiers[0].name
        ? []
        : [{ category: category.name, name: selected.name }];
    });
  }

  public select(): SelectedModifier[] {
    const results: SelectedModifier[] = [];
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
    this.applySelection(selector.select());
  }

  public static applySelection(mods: SelectedModifier[]): void {
    const selectedModifiers = mods.map((modifier) => ({ ...modifier }));

    const game = GameInstance.getInstance();
    game.settings.modifiers = selectedModifiers;
    game.settings.sharedCaptainBannedClasses = [];
    game.settings.nonSharedCaptainBannedClasses = { RED: [], BLUE: [] };

    const classBanMod = selectedModifiers.find(
      (m) => m.category === "Class Bans"
    );
    const swapperMod = selectedModifiers.find((m) => m.category === "Swapper");
    const transporterMod = selectedModifiers.find(
      (m) => m.category === "TP Enabled - Skying Banned"
    );
    const pickOtherTeamsRolesMod = selectedModifiers.find(
      (m) => m.category === "Captain's Pick Other Team's Support Roles"
    );

    if (classBanMod) {
      this.handleClassBans(classBanMod.name);
    } else {
      this.handleClassBans("No Bans");
    }

    this.clearProtectedClassBans(game, [
      ...(swapperMod ? [AnniClass.SWAPPER] : []),
      ...(transporterMod ? [AnniClass.TRANSPORTER] : []),
    ]);

    game.pickOtherTeamsSupportRoles = pickOtherTeamsRolesMod?.name === "Yes";
  }

  private static clearProtectedClassBans(
    game: GameInstance,
    protectedClasses: AnniClass[]
  ): void {
    if (protectedClasses.length === 0) return;

    game.settings.organiserBannedClasses =
      game.settings.organiserBannedClasses.filter(
        (c) => !protectedClasses.includes(c)
      );
    game.settings.sharedCaptainBannedClasses =
      game.settings.sharedCaptainBannedClasses.filter(
        (c) => !protectedClasses.includes(c)
      );

    const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
      RED: [],
      BLUE: [],
    };
    game.settings.nonSharedCaptainBannedClasses = {
      RED: byTeam.RED.filter((c) => !protectedClasses.includes(c)),
      BLUE: byTeam.BLUE.filter((c) => !protectedClasses.includes(c)),
    };
  }

  private static handleClassBans(name: string) {
    const game = GameInstance.getInstance();
    game.classBanMode = null;
    game.settings.delayedBan = 0;
    const organiserBans = game.settings.organiserBannedClasses;

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
          } while (organiserBans.includes(cls));
          organiserBans.push(cls);
        }
        break;

      case "2 Random Bans":
        game.setClassBanLimit(0);
        for (let i = 0; i < 2; i++) {
          let cls: AnniClass;
          do {
            cls = getRandomAnniClass();
          } while (organiserBans.includes(cls));
          organiserBans.push(cls);
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
          if (!organiserBans.includes(c)) organiserBans.push(c);
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
          AnniClass.SUCCUBUS,
        ].forEach((c) => {
          if (!organiserBans.includes(c)) organiserBans.push(c);
        });
        break;

      case "1 Captain Ban Each (Shared)":
        game.classBanMode = "shared";
        game.setClassBanLimit(2);
        break;

      case "2 Captain Bans Each (Shared)":
        game.classBanMode = "shared";
        game.setClassBanLimit(4);
        break;

      case "1 Captain Ban Each (Opponent Only, No Core)":
        game.classBanMode = "opponentOnly";
        game.setClassBanLimit(2);
        break;

      case "2 Captain Bans Each (Opponent Only, No Core)":
        game.classBanMode = "opponentOnly";
        game.setClassBanLimit(4);
        break;

      case "Delayed Ban (Phase 2)":
        game.classBanMode = "shared";
        game.settings.delayedBan = 2;
        game.setClassBanLimit(2);
        break;

      case "Delayed Ban (Phase 3)":
        game.classBanMode = "shared";
        game.settings.delayedBan = 3;
        game.setClassBanLimit(2);
        break;

      case "Delayed Ban (Phase 4)":
        game.classBanMode = "shared";
        game.settings.delayedBan = 4;
        game.setClassBanLimit(2);
        break;

      default:
        game.setClassBanLimit(0);
        break;
    }
  }
}
