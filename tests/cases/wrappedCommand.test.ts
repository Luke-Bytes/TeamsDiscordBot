import WrappedCommand from "../../src/commands/WrappedCommand";
import { prismaClient } from "../../src/database/prismaClient";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { assert } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";
import { test } from "../framework/test";

test("WrappedCommand defaults to the previous completed season", async () => {
  const originalFindPlayer = PrismaUtils.findPlayer;
  const originalSeason = (prismaClient as any).season;
  const seenSeasonNumbers: number[] = [];

  (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
  (prismaClient as any).season = {
    findFirst: async () => ({ id: "S7", number: 7, isActive: true }),
    findUnique: async ({ where }: any) => {
      seenSeasonNumbers.push(where.number);
      return null;
    },
  };

  try {
    const interaction = createChatInputInteraction("U1");
    await new WrappedCommand().execute(interaction);

    assert(seenSeasonNumbers[0] === 6, "Defaults to active season minus one");
    const reply = interaction.replies.find((r) => r.type === "editReply");
    assert(
      reply?.payload === "Season #6 not found.",
      "Reports the default completed season"
    );
  } finally {
    (PrismaUtils as any).findPlayer = originalFindPlayer;
    (prismaClient as any).season = originalSeason;
  }
});

test("WrappedCommand rejects the active season", async () => {
  const originalFindPlayer = PrismaUtils.findPlayer;
  const originalSeason = (prismaClient as any).season;
  let lookedUpSeason = false;

  (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
  (prismaClient as any).season = {
    findFirst: async () => ({ id: "S7", number: 7, isActive: true }),
    findUnique: async () => {
      lookedUpSeason = true;
      return null;
    },
  };

  try {
    const interaction = createChatInputInteraction("U1", {
      integers: { season: 7 },
    });
    await new WrappedCommand().execute(interaction);

    assert(!lookedUpSeason, "Does not load recap data for active season");
    const reply = interaction.replies.find((r) => r.type === "editReply");
    assert(
      reply?.payload ===
        "Season 7 is still active. Wrapped is only available for completed seasons.",
      "Explains that wrapped only supports completed seasons"
    );
  } finally {
    (PrismaUtils as any).findPlayer = originalFindPlayer;
    (prismaClient as any).season = originalSeason;
  }
});
