import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { prismaClient } from "../../src/database/prismaClient";
import RegisterCommand from "../../src/commands/RegisterCommand";
import PunishedCommand from "../../src/commands/PunishedCommand";
import { createChatInputInteraction, FakeGuild, FakeGuildMember } from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import TeamCommand from "../../src/commands/TeamCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

test("updatePunishmentsForExpiry conditionally clears only expired entries in one write", async () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  const punishments = [
    { id: "expired", punishmentExpiry: past, reasons: ["history"] },
    { id: "active", punishmentExpiry: future },
    { id: "cleared", punishmentExpiry: null },
    { id: "missing" },
    { id: "extended", punishmentExpiry: past },
    { id: "boundary", punishmentExpiry: past },
  ];
  const original = (prismaClient as any).playerPunishment;
  let calls = 0;
  (prismaClient as any).playerPunishment = {
    updateMany: async ({ where, data }: any) => {
      calls++;
      const filter = where.punishmentExpiry;
      assertEqual(filter.isSet, true, "Missing expiry must be excluded");
      assertEqual(filter.not, null, "Null expiry must be excluded");
      assert(filter.lte instanceof Date, "Use a timestamp cutoff");
      assertEqual(Object.keys(data).join(","), "punishmentExpiry", "History is untouched");
      // Simulate an extension committed before the conditional write.
      punishments[4].punishmentExpiry = future;
      if (calls === 1) punishments[5].punishmentExpiry = filter.lte;
      let count = 0;
      for (const entry of punishments) {
        if (entry.punishmentExpiry instanceof Date && entry.punishmentExpiry <= filter.lte) {
          entry.punishmentExpiry = data.punishmentExpiry;
          count++;
        }
      }
      return { count };
    },
  };
  try {
    assertEqual(await PrismaUtils.updatePunishmentsForExpiry(), 2, "Expected expiry result");
    assertEqual(await PrismaUtils.updatePunishmentsForExpiry(), 0, "Expected expiry result");
    assertEqual(calls, 2, "Exactly one database call per refresh");
    assertEqual(punishments[0].punishmentExpiry, null, "Expected expiry result");
    assertEqual(punishments[0].reasons?.[0], "history", "Expected expiry result");
    assertEqual(punishments[1].punishmentExpiry, future, "Expected expiry result");
    assertEqual(punishments[3].punishmentExpiry, undefined, "Expected expiry result");
    assertEqual(punishments[4].punishmentExpiry, future, "Expected expiry result");
    assertEqual(punishments[5].punishmentExpiry, null, "Expected expiry result");
  } finally {
    (prismaClient as any).playerPunishment = original;
  }
});

test("expiry refresh retries only rolled-back write conflicts", async () => {
  const original = (prismaClient as any).playerPunishment;
  const conflict = Object.assign(new Error("Write conflict"), { code: "P2034" });
  let calls = 0;
  try {
    (prismaClient as any).playerPunishment = {
      updateMany: async () => {
        if (++calls === 1) throw conflict;
        // The concurrently extended punishment no longer matches.
        return { count: 0 };
      },
    };
    assertEqual(await PrismaUtils.updatePunishmentsForExpiry(), 0, "Retry respects changed expiry");
    assertEqual(calls, 2, "One retry after a write conflict");

    for (const [error, attempts] of [[conflict, 3], [new Error("Database unavailable"), 1]] as const) {
      calls = 0;
      (prismaClient as any).playerPunishment.updateMany = async () => {
        calls++;
        throw error;
      };
      let caught: unknown;
      try {
        await PrismaUtils.updatePunishmentsForExpiry();
      } catch (failure) {
        caught = failure;
      }
      assertEqual(caught, error, "Unrecoverable failures are propagated");
      assertEqual(calls, attempts, "Only known write conflicts have bounded retries");
    }
  } finally {
    (prismaClient as any).playerPunishment = original;
  }
});

test("/register refreshes punishments only after basic eligibility checks", async () => {
  const teamCommand = new TeamCommand();
  const cmd = new RegisterCommand(teamCommand);
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  (game as any).announced = true;

  let called = false;
  const origUpdate = PrismaUtils.updatePunishmentsForExpiry;
  PrismaUtils.updatePunishmentsForExpiry = async () => {
    called = true;
    return 0;
  };
  const origIsChannel = PermissionsUtil.isChannel;
  (PermissionsUtil as any).isChannel = () => true;

  const guild = new FakeGuild() as any;
  const caller = guild.addMember(new FakeGuildMember("caller"));
  const originalLookup = prismaClient.player.byDiscordSnowflake;
  (prismaClient as any).player.byDiscordSnowflake = async () => null;

  try {
    const denied = createChatInputInteraction(caller.id, {
      channelId: "registration",
      guild,
      users: { discorduser: { id: "target", username: "TargetUser" } as any },
    });
    await cmd.execute(denied);
    assert(!called, "Ineligible requests must not refresh punishments");

    const eligible = createChatInputInteraction(caller.id, {
      channelId: "registration",
      guild,
    });
    await cmd.execute(eligible);
    assert(called, "Eligible requests still refresh expired punishments");
  } finally {
    (prismaClient as any).player.byDiscordSnowflake = originalLookup;
    PrismaUtils.updatePunishmentsForExpiry = origUpdate;
    (PermissionsUtil as any).isChannel = origIsChannel;
    game.reset();
  }
});

test("/punished triggers punishment expiry refresh", async () => {
  const cmd = new PunishedCommand();
  let called = false;
  const origUpdate = PrismaUtils.updatePunishmentsForExpiry;
  PrismaUtils.updatePunishmentsForExpiry = async () => {
    called = true;
    return 0;
  };

  const original = (prismaClient as any).playerPunishment;
  let filter: any;
  (prismaClient as any).playerPunishment = {
    findMany: async ({ where }: any) => {
      filter = where.punishmentExpiry;
      return [];
    },
  };

  const interaction = createChatInputInteraction("u1", {});

  try {
    await cmd.execute(interaction as any);
    assert(called, "Expected updatePunishmentsForExpiry to be called");
    assert(filter?.isSet === true && filter.not === null && filter.gt instanceof Date,
      "Active list excludes missing/null and already-expired records independently of cleanup");
  } finally {
    PrismaUtils.updatePunishmentsForExpiry = origUpdate;
    (prismaClient as any).playerPunishment = original;
  }
});
