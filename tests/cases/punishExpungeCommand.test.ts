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
  i.guildId = "guild";
  i.editReply = async (payload: any) => {
    i.replies.push({ type: "editReply", payload });
    return { id: "expunge-msg" };
  };
  return i;
}

function makePunishAddInteraction(duration: string) {
  const i = createChatInputInteraction("ORG", {
    subcommand: "add",
    strings: { player: "Target", reason: "Late", duration },
  }) as any;
  i.guild = {
    members: { cache: new Map([["ORG", { id: "ORG" }]]) },
  } as any;
  return i;
}

test("/punish add reports unsupported durations without writing", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origPerm = PermissionsUtil.hasRole;
  let punishmentLookupCalled = false;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => {
      punishmentLookupCalled = true;
      return null;
    };

    const i = makePunishAddInteraction("1w");
    await cmd.execute(i);

    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(
      String(reply?.payload || "").includes("Invalid duration"),
      "Should explain the invalid duration to the user"
    );
    assert(
      String(reply?.payload || "").includes("7d"),
      "Should explain how to express a week in days"
    );
    assert(
      !punishmentLookupCalled,
      "Should stop before reading or writing punishment records"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("/punish add accepts a strict day duration", async () => {
  const cmd = new PunishCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origCreate = (prismaClient as any).playerPunishment.create;
  const origPerm = PermissionsUtil.hasRole;
  let created: any;

  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    (prismaClient as any).playerPunishment.findFirst = async () => null;
    (prismaClient as any).playerPunishment.create = async (args: any) => {
      created = args;
      return args.data;
    };

    const before = Date.now();
    const i = makePunishAddInteraction("7d");
    await cmd.execute(i);

    assert(!!created, "Should create a punishment for a valid duration");
    const expiry = created.data.punishmentExpiry.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    assert(
      expiry >= before + sevenDays && expiry <= Date.now() + sevenDays,
      "Should set the punishment expiry seven days ahead"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).playerPunishment.findFirst = origFindPun;
    (prismaClient as any).playerPunishment.create = origCreate;
    (PermissionsUtil as any).hasRole = origPerm;
  }
});

test("concurrent first punishment additions preserve both history entries", async () => {
  const originalRole = PermissionsUtil.hasRole;
  const originalFind = PrismaUtils.findPlayer;
  const db = prismaClient.playerPunishment as any;
  const original = { findFirst: db.findFirst, create: db.create, update: db.update };
  let row: any = null;
  let creates = 0;
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (PrismaUtils as any).findPlayer = async () => ({ id: "P1" });
    db.findFirst = async () => row;
    db.create = async ({data}: any) => {
      creates++;
      await new Promise<void>(resolve => setImmediate(resolve));
      row = {id: "pp1", ...data};
      return row;
    };
    db.update = async ({data}: any) => {
      assert(data.strikeCount.increment === 1, "atomic strike increment");
      row.reasons.push(data.reasons.push);
      row.punishmentDates.push(data.punishmentDates.push);
      row.strikeCount += data.strikeCount.increment;
      row.punishmentExpiry = data.punishmentExpiry;
      return row;
    };
    await Promise.all([
      new PunishCommand().execute(makePunishAddInteraction("1d")),
      new PunishCommand().execute(makePunishAddInteraction("2d")),
    ]);
    assert(creates === 1 && row.strikeCount === 2, "one record with two strikes");
    assert(row.reasons.length === 2 && row.punishmentDates.length === 2, "both history entries preserved");
  } finally {
    PermissionsUtil.hasRole = originalRole;
    PrismaUtils.findPlayer = originalFind;
    Object.assign(db, original);
  }
});

test("expunge rejects stale menu and conditional write conflict", async () => {
  const cmd = new PunishCommand();
  const originalRole = PermissionsUtil.hasRole;
  const db = prismaClient.playerPunishment as any;
  const original = { findFirst: db.findFirst, update: db.update };
  const dates = [new Date(100), new Date(200)];
  const row = { id: "pp1", reasons: ["Late", "AFK"], punishmentDates: dates, strikeCount: 2, punishmentExpiry: null };
  let writes = 0;
  let response = "";
  const interaction: any = {
    customId: "punish-expunge-select", user: { id: "ORG" }, member: {},
    guildId: "guild", message: { id: "expunge-msg" }, values: ["idx:0"],
    reply: async (payload: any) => { response = payload.content; },
  };
  const open = (reasons: string[]) => (cmd as any).expungeSessions.set("ORG", {
    playerId: "P1", userId: "ORG", createdAt: Date.now(), messageId: "expunge-msg",
    recordId: "pp1", reasons, punishmentDates: dates,
  });
  try {
    (PermissionsUtil as any).hasRole = () => true;
    db.findFirst = async () => row;
    db.update = async ({where}: any) => {
      writes++;
      assert(where.reasons.equals.length === 2 && where.strikeCount === 2, "history CAS");
      assert(where.OR.some((part: any) => part.punishmentExpiry?.isSet === false), "legacy missing expiry supported");
      throw Object.assign(new Error("concurrent extension"), {code: "P2025"});
    };
    open(["Different", "AFK"]);
    await cmd.handleSelectMenu(interaction);
    assert(writes === 0 && response.includes("history changed"), "stale selection rejected");
    open(["Late", "AFK"]);
    await cmd.handleSelectMenu(interaction);
    assert(writes === 1 && response.includes("expiry changed"), "concurrent write conflict rejected");
  } finally {
    PermissionsUtil.hasRole = originalRole;
    Object.assign(db, original);
  }
});

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
      member: {}, guildId: "guild", message: { id: "expunge-msg" },
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
      member: {}, guildId: "guild", message: { id: "expunge-msg" },
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
  const origRole = PermissionsUtil.hasRole;
  (PermissionsUtil as any).hasRole = () => true;

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
    member: {}, guildId: "guild", message: { id: "expunge-msg" },
    values: ["idx:1"],
    update: async (_payload: any) => {},
    reply: async (_payload: any) => {},
  };

  (cmd as any).expungeSessions.set("ORG", {
    playerId: "P1",
    userId: "ORG",
    createdAt: Date.now(),
    messageId: "expunge-msg",
    recordId: "pp1",
    reasons: ["Late", "AFK"],
    punishmentDates: [new Date("2024-01-01"), new Date("2024-01-02")],
  });

  await cmd.handleSelectMenu!(interaction);

  assert(!!updated, "Should update punishment record");
  assert(updated.data.punishmentExpiry === null, "Should clear expiry");

  (PermissionsUtil as any).hasRole = origRole;
  (prismaClient as any).playerPunishment.findFirst = origFindPun;
  (prismaClient as any).playerPunishment.update = origUpdate;
});

test("/punish expunge removes last entry deletes record", async () => {
  const cmd = new PunishCommand();
  const origFindPun = (prismaClient as any).playerPunishment.findFirst;
  const origDelete = (prismaClient as any).playerPunishment.delete;
  const origRole = PermissionsUtil.hasRole;
  (PermissionsUtil as any).hasRole = () => true;

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
    member: {}, guildId: "guild", message: { id: "expunge-msg" },
    values: ["idx:0"],
    update: async (_payload: any) => {},
    reply: async (_payload: any) => {},
  };

  (cmd as any).expungeSessions.set("ORG", {
    playerId: "P1",
    userId: "ORG",
    createdAt: Date.now(),
    messageId: "expunge-msg",
    recordId: "pp1",
    reasons: ["Late"],
    punishmentDates: [new Date("2024-01-01")],
  });

  await cmd.handleSelectMenu!(interaction);

  assert(deleted, "Should delete record when last entry removed");

  (PermissionsUtil as any).hasRole = origRole;
  (prismaClient as any).playerPunishment.findFirst = origFindPun;
  (prismaClient as any).playerPunishment.delete = origDelete;
});
