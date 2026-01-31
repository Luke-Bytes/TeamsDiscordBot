import { test } from "../framework/test";
import { assert } from "../framework/assert";
import RegisterCommand from "../../src/commands/RegisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { MojangAPI } from "../../src/api/MojangAPI";
import { prismaClient } from "../../src/database/prismaClient";

test("Register blocks non-organiser from registering others and blocks duplicates", async () => {
  const teamCmd = new TeamCommand();
  const cmd = new RegisterCommand(teamCmd);
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;

  // Stub Mojang and prisma
  (MojangAPI as any).usernameToUUID = async (name: string) => `uuid-${name}`;
  const idToPlayer = new Map<string, any>();
  (prismaClient as any).player.byDiscordSnowflake = async (id: string) =>
    idToPlayer.get(id) || null;
  (prismaClient as any).player.create = async ({ data }: any) => {
    const rec = {
      id: `db-${data.discordSnowflake}`,
      discordSnowflake: data.discordSnowflake,
      minecraftAccounts: [],
      latestIGN: data.latestIGN ?? null,
      primaryMinecraftAccount: null,
    };
    idToPlayer.set(rec.discordSnowflake, rec);
    return rec;
  };
  (prismaClient as any).season = { findUnique: async () => ({ id: "S1" }) };
  (prismaClient as any).playerStats = {
    findUnique: async () => ({ seasonId: "S1" }),
    create: async ({ data }: any) => ({ ...data }),
  };
  (prismaClient as any).playerPunishment = {
    findMany: async () => [],
    findFirst: async () => null,
    update: async () => {},
  };

  // Non-organiser tries to register another user
  const normal = new FakeGuildMember("U1") as any;
  guild.addMember(normal);
  const other = { id: "U2", username: "Other" } as any;
  let i = createChatInputInteraction("U1", {
    guild,
    channelId: cfg.channels.registration,
    strings: { ingamename: "PlayerX" },
    users: { discorduser: other },
  });
  await cmd.execute(i);
  let edit = i.replies.find((r) => r.type === "editReply");
  assert(
    !!edit && /do not have permission/.test(String(edit.payload?.content)),
    "Blocks non-organiser from registering others"
  );

  // Organiser registers self, then duplicate registration blocked
  const org = new FakeGuildMember("U3") as any;
  guild.addMember(org);
  await org.roles.add(cfg.roles.organiserRole);
  i = createChatInputInteraction("U3", {
    guild,
    channelId: cfg.channels.registration,
    strings: { ingamename: "PlayerY" },
  });
  await cmd.execute(i);
  // Add in-memory to game
  (game as any).teams.UNDECIDED.push({
    discordSnowflake: "U3",
    ignUsed: "PlayerY",
    primaryMinecraftAccount: `uuid-PlayerY`,
  });
  i = createChatInputInteraction("U3", {
    guild,
    channelId: cfg.channels.registration,
    strings: { ingamename: "PlayerY" },
  });
  await cmd.execute(i);
  edit = i.replies.find((r) => r.type === "editReply");
  assert(
    !!edit && /already registered/i.test(String(edit.payload?.content)),
    "Duplicate registration blocked"
  );
});

test("Register late signups message when teams decided", async () => {
  const teamCmd = new TeamCommand();
  const cmd = new RegisterCommand(teamCmd);
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  (game as any).teamsDecidedBy = "RANDOMISED";
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const org = new FakeGuildMember("U9") as any;
  guild.addMember(org);
  await org.roles.add(cfg.roles.organiserRole);
  (MojangAPI as any).usernameToUUID = async (name: string) => `uuid-${name}`;
  (prismaClient as any).player.byDiscordSnowflake = async () => null;
  (prismaClient as any).player.create = async ({ data }: any) => ({
    id: `db-${data.discordSnowflake}`,
    discordSnowflake: data.discordSnowflake,
    minecraftAccounts: [],
    latestIGN: data.latestIGN ?? null,
    primaryMinecraftAccount: null,
  });
  (prismaClient as any).season = { findUnique: async () => ({ id: "S1" }) };
  (prismaClient as any).playerStats = {
    findUnique: async () => ({ seasonId: "S1" }),
    create: async ({ data }: any) => ({ ...data }),
  };
  (prismaClient as any).playerPunishment = {
    findMany: async () => [],
    findFirst: async () => null,
    update: async () => {},
  };

  const i = createChatInputInteraction("U9", {
    guild,
    channelId: cfg.channels.registration,
    strings: { ingamename: "LateOne" },
  });
  await cmd.execute(i);
  const edit = i.replies.find((r) => r.type === "editReply");
  assert(!!edit, "Shows a late signup message when teams decided");
});
