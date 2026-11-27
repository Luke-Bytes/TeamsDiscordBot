// Cross-system regressions reproduced during the final release review.
import { strict as assert } from "node:assert";
import { test } from "./framework/test";
import { CurrentGameManager } from "../src/logic/CurrentGameManager";
import { GuildMembership } from "../src/logic/GuildMembership";
import TeamCommand from "../src/commands/TeamCommand";
import { Channels } from "../src/Channels";
import { SeasonService } from "../src/database/SeasonService";
import { SeasonLifecycleState, SeasonType } from "@prisma/client";
import { RegistrationIdentity } from "../src/database/RegistrationIdentity";
import { PlayerInstance } from "../src/database/PlayerInstance";
import { MojangAPI } from "../src/api/MojangAPI";
import { PrismaUtils } from "../src/util/PrismaUtils";
import { prismaClient } from "../src/database/prismaClient";
import PunishCommand from "../src/commands/PunishCommand";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

test("cross-system: queued departure cannot undo fresh reconciliation of a returning member", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const priorTeam = TeamCommand.instance;
  const priorFeed = Channels.gameFeed;
  const cmd = new TeamCommand();
  const slow = gate<any>();
  const missing = gate();
  let returned = false;
  const guild: any = { id: "review-guild", members: { fetch: async ({ user }: any) => {
    if (user === "slow") return slow.promise;
    if (!returned) { missing.resolve(); throw { code: 10007 }; }
    return { id: user };
  }}};
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = ["slow", "returning"].map((id) => ({discordSnowflake: id, ignUsed: id, captain: false, elo: 1000} as any));
  (Channels as any).gameFeed = { guild };
  try {
    const reconcile = cmd.runRosterOperation(() => GuildMembership.reconcile(guild, cmd));
    await missing.promise;
    const departure = cmd.handleGuildDeparture("returning", guild.id);
    returned = true;
    slow.resolve({ id: "slow" });
    assert.deepEqual(await reconcile, [], "fresh reconciliation correctly retains returning player");
    await departure;
    assert.equal(game.getPlayers().some((p) => p.discordSnowflake === "returning"), true,
      "queued departure must not remove a member who has already returned");
  } finally {
    slow.resolve({ id: "slow" });
    game.reset();
    TeamCommand.instance = priorTeam;
    Channels.gameFeed = priorFeed;
  }
});

test("cross-system: unrelated pending announcement delivery must not block active-season admission", async () => {
  const svc = SeasonService as any;
  const keys = ["recoverClosures", "evaluateRolloverInternal", "deliverPendingAnnouncements", "refreshPresence", "getActiveSeason", "scheduleDeadline"];
  const saved = new Map(keys.map((key) => [key, svc[key]]));
  const started = gate(), release = gate();
  const season = { id: "active", type: SeasonType.RANKED, lifecycleState: SeasonLifecycleState.ACTIVE };
  let admitted = false;
  let maintenance: Promise<unknown> | undefined;
  let admission: Promise<unknown> | undefined;
  try {
    svc.recoverClosures = async () => {};
    svc.evaluateRolloverInternal = async () => ({ closed: false, pending: false });
    svc.getActiveSeason = async () => season;
    svc.refreshPresence = async () => {};
    svc.scheduleDeadline = () => {};
    svc.deliverPendingAnnouncements = async () => { started.resolve(); await release.promise; };
    maintenance = svc.periodicMaintenance();
    await started.promise;
    admission = SeasonService.withGameAdmission(() => { admitted = true; });
    await flush();
    assert.equal(admitted, true, "idle maintenance Discord delivery holds season admission hostage");
  } finally {
    release.resolve();
    await Promise.all([maintenance, admission]);
    for (const [key, value] of saved) svc[key] = value;
  }
});

test("cross-system: punishment committed during final statistics read blocks roster admission", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const oldLookup = MojangAPI.usernameToUUID;
  const oldReverse = MojangAPI.uuidToUsername;
  const oldPlayer = PlayerInstance.byDiscordSnowflake;
  const oldPunishment = (prismaClient as any).playerPunishment;
  const entered = gate(), release = gate();
  const banEntered = gate(), banRelease = gate();
  let ban: { punishmentExpiry: Date } | null = null;
  let registration: Promise<any> | undefined;
  let punishment: Promise<any> | undefined;
  let settled = false;
  const uuid = "ab".repeat(16);
  const row: any = { id: "review-player", discordSnowflake: "review-member", primaryMinecraftAccount: uuid, latestIGN: "PlayerName", minecraftAccounts: ["PlayerName"] };
  game.reset();
  game.announced = true;
  try {
    MojangAPI.usernameToUUID = async () => uuid;
    MojangAPI.uuidToUsername = async () => "PlayerName";
    (prismaClient as any).playerPunishment = {
      findFirst: async ({ where }: any) => {
        assert.equal(where.playerId, row.id);
        return ban;
      },
      create: async ({ data }: any) => {
        assert.equal(data.playerId, row.id);
        banEntered.resolve();
        await banRelease.promise;
        ban = { punishmentExpiry: data.punishmentExpiry };
        return ban;
      },
    };
    PlayerInstance.byDiscordSnowflake = async () => {
      entered.resolve();
      await release.promise;
      return { playerId: row.id, discordSnowflake: row.discordSnowflake, primaryMinecraftAccount: uuid, latestIGN: row.latestIGN, minecraftAccounts: [...row.minecraftAccounts], ignUsed: row.latestIGN } as any;
    };
    const prepared = await RegistrationIdentity.prepare(row.discordSnowflake, game.getLifecycleToken(), row, row.latestIGN);
    if ("error" in prepared) throw new Error(prepared.error);
    registration = game.addPlayerByDiscordId(row.discordSnowflake, row.latestIGN, prepared.identity)
      .finally(() => { settled = true; });
    await entered.promise;
    // Exercise the actual organiser write path while registration is awaiting
    // its profile/statistics read, including an in-flight punishment write.
    punishment = (new PunishCommand() as any).addPunishment(
      row.id, "review ban", new Date(), new Date(Date.now() + 60_000)
    );
    await banEntered.promise;
    release.resolve();
    await flush();
    assert.equal(settled, false, "admission waits for an earlier ban write");
    assert.equal(game.getPlayers().length, 0);
    banRelease.resolve();
    await punishment;
    const result = await registration;
    assert.match(result.error, /currently banned/i, "active punishment must be checked after delayed statistics/profile read");
    assert.equal(game.getPlayers().length, 0, "banned user must not enter roster");
  } finally {
    release.resolve();
    banRelease.resolve();
    await Promise.allSettled([registration, punishment]);
    game.reset();
    MojangAPI.usernameToUUID = oldLookup;
    MojangAPI.uuidToUsername = oldReverse;
    PlayerInstance.byDiscordSnowflake = oldPlayer;
    (prismaClient as any).playerPunishment = oldPunishment;
  }
});

test("cross-system: per-player punishment queue isolates accounts and releases after rejection", async () => {
  const entered = gate(), release = gate();
  const failure = new Error("injected punishment write failure");
  const first = PrismaUtils.withPunishmentAdmission("blocked", async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const rejected = assert.rejects(first, (error) => error === failure);
  let following: Promise<boolean> | undefined;
  try {
    await entered.promise;
    let ran = false;
    following = PrismaUtils.withPunishmentAdmission("blocked", async () => {
      ran = true;
      return true;
    });
    assert.equal(await PrismaUtils.withPunishmentAdmission("independent", async () => true), true);
    assert.equal(ran, false);
    release.resolve();
    await rejected;
    assert.equal(await following, true);
  } finally {
    release.resolve();
    await Promise.allSettled([rejected, following]);
  }
});

test("cross-system: queued Discord lookup failure preserves the roster and a later confirmed departure removes it", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const priorTeam = TeamCommand.instance;
  const priorFeed = Channels.gameFeed;
  const cmd = new TeamCommand();
  let code = 503;
  const guild: any = { id: "review-guild", members: {
    fetch: async () => { throw { code }; },
  }};
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "member", captain: false } as any];
  (Channels as any).gameFeed = { guild };
  try {
    await assert.rejects(cmd.handleGuildDeparture("member", guild.id));
    assert.equal(game.getPlayers().length, 1);
    code = 10007;
    assert.equal(await cmd.handleGuildDeparture("member", guild.id), true);
    assert.equal(game.getPlayers().length, 0);
  } finally {
    game.reset();
    TeamCommand.instance = priorTeam;
    Channels.gameFeed = priorFeed;
  }
});

test("cross-system: season outbox serialises delivery and retains one pending pass", async () => {
  const svc = SeasonService as any;
  const original = svc.deliverPendingAnnouncementsPass;
  const entered = gate(), release = gate();
  let calls = 0;
  let running = 0;
  let peak = 0;
  let work: Promise<void>[] = [];
  try {
    svc.deliverPendingAnnouncementsPass = async () => {
      calls++;
      peak = Math.max(peak, ++running);
      try {
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        }
      } finally { running--; }
    };
    work.push(SeasonService.deliverPendingAnnouncements());
    await entered.promise;
    work.push(...Array.from({ length: 20 }, () => SeasonService.deliverPendingAnnouncements()));
    await flush();
    assert.equal(calls, 1);
    release.resolve();
    await Promise.all(work);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    svc.deliverPendingAnnouncementsPass = original;
  }
});
