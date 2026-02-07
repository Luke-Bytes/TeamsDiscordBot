import fs from "fs";
import path from "path";
import { TitleDefinition, formatTitleReason } from "./ProfileUtil";

export type TitleDefinitionWithReason = TitleDefinition & {
  reasonText: string;
};

export class TitleStore {
  private static cache: TitleDefinition[] | null = null;
  private static overrideTitles: TitleDefinition[] | null = null;

  public static loadTitles(): TitleDefinition[] {
    if (this.overrideTitles) return this.overrideTitles;
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(
        path.resolve(process.cwd(), "titles.json"),
        "utf8"
      );
      const parsed = JSON.parse(raw) as TitleDefinition[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  public static clearCache(): void {
    this.cache = null;
  }

  public static setOverride(titles: TitleDefinition[] | null): void {
    this.overrideTitles = titles;
  }

  public static clearOverride(): void {
    this.overrideTitles = null;
  }

  public static getTitlesWithReasons(): TitleDefinitionWithReason[] {
    return this.loadTitles().map((title) => ({
      ...title,
      reasonText: formatTitleReason(title),
    }));
  }
}
