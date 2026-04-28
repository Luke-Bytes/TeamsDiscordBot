import { Season } from "@prisma/client";
import { prismaClient } from "./prismaClient";

export class SeasonService {
  static async getActiveSeason(): Promise<Season | null> {
    return prismaClient.season.findFirst({
      where: { isActive: true },
      orderBy: { number: "desc" },
    });
  }

  static async requireActiveSeason(): Promise<Season> {
    const season = await this.getActiveSeason();
    if (!season) {
      throw new Error(
        "No active season found. Please activate a season first."
      );
    }
    return season;
  }

  static async getActiveSeasonNumber(): Promise<number> {
    return (await this.requireActiveSeason()).number;
  }
}
