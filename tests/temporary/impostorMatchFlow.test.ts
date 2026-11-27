import { ChannelType, OverwriteType, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";
import { ConfigManager } from "../../src/ConfigManager";
import { createChatInputInteraction } from "../framework/mocks";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";
import { fixture, normalDraft, rejects, wire } from "./scenarioMatchFlows.test";

// In-memory Discord REST boundary. The real stream restriction and voice
// adapters operate on these permission bits and voice states.
function mockVoice(f: any) {
  const { guild, game } = f;
  const config = ConfigManager.getConfig();
  const bot = { id: "bot" };
  guild.members.me = bot;
  guild.ownerId = "owner";
  const channels = new Map<string, any>();
  const members = new Map<string, any>();
  const voiceChanges: { member: string; kind: string; value: unknown }[] = [];
  const originals = new Map<string, string>();
  for (const side of ["RED", "BLUE"] as const) {
    const channelId = side === "RED" ? config.channels.redTeamVC : config.channels.blueTeamVC;
    for (const p of game.getPlayersOfTeam(side)) {
      const m = guild.members.cache.get(p.discordSnowflake);
      m.permissions = new PermissionsBitField();
      m.user.bot = false;
      m.isCommunicationDisabled = () => false;
      m.voice.channelId = channelId;
      m.voice.serverMute = false;
      m.voice.serverDeaf = false;
      m.voice.streaming = false;
      m.voice.setMute = async (value: boolean) => { m.voice.serverMute = value; voiceChanges.push({ member: m.id, kind: "mute", value }); };
      m.voice.setDeaf = async (value: boolean) => { m.voice.serverDeaf = value; voiceChanges.push({ member: m.id, kind: "deaf", value }); };
      m.voice.setChannel = async (target: any) => {
        m.voice.channelId = typeof target === "string" ? target : target.id;
        voiceChanges.push({ member: m.id, kind: "move", value: m.voice.channelId });
      };
      members.set(m.id, m);
      originals.set(m.id, channelId);
    }
  }
  function makeChannel(id: string, isolated = false) {
    const overwrites = new Map<string, any>();
    const bits = (allow: bigint, deny: bigint) => ({ type: OverwriteType.Member,
      allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
    const channel = {
      id, name: id, type: ChannelType.GuildVoice, parent: null, isVoiceBased: () => true,
      get members() { return new Map([...members].filter(([, m]) => m.voice.channelId === id)); },
      permissionsFor: (member: any) => member === bot ? new PermissionsBitField(P.Administrator) :
        new PermissionsBitField(P.ViewChannel | P.Connect | P.Speak | (isolated || overwrites.get(member.id)?.deny.has(P.Stream) ? 0n : P.Stream)),
      permissionOverwrites: {
        cache: overwrites,
        edit: async (member: any, change: { Stream: boolean | null }) => {
          const old = overwrites.get(member.id) ?? bits(0n, 0n);
          overwrites.set(member.id, bits((old.allow.bitfield & ~P.Stream) | (change.Stream === true ? P.Stream : 0n),
            (old.deny.bitfield & ~P.Stream) | (change.Stream === false ? P.Stream : 0n)));
        },
        delete: async (member: any) => { overwrites.delete(member.id); },
      },
      delete: async () => { channels.delete(id); },
    };
    channels.set(id, channel);
    return channel;
  }
  makeChannel(config.channels.redTeamVC);
  makeChannel(config.channels.blueTeamVC);
  guild.channels.fetch = async (id: string) => channels.get(id) ?? null;
  guild.channels.cache.get = (id: string) => channels.get(id);
  let next = 0;
  guild.channels.create = async () => makeChannel("isolation-" + ++next, true);
  guild.voiceStates = { fetch: async (id: string) => members.get(id)?.voice };
  return { channels, members, voiceChanges, originals };
}

async function runtimeAction(game: any, actor: string, action: string, value: any) {
  const prompt = await game.scenarios.reopenAction(actor);
  const c = wire(prompt).find(row => row.custom_id?.endsWith(":" + action));
  assert(c, "runtime control exists: " + action);
  return game.scenarios.applyAction(c.custom_id, actor, value);
}
test("FLOW The Impostors: private roles, live sabotage, full postgame ballot and reveal, cleanup", async () => fixture("the-impostors", 16, async f => {
  const { game, ids } = f;
  f.captains();
  await normalDraft(f);
  const voice = mockVoice(f);
  assert(game.scenarios.hasRuntime, "actual coordinator created session at final team confirmation");
  assert(game.scenarios.startBlock(), "failed DMs require private role-card access");
  const assigned: Record<string, string[]> = { RED: [], BLUE: [] };
  const oldCards = new Map<string, string>();
  for (const id of ids) {
    const p = await game.scenarios.reopenAction(id);
    assert(p, "each registered player gets private role");
    if (p.content.includes("Your role: Impostor")) {
      const team = game.getPlayersTeam(game.getPlayers().find((x: any) => x.discordSnowflake === id));
      assigned[team].push(id);
      const reroll = wire(p).find(c => c.custom_id?.endsWith(":reroll"));
      assertEqual(reroll.options.length, 5, "five distinct mission options");
      oldCards.set(id, reroll.custom_id);
      await runtimeAction(game, id, "reroll", [reroll.options[0].value]);
      await rejects(() => game.scenarios.applyAction(reroll.custom_id, id, [reroll.options[0].value]), "one reroll and old controls stale");
    } else {
      assert(p.content.includes("Your role: Innocent"), "other player is innocent");
      assert(!p.content.includes("compulsory sabotage"), "no secret missions on innocent card");
    }
    game.scenarios.markPromptDelivered(id);
  }
  assertEqual(assigned.RED.length, 1, "one impostor on 8-person red team");
  assertEqual(assigned.BLUE.length, 1, "one impostor on 8-person blue team");
  const redInnocent = game.teams.RED.find((p: any) => !assigned.RED.includes(p.discordSnowflake)).discordSnowflake;
  await runtimeAction(game, redInnocent, "select", [assigned.RED[0]]);
  await runtimeAction(game, redInnocent, "submit", true);
  const other = assigned.RED[0];
  await rejects(() => game.scenarios.applyAction(oldCards.get(other), redInnocent, ["anything"]), "cannot use someone else's secret controls");
  assertEqual(game.scenarios.publicMatchMetadata(), null, "no early role/vote persistence");
  assertEqual(game.scenarios.startBlock(), null, "all role cards received");
  // Existing member-level permission bits must be preserved.
  const first = game.teams.RED[0].discordSnowflake;
  const firstChannel = voice.channels.get(voice.originals.get(first)!);
  firstChannel.permissionOverwrites.cache.set(first, { type: OverwriteType.Member, allow: new PermissionsBitField(P.Speak | P.Stream), deny: new PermissionsBitField(P.SendMessages) });
  f.advance(0);
  assertEqual(await f.start(), "acquired", "normal match starts with real runtime hooks");
  for (const id of ids) assert(!voice.channels.get(voice.originals.get(id)!).permissionsFor(voice.members.get(id)).has(P.Stream), "screenshare denied for " + id);
  assertEqual(game.scenarios.publicMatchMetadata(), null, "no reveal while live");
  const jobs = [...f.jobs.keys()].filter((id: string) => id.includes(":voice:"));
  assertEqual(jobs.length, 2, "one compulsory sabotage scheduled per side");
  // Execute in time order to preserve the real scheduling rules.
  jobs.sort((a, b) => f.jobs.get(a).at - f.jobs.get(b).at);
  for (const job of jobs) await f.fire(job);
  assert(voice.voiceChanges.length > 0, "live voice effects reached fake Discord REST");
  const end = createChatInputInteraction(f.organiser.id, { guild: f.guild, member: f.organiser, subcommand: "end" });
  await f.gameCommand.execute(end);
  assert(game.isFinished, "ordinary match finished");
  for (const [id, member] of voice.members) {
    assertEqual(member.voice.serverMute, false, "mute restored at end");
    assertEqual(member.voice.serverDeaf, false, "deafen restored at end");
    assertEqual(member.voice.channelId, voice.originals.get(id), "voice move restored at end");
  }
  assertEqual(voice.channels.size, 2, "owned temporary voice channels deleted");
  assert(game.scenarios.runtimeShutdownBlock(), "shutdown waits for postgame result");
  await f.winner("RED");
  const blocked = createChatInputInteraction(f.organiser.id, { guild: f.guild, member: f.organiser, subcommand: "shutdown" });
  await f.gameCommand.execute(blocked);
  assert(game.scenarios.runtimeShutdownBlock(), "early shutdown command does not discard result");
  assert(!game.isRestarting, "early shutdown leaves game running");
  assertEqual(game.scenarios.publicMatchMetadata(), null, "winner does not prematurely reveal");
  await f.fire(":stage:discussion");
  for (const side of ["RED", "BLUE"]) {
    for (const p of game.teams[side]) {
      if (assigned[side].includes(p.discordSnowflake)) continue;
      await runtimeAction(game, p.discordSnowflake, "select", [assigned[side][0]]);
      await runtimeAction(game, p.discordSnowflake, "submit", true);
    }
  }
  await f.fire(":stage:voting");
  assertEqual(firstChannel.permissionOverwrites.cache.get(first).allow.bitfield, P.Speak | P.Stream, "original allow bits restored");
  assertEqual(firstChannel.permissionOverwrites.cache.get(first).deny.bitfield, P.SendMessages, "unrelated deny preserved");
  for (const id of ids.filter((id: string) => !assigned.RED.includes(id) && !assigned.BLUE.includes(id))) {
    assertEqual(await game.scenarios.reopenAction(id), null, "innocent cannot submit claims");
  }
  for (const id of [...assigned.RED, ...assigned.BLUE]) {
    const p = await game.scenarios.reopenAction(id);
    const c = wire(p).find(c => c.custom_id?.endsWith(":claimselect"));
    await runtimeAction(game, id, "claimselect", c.options.slice(0, 4).map((o: any) => o.value));
    await runtimeAction(game, id, "claimsubmit", true);
  }
  await f.fire(":stage:claims");
  assertEqual(game.scenarios.publicMatchMetadata(), null, "anonymous claims precede identity reveal");
  await f.fire(":stage:mission-reveal");
  const result: any = game.scenarios.publicMatchMetadata();
  assertEqual(result.status, "revealed", "final public scenario result");
  for (const side of ["RED", "BLUE"]) {
    assertEqual(result[side].impostors[0].id, assigned[side][0], "correct actor revealed");
    assertEqual(result[side].impostors[0].claims.length, 4, "four claims persisted");
    assertEqual(result[side].impostors[0].cover, "exposed", "majority identified impostor");
    assertEqual(result[side].impostors[0].voice, "fulfilled", "real adapter sabotage fulfilled");
  }
  assertEqual(game.scenarios.runtimeShutdownBlock(), null, "normal shutdown now allowed");
  await f.winner("BLUE");
  assertEqual(game.scenarios.publicMatchMetadata().RED.impostors[0].id, assigned.RED[0], "winner correction does not reroll role");
  await f.finish();
  assertEqual(game.scenarios.snapshot(), null, "runtime reset");
  assertEqual(f.jobs.size, 0, "no scenario jobs leaked");
}));

test("FLOW The Impostors: roster invalidation voids preparation and releases normal match", async () => fixture("the-impostors", 16, async f => {
  const { game } = f;
  f.captains();
  await normalDraft(f);
  const p = game.teams.RED.pop();
  game.teams.BLUE.push(p);
  await game.scenarios.onRegistrationChanged(p.discordSnowflake, true);
  assertEqual(game.scenarios.publicMatchMetadata().status, "void", "changed final roster aborts scenario");
  assertEqual(game.scenarios.runtimeShutdownBlock(), null, "aborted runtime can be reset");
  assertEqual(game.scenarios.startBlock(), null, "ordinary match not blocked by voided scenario");
}));
