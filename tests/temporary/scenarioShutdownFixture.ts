import { EmbedBuilder } from "discord.js";
import { ConfigManager } from "../../src/ConfigManager";
import { GameInstance } from "../../src/database/GameInstance";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import RestartCommand from "../../src/commands/RestartCommand";
import WinnerCommand from "../../src/commands/WinnerCommand";
import { LeaderBoardFeed } from "../../src/logic/gameFeed/LeaderBoardFeed";
import { MatchRecoveryGate } from "../../src/logic/MatchRecoveryGate";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { assert, assertEqual } from "../framework/assert";

export async function reportWinner(guild: FakeGuild, organiser: FakeGuildMember, team: "RED" | "BLUE") {
  const command = new WinnerCommand();
  const interaction = createChatInputInteraction(organiser.id, {
    guild: guild as any, member: organiser, subcommand: "set", strings: { team },
  });
  await command.execute(interaction);
  await command.handleButtonPress({
    customId: "winner_confirm_yes", message: { id: "msg-1" }, user: { id: organiser.id },
    update: async () => {}, reply: async (payload: any) => { throw new Error(JSON.stringify(payload)); },
  } as any);
  assertEqual(GameInstance.getInstance().gameWinner, team, "confirmed winner recorded");
}

// Use the actual shutdown orchestration, with external boundaries replaced by
// in-memory effects. The database delegate must never be reached unmocked.
export async function shutdown(f: any) {
  const { game, guild, organiser, gameCommand } = f;
  const roles = ConfigManager.getConfig().roles;
  const members: Map<string, FakeGuildMember> = await guild.members.fetch();
  const role = { id: roles.captainRole, members: new Map([...members].filter(([, m]) => m.roles.cache.has(roles.captainRole))) };
  guild.roles.cache = new Map([[role.id, role]]);
  const expectedMetadata = JSON.stringify(game.scenarios.publicMatchMetadata());
  const token = game.getLifecycleToken();
  const matchId = game.gameId ?? token;
  const winner = game.gameWinner;
  const mvp = { RED: game.teams.RED[1], BLUE: game.teams.BLUE[1] };
  for (const side of ["RED", "BLUE"] as const) {
    const voter = game.teams[side][0].discordSnowflake;
    const target = mvp[side].discordSnowflake;
    assert(!game.voteMvp(voter, target).error, "valid MVP vote");
    assert(game.voteMvp(voter, target).error, "duplicate MVP vote rejected");
  }
  const restore: (() => void)[] = [];
  function replace(obj: any, name: string, value: any) {
    const original = obj[name];
    obj[name] = value;
    restore.push(() => { obj[name] = original; });
  }
  const events: string[] = [];
  let saves = 0;
  let restarts = 0;
  try {
    for (const member of members.values()) {
      const remove = member.roles.remove;
      replace(member.roles, "remove", (value: any) => remove(typeof value === "string" ? value : value.id));
    }
    replace(prismaClient.game, "saveGameFromInstance", async (saved: GameInstance) => {
      saves++;
      events.push("save");
      assertEqual(saved.gameId ?? saved.getLifecycleToken(), matchId, "correct match saved");
      assertEqual(saved.gameWinner, winner, "winner saved");
      assertEqual(JSON.stringify(saved.scenarios.publicMatchMetadata()), expectedMetadata, "scenario public projection saved unchanged");
      assertEqual(saved.MVPPlayerRed, mvp.RED.ignUsed, "red MVP counted before saving");
      assertEqual(saved.MVPPlayerBlue, mvp.BLUE.ignUsed, "blue MVP counted before saving");
      return { id: matchId };
    });
    replace(prismaClient.game, "updateMany", async (args: any) => {
      assertEqual(args.where.id, matchId, "checkpoint refers to saved match");
      assertEqual(args.data.cleanupState, "COMPLETE", "cleanup checkpoint complete");
      events.push("checkpoint");
      return { count: 1 };
    });
    replace(prismaClient.game, "findUnique", async () => { throw new Error("Unexpected checkpoint fallback"); });
    replace(DiscordUtil, "batchRemoveRoleFromMembers", async (_guild: any, roleId: string) => {
      events.push("roles");
      for (const m of members.values()) await m.roles.remove(roleId);
    });
    replace(DiscordUtil, "batchMoveMembersToChannel", async (_guild: any, from: string, to: string) => {
      events.push("voice");
      for (const m of members.values()) if (m.voice.channelId === from) await m.voice.setChannel(to);
    });
    replace(DiscordUtil, "cleanUpAllChannelMessages", async () => { events.push("messages"); });
    replace(SeasonService, "afterGameSaved", async () => { events.push("season"); });
    replace(LeaderBoardFeed.prototype, "generateEmbed", async () => new EmbedBuilder().setTitle("Test leaderboard"));
    replace(RestartCommand.prototype, "restartBot", () => { restarts++; events.push("restart"); });
    const timeout = global.setTimeout;
    replace(global, "setTimeout", (fn: any, ms: number, ...args: any[]) => timeout(fn, ms === 10_000 ? 0 : ms, ...args));
    const interaction = createChatInputInteraction(organiser.id, { guild: guild as any, member: organiser, subcommand: "shutdown" });
    await gameCommand.execute(interaction);
    assertEqual(MatchRecoveryGate.getBlockReason(), null, "shutdown has no unresolved recovery gate");
    assertEqual(saves, 1, "match persisted exactly once");
    assertEqual(restarts, 1, "restart requested but not executed");
    assertEqual(events[0], "save", "persistence precedes external cleanup");
    assertEqual(events.slice(-2).join(","), "checkpoint,restart", "checkpoint precedes restart");
    assert(game.getLifecycleToken() !== token, "match token rotates");
    assertEqual(game.scenarios.snapshot(), null, "scenario cleared");
    assertEqual(game.getPlayers().length, 0, "roster cleared");
    assertEqual(game.scenarios.startBlock(), null, "next normal game unblocked");
    for (const m of members.values()) {
      for (const id of [roles.redTeamRole, roles.blueTeamRole, roles.captainRole]) {
        assert(!m.roles.cache.has(id), "game role removed");
      }
    }
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}
