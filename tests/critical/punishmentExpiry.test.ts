import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { prismaClient } from "../../src/database/prismaClient";
import RegisterCommand from "../../src/commands/RegisterCommand";
import PunishedCommand from "../../src/commands/PunishedCommand";
import { createChatInputInteraction, FakeGuild } from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import TeamCommand from "../../src/commands/TeamCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

test("updatePunishmentsForExpiry clears expired entries only", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);

  const punishments = [
    { id: "p1", punishmentExpiry: past },
    { id: "p2", punishmentExpiry: future },
    { id: "p3", punishmentExpiry: null },
  ];

  const updated: string[] = [];
  const origFind = (prismaClient as any).playerPunishment?.findMany;
  const origUpdate = (prismaClient as any).playerPunishment?.update;
  (prismaClient as any).playerPunishment = {
    findMany: async () => punishments,
    update: async ({ where }: any) => {
      updated.push(where.id);
      return {};
    },
  };

  try {
    const count = await PrismaUtils.updatePunishmentsForExpiry();
    assertEqual(count, 1, "Should update exactly one expired punishment");
    assert(
      updated.length === 1 && updated[0] === "p1",
      "Should only update the expired record"
    );
  } finally {
    if (origFind || origUpdate) {
      (prismaClient as any).playerPunishment = {
        findMany: origFind,
        update: origUpdate,
      };
    }
  }
});

test("/register triggers punishment expiry refresh", async () => {
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
  const targetUser = { id: "target", username: "TargetUser" } as any;
  const member = { roles: { cache: { has: () => true } } } as any;
  const interaction = createChatInputInteraction("caller", {
    channelId: "registration",
    guild,
    users: { discorduser: targetUser },
    member,
  });

  try {
    await cmd.execute(interaction as any);
    assert(called, "Expected updatePunishmentsForExpiry to be called");
  } finally {
    PrismaUtils.updatePunishmentsForExpiry = origUpdate;
    (PermissionsUtil as any).isChannel = origIsChannel;
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

  const origFind = (prismaClient as any).playerPunishment?.findMany;
  (prismaClient as any).playerPunishment = {
    findMany: async () => [],
  };

  const interaction = createChatInputInteraction("u1", {});

  try {
    await cmd.execute(interaction as any);
    assert(called, "Expected updatePunishmentsForExpiry to be called");
  } finally {
    PrismaUtils.updatePunishmentsForExpiry = origUpdate;
    if (origFind) {
      (prismaClient as any).playerPunishment = { findMany: origFind };
    }
  }
});
