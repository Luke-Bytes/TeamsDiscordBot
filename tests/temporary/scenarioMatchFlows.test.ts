import { AnniClass } from "@prisma/client";
import { Scheduler } from "../../src/util/SchedulerUtil";
import { GameInstance } from "../../src/database/GameInstance";
import { Channels } from "../../src/Channels";
import { ConfigManager } from "../../src/ConfigManager";
import TeamCommand from "../../src/commands/TeamCommand";
import GameCommand from "../../src/commands/GameCommand";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { prismaClient } from "../../src/database/prismaClient";
import { ScenarioCoordinator } from "../../src/logic/scenarios/ScenarioCoordinator";
import { ScenarioRegistry, plannedScenarios, scenarioRegistry } from "../../src/logic/scenarios/ScenarioRegistry";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { snakeTurn } from "../../src/logic/scenarios/drafts/ScenarioDraftRules";
import { configureHexPool } from "../../src/logic/scenarios/classHex/ClassHex";
import { reportWinner, shutdown } from "./scenarioShutdownFixture";
import { FakeGuild, FakeGuildMember, FakeVoiceChannel, createChatInputInteraction } from "../framework/mocks";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";

const minute = 60_000;
export async function rejects(fn: () => unknown, message: string) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  assert(rejected, message);
}
export function wire(prompt: any): any[] {
  return (prompt?.components ?? []).flatMap((row: any) => row.toJSON().components);
}
function control(prompt: any): string {
  const id = wire(prompt)[0]?.custom_id;
  assert(typeof id === "string", "editor has an actual Discord custom ID");
  return id;
}
export function snapshot(game: GameInstance): any { return game.scenarios.snapshot(); }
function rosterInvariant(game: GameInstance, ids: string[]) {
  assertEqual(game.teams.UNDECIDED.length, 0, "all intended participants assigned");
  assertEqual(game.teams.RED.length, ids.length / 2, "red size");
  assertEqual(game.teams.BLUE.length, ids.length / 2, "blue size");
  assertEqual(game.getPlayers().map(p => p.discordSnowflake).sort().join(","), [...ids].sort().join(","), "every original player exactly once");
}
export async function fixture(id: string, count: number, run: (f: any) => Promise<void>) {
  const game = GameInstance.getInstance();
  game.reset();
  const originalCoordinator = game.scenarios;
  const originalSchedule = Scheduler.schedule;
  const originalCancel = Scheduler.cancel;
  const jobs = new Map<string, { at: number; callback: () => any }>();
  Scheduler.schedule = (id, callback, at) => { jobs.set(id, { at: at.getTime(), callback }); };
  Scheduler.cancel = id => { jobs.delete(id); };
  const originalCommand = TeamCommand.instance;
  const originalSend = DiscordUtil.sendMessage;
  const originalTitle = PrismaUtils.getDisplayNameWithTitle;
  const originalHistory = prismaClient.gameParticipation.findMany;
  const originalFeed = Channels.gameFeed;
  const originalPicking = Channels.teamPicking;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const guild = new FakeGuild();
  const roles = ConfigManager.getConfig().roles;
  const organiser = guild.addMember(new FakeGuildMember("900000000000000000", [roles.organiserRole]));
  const config = ConfigManager.getConfig();
  for (const vcId of [config.channels.redTeamVC, config.channels.blueTeamVC, config.channels.teamPickingVC]) {
    const vc = guild.addChannel(new FakeVoiceChannel(vcId, vcId));
    Object.defineProperty(vc, "members", { get: () => new Map(ids.map(id => [id, guild.members.cache.get(id)] as const).filter(([, m]) => m?.voice.channelId === vcId)) });
  }
  const published: any[] = [];
  const dms: { id: string; payload: any }[] = [];
  const ids = Array.from({ length: count }, (_, i) => String(100000000000000000n + BigInt(i)));
  const client = { users: { fetch: async (id: string) => ({ send: async (payload: any) => { dms.push({ id, payload }); } }) } };
  let messageIndex = 0;
  const channel: any = { id: ConfigManager.getConfig().channels.teamPickingChat, guild, client,
    isSendable: () => true, messages: { fetch: async () => [] }, send: async (payload: any) => {
      published.push(payload);
      return { id: String(++messageIndex), edit: async (next: any) => { published.push(next); }, delete: async () => {} };
    } };
  const command = new TeamCommand();
  const gameCommand = new GameCommand();
  try {
    Channels.gameFeed = channel;
    Channels.teamPicking = channel;
    DiscordUtil.sendMessage = (async (_channel: string, payload: any) => { published.push(payload); }) as any;
    PrismaUtils.getDisplayNameWithTitle = (async (_id: string, name: string) => name) as any;
    prismaClient.gameParticipation.findMany = (async () => []) as any;
    if (id === "the-impostors") {
      // Exercise the actual implementation with a fixture-only registry; the release gate remains closed.
      (game as any).scenarios = new ScenarioCoordinator(game, new ScenarioRegistry(plannedScenarios.map(s => s.id === id ? { ...s, enabled: true } : s)));
    }
    game.scenarios.configure(id);
    game.startTime = new Date(now + 60 * minute);
    game.beginConfirmedAnnouncement();
    await game.scenarios.onAnnounced();
    const join = async (user: string, index: number) => {
      const member = guild.addMember(new FakeGuildMember(user));
      await member.voice.setChannel(config.channels.teamPickingVC);
      game.teams.UNDECIDED.push({
        playerId: "test-" + user, discordSnowflake: user, ignUsed: "FlowPlayer" + index,
        elo: 850 + (index % 7) * 75, captain: false, wins: 0, losses: 0,
      } as any);
      await game.scenarios.onRegistrationChanged(user, true);
    };
    for (const [i, user] of ids.entries()) await join(user, i);
    const act = async (user: string, value: string, expectedReject = false) => {
      const prompt = await game.scenarios.reopenAction(user);
      assert(prompt, "private action can be reopened for " + user);
      const cid = control(prompt);
      if (expectedReject) return rejects(() => game.scenarios.applyAction(cid, user, [value]), "invalid choice rejected: " + value);
      return game.scenarios.applyAction(cid, user, [value]);
    };
    const confirm = async (customId: string, session: any) => {
      await command.handleButtonPress({
        customId, message: session.finalizeMessage ?? session.embedMessage, guild, channel,
        user: { id: organiser.id }, deferUpdate: async () => {}, update: async () => {},
        followUp: async () => {}, reply: async (payload: any) => { throw new Error("Confirmation rejected: " + JSON.stringify(payload)); },
      } as any);
    };
    const captains = () => {
      game.setTeamCaptain("RED", game.getPlayers().find(p => p.discordSnowflake === ids[0])!);
      game.setTeamCaptain("BLUE", game.getPlayers().find(p => p.discordSnowflake === ids[1])!);
    };
    const advance = (offset: number) => { now = game.startTime!.getTime() + offset * minute; };
    const fire = async (suffix: string) => {
      const match = [...jobs.entries()].find(([key]) => key.endsWith(suffix));
      assert(match, "scheduled job exists: " + suffix);
      const [key, job] = match!;
      now = job.at;
      jobs.delete(key);
      return job.callback();
    };
    const start = async () => {
      return (gameCommand as any).startGameWithRosterLock(guild, undefined, game);
    };
    const finish = async () => shutdown({ game, guild, organiser, gameCommand });
    const winner = async (side: "RED" | "BLUE") => reportWinner(guild, organiser, side);
    const end = async () => {
      rosterInvariant(game, ids);
      assertEqual(game.scenarios.startBlock(), null, "prepared scenario permits start");
      assertEqual(await start(), "acquired", "first start");
      for (const side of ["RED", "BLUE"] as const) {
        const vc = side === "RED" ? config.channels.redTeamVC : config.channels.blueTeamVC;
        for (const player of game.teams[side]) {
          assertEqual(guild.members.cache.get(player.discordSnowflake).voice.channelId, vc, "player assigned to correct team VC");
        }
      }
      assertEqual(game.getGameStartStatus(), "started", "start committed");
      assertEqual(await start(), "alreadyStarted", "duplicate start does not replay");
      const metadata = game.scenarios.publicMatchMetadata();
      assert(!JSON.stringify(metadata).includes('"preferences"') && !JSON.stringify(metadata).includes('"votes"') && !JSON.stringify(metadata).includes('"quizzes"'), "raw private responses not saved");
      const interaction = createChatInputInteraction(organiser.id, { guild: guild as any, member: organiser, subcommand: "end" });
      await gameCommand.execute(interaction);
      assertEqual(game.isFinished, true, "end committed by command");
      assert(game.endTime instanceof Date, "end time recorded");
      await winner("RED");
      await finish();
    };
    await run({ game, command, gameCommand, guild, organiser, channel, ids, published, dms, join, act, confirm, captains, advance, end, start, jobs, fire, winner, finish });
  } finally {
    await command.teamPickingSession?.cancelSession?.();
    if (game.scenarios.hasRuntime && game.scenarios.runtimeShutdownBlock()) await game.scenarios.stopRuntime();
    game.reset();
    (game as any).scenarios = originalCoordinator;
    TeamCommand.instance = originalCommand;
    DiscordUtil.sendMessage = originalSend;
    PrismaUtils.getDisplayNameWithTitle = originalTitle;
    prismaClient.gameParticipation.findMany = originalHistory;
    Channels.gameFeed = originalFeed;
    Channels.teamPicking = originalPicking;
    Date.now = realNow;
    Scheduler.schedule = originalSchedule;
    Scheduler.cancel = originalCancel;
  }
}

async function confirmAllocation(f: any) {
  // Proposal publication is queued behind the activation roster lock.
  await f.command.runRosterOperation(async () => {});
  const session = f.command.teamPickingSession;
  assert(session, "actual scenario preview published");
  assertEqual(f.game.teams.UNDECIDED.length, f.ids.length, "no assignment before confirmation");
  await f.confirm("scenario-team-accept", session);
  assertEqual(f.game.scenarios.phase, "completed", "confirmed allocation");
}
export async function normalDraft(f: any, useWildcards = false) {
  const { game, command } = f;
  if (useWildcards) await game.scenarios.activateTrigger("wildcards", "manual", f.guild);
  const session = new DraftTeamPickingSession("snake") as any;
  command.teamPickingSession = session;
  await session.initialize({ editReply: async () => {} });
  if (useWildcards) {
    const turn = session.wildcardTurn();
    await game.scenarios.onDraftTurn(turn.team);
    const target = turn.pool[0];
    await f.act(turn.owner, "power:veto");
    await f.act(turn.owner, "veto:" + target);
    await f.act(turn.owner, "confirm");
    assertEqual(snapshot(game).data.wildcards.credits[turn.team], 0, "one credit spent");
  }
  let swapped = false;
  for (let i = 0; !session.finishedPicking && i < f.ids.length; i++) {
    const turn = session.wildcardTurn();
    if (useWildcards && !swapped && turn.own.length && turn.pool.length && snapshot(game).data.wildcards.credits[turn.team]) {
      await game.scenarios.onDraftTurn(turn.team);
      await f.act(turn.owner, "power:swap");
      await f.act(turn.owner, "from:" + turn.own[0]);
      await f.act(turn.owner, "to:" + turn.pool[0]);
      await f.act(turn.owner, "confirm");
      swapped = true;
    }
    const eligible = session.getPickPool().pool;
    assert(eligible.length, "ordinary draft has a legal pick");
    // Exercise the actual selection mutation; message parsing is independently tested.
    await session.processPick(session.turn, eligible[0], "UNDECIDED", "manual");
  }
  assert(session.finishedPicking, "draft reaches review");
  if (useWildcards) assert(swapped, "second captain completed a switcheroo");
  await f.confirm("draft-accept", session);
  // onTeamsFinalized queues activation behind the team command's roster lock.
  await command.runRosterOperation(async () => {});
  rosterInvariant(game, f.ids);
}

test("FLOW Mystery Dungeon: private questionnaire, dropout, lock, confirm, start/end/reset", async () => fixture("mystery-dungeon", 18, async f => {
  const { game, ids } = f;
  for (const [i, user] of ids.slice(0, 15).entries()) {
    const first = await game.scenarios.registrationPrompt(user);
    assert(first?.content.includes("Question 1"), "questionnaire entry");
    assert(!wire(first).some(c => c.options?.some((o: any) => o.value === "nav:5")), "no premature review");
    if (i === 0) {
      await rejects(() => game.scenarios.applyAction(control(first), ids[1], ["answer:0:0"]), "cannot answer another player's quiz");
      await f.act(user, "submit", true);
    }
    for (let q = 0; q < 5; q++) await f.act(user, "answer:" + q + ":0");
    await f.act(user, "submit");
  }
  const former = ids[14];
  const stale = control(await game.scenarios.reopenAction(former));
  game.teams.UNDECIDED = game.teams.UNDECIDED.filter((p: any) => p.discordSnowflake !== former);
  await game.scenarios.onRegistrationChanged(former, false);
  assert(!snapshot(game).data.quizzes[former], "dropout's responses removed");
  await f.join(former, 14);
  await rejects(() => game.scenarios.applyAction(stale, former, ["answer:0:0"]), "pre-dropout editor stale");
  game.scenarios.syncTriggerSchedule(Date.now(), f.guild);
  await f.fire(":lock");
  assertEqual(game.scenarios.phase, "ready", "deadline generates proposal");
  await confirmAllocation(f);
  assertEqual(Object.keys(snapshot(game).data.types).length, ids.length, "nonrespondents included in allocation");
  await f.end();
}));

test("FLOW Partners in Crime: reciprocal consent, private unilateral preference, final match", async () => fixture("partners-in-crime", 20, async f => {
  const { game, ids } = f;
  for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
    await f.act(ids[a], ids[b]);
    await f.act(ids[b], ids[a]);
  }
  await f.act(ids[0], "reveal:yes");
  await f.act(ids[1], "reveal:yes");
  await f.act(ids[2], "reveal:yes");
  await f.act(ids[6], ids[7]);
  await f.act(ids[8], ids[8], true);
  game.scenarios.syncTriggerSchedule(Date.now(), f.guild);
  await f.fire(":lock");
  const data = snapshot(game).data;
  assertEqual(data.pairs.length, 3, "only reciprocal preferences count");
  assertEqual(data.kept.length, 3, "all feasible pairs preserved");
  await confirmAllocation(f);
  for (const [a, b] of data.kept) {
    const side = (id: string) => game.getPlayersTeam(game.getPlayers().find((p: any) => p.discordSnowflake === id));
    assertEqual(side(a), side(b), "mutual duo actually assigned together");
  }
  const reveal = f.published.filter((m: any) => typeof m === "string" && m.includes("Dynamic duos")).join("\n");
  assert(reveal.includes("FlowPlayer0 & FlowPlayer1"), "both consented");
  assert(!reveal.includes("FlowPlayer2 &") && !reveal.includes("FlowPlayer6 &"), "no one-sided disclosure");
  await f.end();
}));

test("FLOW People's Captains: frozen ballots, full election and ordinary snake draft", async () => fixture("peoples-captains", 20, async f => {
  const { game, ids } = f;
  game.scenarios.syncTriggerSchedule(Date.now(), f.guild);
  await f.fire(":election");
  const ballots = snapshot(game).data.ballots;
  for (const id of ids) {
    assertEqual(new Set(ballots[id]).size, 3, "three distinct candidates");
    assert(!ballots[id].includes(id), "no self vote");
    await f.act(id, "vote:" + ballots[id][0]);
  }
  await rejects(() => game.scenarios.activateTrigger("close", "manual", f.guild), "cannot cut election short");
  await f.fire(":close");
  assertEqual(snapshot(game).data.turnout, ids.length, "all votes counted");
  await game.scenarios.approveResult(f.guild);
  assert(game.getCaptainOfTeam("RED") && game.getCaptainOfTeam("BLUE"), "both elected captains installed");
  await normalDraft(f);
  await f.end();
}));

for (const id of ["masked-draft", "draft-roulette"]) {
  test("FLOW " + id + ": every pick through owner-bound controls, confirmation and match", async () => fixture(id, 20, async f => {
    const { game, command, ids } = f;
    f.captains();
    await game.scenarios.activateTrigger("draft", "manual", f.guild);
    const session = command.teamPickingSession;
    assert(session, "real draft session");
    const initial = snapshot(game).data.draft;
    const mapping = JSON.stringify(initial.cards);
    let rerolled = false;
    for (let i = 0; i < ids.length - 2; i++) {
      const p = snapshot(game).data.draft;
      const team = snakeTurn(p.pickIndex, p.first);
      const actor = team === "RED" ? p.redCaptain : p.blueCaptain;
      const rows = wire(session.turnControls());
      const value = rows[0].options[0].value;
      if (id === "masked-draft") {
        assert(/^M\d+$/.test(value), "opaque card identifier");
        assert(!JSON.stringify(rows).includes("FlowPlayer"), "no IGN in anonymous controls");
        assertEqual(JSON.stringify(p.cards), mapping, "card mapping stable");
      }
      const interaction = {
        customId: rows[0].custom_id, message: session.turnMessage, user: { id: actor },
        values: [value], isStringSelectMenu: () => true, isButton: () => false,
        deferUpdate: async () => {}, reply: async () => {},
      };
      if (i === 0) {
        await session.handleControl({ ...interaction, user: { id: ids[3] } });
        assertEqual(snapshot(game).data.draft.pickIndex, i, "non-captain rejected");
      }
      if (id === "draft-roulette" && !rerolled) {
        const reroll = rows.find(c => c.custom_id?.endsWith(":reroll"));
        await session.handleControl({ ...interaction, customId: reroll.custom_id, isStringSelectMenu: () => false, isButton: () => true });
        assert(snapshot(game).data.draft.rerolls[team], "one reroll spent");
        interaction.values = [wire(session.turnControls())[0].options[0].value];
        rerolled = true;
      }
      await session.handleControl(interaction);
      assertEqual(snapshot(game).data.draft.pickIndex, i + 1, "one legal pick advanced");
      await session.handleControl(interaction);
      assertEqual(snapshot(game).data.draft.pickIndex, i + 1, "stale pick cannot replay");
    }
    assert(snapshot(game).data.draft.finished, "complete draft awaits organiser");
    assertEqual(game.teams.UNDECIDED.length, ids.length - 2, "not committed before confirmation");
    await f.confirm("draft-accept", session);
    assertEqual(game.scenarios.phase, "completed", "draft confirmed");
    await f.end();
  }));
}

test("FLOW Captain's Wildcards: both powers used in one complete snake draft", async () => fixture("captains-wildcards", 20, async f => {
  f.captains();
  await normalDraft(f, true);
  assertEqual(snapshot(f.game).data.wildcards.history.length, 2, "exactly two powers");
  assertEqual(f.game.scenarios.phase, "completed", "wildcard draft completes");
  await f.end();
}));

test("FLOW Cursed Classes: normal draft, independent captain edits, six curses and match", async () => fixture("class-hex", 20, async f => {
  const { game } = f;
  f.captains();
  const pool = Object.values(AnniClass).slice(0, 5);
  configureHexPool(game, pool.join(","), f.organiser.id);
  await normalDraft(f);
  const data = snapshot(game).data;
  assertEqual(new Set(data.hexDraw).size, 3, "three distinct approved classes");
  const red = game.getCaptainOfTeam("RED").discordSnowflake;
  const blue = game.getCaptainOfTeam("BLUE").discordSnowflake;
  for (const [captain, side] of [[red, "BLUE"], [blue, "RED"]] as const) {
    const targets = game.getPlayersOfTeam(side).map((p: any) => p.discordSnowflake);
    await f.act(captain, captain, true);
    await f.act(captain, targets[0]);
    await f.act(captain, targets[0], true);
    await f.act(captain, targets[1]);
    await f.act(captain, targets[2]);
    await f.act(captain, "submit");
    if (captain === red) {
      assert(game.scenarios.startBlock(), "one submission insufficient");
      assert(!f.published.some((m: any) => typeof m === "string" && m.includes("all six curses revealed")), "first captain's picks remain private");
    }
  }
  const result = game.scenarios.publicMatchMetadata();
  assertEqual(result.assignments.length, 6, "six assignments saved");
  assertEqual(new Set(result.assignments.map((x: any) => x.player)).size, 6, "six distinct targets");
  await f.end();
}));

test("FLOW Impostors release gate: ordinary selection refused while implementation is gated", async () => {
  assertEqual(scenarioRegistry.get("the-impostors")?.enabled, false, "release gate stays closed");
  await rejects(() => scenarioRegistry.requireAvailable("the-impostors"), "not selectable in production");
});

test("FLOW Cancellation: abandoned registration controls cannot mutate a subsequent normal match", async () => fixture("partners-in-crime", 18, async f => {
  const { game, ids } = f;
  const old = control(await game.scenarios.registrationPrompt(ids[0]));
  await f.act(ids[0], ids[1]);
  await game.scenarios.cancel();
  assertEqual(game.scenarios.startBlock(), null, "organiser can run ordinary match after cancellation");
  await rejects(() => game.scenarios.applyAction(old, ids[0], [ids[2]]), "cancelled controls stale");
  game.reset();
  game.scenarios.configure("none");
  game.beginConfirmedAnnouncement();
  await f.join(ids[0], 0);
  await rejects(() => game.scenarios.applyAction(old, ids[0], [ids[2]]), "prior match controls stale");
  assertEqual(game.scenarios.snapshot(), null, "ordinary game has no scenario state");
}));
