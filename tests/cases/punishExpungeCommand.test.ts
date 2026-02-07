import { test } from "../framework/test";
import { assert } from "../framework/assert";
import PunishCommand from "../../src/commands/PunishCommand";
import { createChatInputInteraction } from "../framework/mocks";
import { prismaClient } from "../../src/database/prismaClient";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { MessageFlags } from "discord.js";

function makeOrganiserInteraction(userId: string) {
  const i = createChatInputInteraction(userId, {
    subcommand: "expunge",
    strings: { player: "Target" },
  }) as any;
  i.inGuild = () => true;
  i.guild = { members: { cache: new Map([[userId, { id: userId }]]) } } as any;
  return i;
}

test("/punish expunge shows select menu for existing punishments", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origPerm = PermissionsUtil.hasRole;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => ({
      id: "pp1",
      playerId: "P1",
      reasons: ["Late", "AFK"],
      punishmentDates: [new Date("2024-01-01"), new Date("2024-01-02")],
      punishmentExpiry: null,
    });

    const i = makeOrganiserInteraction("ORG");
    await cmd.execute(i);

    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(!!reply, "Should edit reply with select menu");
    const components = reply.payload?.components ?? [];
    assert(components.length === 1, "Should include one select menu row");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("/punish expunge removes selected entry", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origUpdate = (prismaClient as any).playerPunishment.update;
  const origPerm = PermissionsUtil.hasRole;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => ({
      id: "pp1",
      playerId: "P1",
      reasons: ["Late", "AFK"],
      punishmentDates: [new Date("2024-01-01"), new Date("2024-01-02")],
      punishmentExpiry: new Date("2024-02-01"),
    });
    let updated: any = null;
    (prismaClient as any).playerPunishment.update = async (args: any) => {
      updated = args;
      return {};
    };

    const i = makeOrganiserInteraction("ORG");
    await cmd.execute(i);

    const selectInteraction: any = {
      customId: "punish-expunge-select",
      user: { id: "ORG" },
      values: ["idx:0"],
      update: async (payload: any) => {
        selectInteraction.payload = payload;
      },
      reply: async (_payload: any) => {},
    };

    await cmd.handleSelectMenu!(selectInteraction);

    assert(!!updated, "Should update punishment record");
    assert(
      updated.data.reasons.length === 1 && updated.data.reasons[0] === "AFK",
      "Should remove selected reason"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (prismaClient as any).playerPunishment.update = origUpdate;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

// Sad paths

test("/punish expunge rejects non-organiser", async () => {
  const cmd = new PunishCommand();
  const origPerm = PermissionsUtil.hasRole;
  try {
    (PermissionsUtil as any).hasRole = () => false;
    const i = makeOrganiserInteraction("U1");
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(
      String(reply?.payload || "").includes("permission"),
      "Should deny permission"
    );
  } finally {
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("/punish expunge reports when no punishment history", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origPerm = PermissionsUtil.hasRole;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => null;

    const i = makeOrganiserInteraction("ORG");
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(
      String(reply?.payload || "").includes("No punishment history"),
      "Should report no history"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("/punish expunge selection invalid session", async () => {
  const cmd = new PunishCommand();
  const interaction: any = {
    customId: "punish-expunge-select",
    user: { id: "U1" },
    values: ["idx:0"],
    reply: async (payload: any) => {
      interaction.payload = payload;
    },
  };
  await cmd.handleSelectMenu!(interaction);
  assert(
    interaction.payload?.flags === MessageFlags.Ephemeral,
    "Should reply ephemerally"
  );
});

// Edge cases

test("/punish expunge cancel leaves record unchanged", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origUpdate = (prismaClient as any).playerPunishment.update;
  const origPerm = PermissionsUtil.hasRole;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => ({
      id: "pp1",
      playerId: "P1",
      reasons: ["Late"],
      punishmentDates: [new Date("2024-01-01")],
      punishmentExpiry: null,
    });
    let updated = false;
    (prismaClient as any).playerPunishment.update = async () => {
      updated = true;
      return {};
    };

    const i = makeOrganiserInteraction("ORG");
    await cmd.execute(i);

    const selectInteraction: any = {
      customId: "punish-expunge-select",
      user: { id: "ORG" },
      values: ["cancel"],
      update: async (payload: any) => {
        selectInteraction.payload = payload;
      },
    };

    await cmd.handleSelectMenu!(selectInteraction);
    assert(!updated, "Should not update record on cancel");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (prismaClient as any).playerPunishment.update = origUpdate;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("/punish expunge removes latest clears expiry", async () => {
  const cmd = new PunishCommand();
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origUpdate = (prismaClient as any).playerPunishment.update;

  (prismaClient as any).playerPunishment.findFirst = async () => ({
    id: "pp1",
    playerId: "P1",
    reasons: ["Late", "AFK"],
    punishmentDates: [new Date("2024-01-01"), new Date("2024-01-02")],
    punishmentExpiry: new Date("2024-02-01"),
  });
  let updated: any = null;
  (prismaClient as any).playerPunishment.update = async (args: any) => {
    updated = args;
    return {};
  };

  const interaction: any = {
    customId: "punish-expunge-select",
    user: { id: "ORG" },
    values: ["idx:1"],
    update: async (_payload: any) => {},
    reply: async (_payload: any) => {},
  };

  (cmd as any).expungeSessions.set("ORG", {
    playerId: "P1",
    userId: "ORG",
    createdAt: Date.now(),
  });

  await cmd.handleSelectMenu!(interaction);

  assert(!!updated, "Should update punishment record");
  assert(updated.data.punishmentExpiry === null, "Should clear expiry");

  (prismaClient as any).playerPunishment.findFirst = origFindPun;
  (prismaClient as any).playerPunishment.update = origUpdate;
});

test("/punish expunge removes last entry deletes record", async () => {
  const cmd = new PunishCommand();
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origDelete = (prismaClient as any).playerPunishment.delete;

  (prismaClient as any).playerPunishment.findFirst = async () => ({
    id: "pp1",
    playerId: "P1",
    reasons: ["Late"],
    punishmentDates: [new Date("2024-01-01")],
    punishmentExpiry: null,
  });
  let deleted = false;
  (prismaClient as any).playerPunishment.delete = async () => {
    deleted = true;
    return {};
  };

  const interaction: any = {
    customId: "punish-expunge-select",
    user: { id: "ORG" },
    values: ["idx:0"],
    update: async (_payload: any) => {},
    reply: async (_payload: any) => {},
  };

  (cmd as any).expungeSessions.set("ORG", {
    playerId: "P1",
    userId: "ORG",
    createdAt: Date.now(),
  });

  await cmd.handleSelectMenu!(interaction);

  assert(deleted, "Should delete record when last entry removed");

  (prismaClient as any).playerPunishment.findFirst = origFindPun;
  (prismaClient as any).playerPunishment.delete = origDelete;
});
