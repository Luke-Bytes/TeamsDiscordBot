import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";
import UsernameCommand from "../../src/commands/UsernameCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { MojangAPI } from "../../src/api/MojangAPI";
import { prismaClient } from "../../src/database/prismaClient";

function identityFixture() {
  const db = prismaClient as any;
  const player = db.player;
  const prior = {
    auth: PermissionsUtil.isUserAuthorised,
    lookup: MojangAPI.lookupUsername,
    transaction: db.$transaction,
    eventUpdateMany: db.eventSignup.updateMany,
    eventFindMany: db.standaloneEvent.findMany,
    findFirst: player.findFirst,
    findMany: player.findMany,
    updateMany: player.updateMany,
  };
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (MojangAPI as any).lookupUsername = async (name: string) => ({
    status: "found",
    uuid: name === "OldName" ? "old-uuid" : "new-uuid",
  });
  let primary = "old-uuid";
  let username = "OldName";
  let updates = 0;
  let eventUpdates = 0;
  db.$transaction = async (fn: any) => fn(db);
  db.standaloneEvent.findMany = async () => [{ id: "active-event" }];
  db.eventSignup.updateMany = async () => {
    eventUpdates++;
    return { count: 0 };
  };
  player.findFirst = async ({ where }: any) =>
    where.primaryMinecraftAccount === primary && primary === "old-uuid"
      ? {
          id: "owner-1",
          discordSnowflake: "owner-discord",
          primaryMinecraftAccount: primary,
          latestIGN: username,
        }
      : null;
  player.findMany = async () => [];
  player.updateMany = async ({ where, data }: any) => {
    if (
      where.id !== "owner-1" ||
      where.primaryMinecraftAccount !== primary ||
      where.latestIGN !== username
    ) {
      return { count: 0 };
    }
    primary = data.primaryMinecraftAccount;
    username = data.latestIGN;
    updates++;
    return { count: 1 };
  };
  const interaction = () =>
    createChatInputInteraction("organiser", {
      subcommand: "update",
      strings: { oldusername: "OldName", newusername: "NewName" },
    });
  return {
    player,
    interaction,
    updates: () => updates,
    eventUpdates: () => eventUpdates,
    primary: () => primary,
    restore() {
      (PermissionsUtil as any).isUserAuthorised = prior.auth;
      (MojangAPI as any).lookupUsername = prior.lookup;
      player.findFirst = prior.findFirst;
      player.findMany = prior.findMany;
      player.updateMany = prior.updateMany;
      db.eventSignup.updateMany = prior.eventUpdateMany;
      db.standaloneEvent.findMany = prior.eventFindMany;
      db.$transaction = prior.transaction;
    },
  };
}

test("username update refuses UUID already linked as secondary and never mutates", async () => {
  const f = identityFixture();
  try {
    f.player.findMany = async () => [{ id: "other-player" }];
    const interaction = f.interaction();
    await new UsernameCommand().execute(interaction);
    assert(
      f.updates() === 0 && f.primary() === "old-uuid",
      "Linked UUID must not be transferred"
    );
    assert(
      interaction.replies.some((r: any) =>
        String(r.payload).includes("already associated")
      ),
      "Organiser receives explicit identity-ownership rejection"
    );
  } finally {
    f.restore();
  }
});

test("username update synchronises active event signups and supports a name-only change", async () => {
  const f = identityFixture();
  const oldFindMany = f.player.findMany;
  const originalLookup = MojangAPI.lookupUsername;
  try {
    let checksOwnIdentity = false;
    f.player.findMany = async ({ where }: any) => {
      checksOwnIdentity = where.NOT?.id === "owner-1";
      return [];
    };
    (MojangAPI as any).lookupUsername = async () => ({
      status: "found",
      uuid: "old-uuid",
    });
    const interaction = f.interaction();
    await new UsernameCommand().execute(interaction);
    assert(checksOwnIdentity, "ownership checks exclude the same player");
    assert(
      f.updates() === 1 && f.eventUpdates() === 1,
      "renaming the same UUID updates the player and live applications"
    );
  } finally {
    f.player.findMany = oldFindMany;
    (MojangAPI as any).lookupUsername = originalLookup;
    f.restore();
  }
});

test("identity lookup outage never reaches conditional identity mutation", async () => {
  const f = identityFixture();
  try {
    (MojangAPI as any).lookupUsername = async (name: string) =>
      name === "OldName"
        ? { status: "found", uuid: "old-uuid" }
        : { status: "unavailable" };
    const interaction = f.interaction();
    await new UsernameCommand().execute(interaction);
    assert(
      f.updates() === 0 && f.primary() === "old-uuid",
      "Unavailable Minecraft service may not authorize an identity change"
    );
    assert(
      interaction.replies.some((r: any) =>
        String(r.payload).includes("unavailable")
      ),
      "Unavailable outcome must be explicit"
    );
  } finally {
    f.restore();
  }
});

test("concurrent username updates for the same owner use conditional compare-and-swap", async () => {
  const f = identityFixture();
  try {
    let checks = 0;
    let allowBoth!: () => void;
    const bothHere = new Promise<void>((resolve) => {
      allowBoth = resolve;
    });
    f.player.findMany = async () => {
      checks++;
      if (checks === 2) allowBoth();
      await bothHere;
      return [];
    };
    const a = f.interaction();
    const b = f.interaction();
    await Promise.all([
      new UsernameCommand().execute(a),
      new UsernameCommand().execute(b),
    ]);
    assert(checks === 2, "Both requests passed the same precondition");
    assert(
      f.updates() === 1 && f.primary() === "new-uuid",
      "Only one CAS may change a primary identity"
    );
    assert(
      [...a.replies, ...b.replies].some((r: any) =>
        String(r.payload).includes("changed during this request")
      ),
      "Losing request reports concurrent mutation"
    );
  } finally {
    f.restore();
  }
});
