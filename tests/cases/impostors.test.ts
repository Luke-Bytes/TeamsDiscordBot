import { test } from "../framework/test";
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { DiscordStreamRestrictions } from "../../src/logic/scenarios/shared/DiscordStreamRestrictions";
import { DiscordVoiceEffectAdapter } from "../../src/logic/scenarios/shared/DiscordVoiceEffectAdapter";
import { assert, assertEqual } from "../framework/assert";
import { PrivateBallot } from "../../src/logic/scenarios/shared/PrivateBallot";
import { drawImpostors, drawMissionHand, impostorMissions, impostorsPerTeam, rerollMission } from "../../src/logic/scenarios/impostors/ImpostorMissions";
import { assignmentResult, coverResult, impostorOutcome } from "../../src/logic/scenarios/impostors/ImpostorScoring";
import { drawVoiceSlots, slotTiming } from "../../src/logic/scenarios/impostors/ImpostorVoiceSlots";
import { ImpostorRound } from "../../src/logic/scenarios/impostors/ImpostorRound";
import { ImpostorRuntime } from "../../src/logic/scenarios/impostors/ImpostorRuntime";
import { ImpostorPrivateControls } from "../../src/logic/scenarios/impostors/ImpostorPrivateControls";
import { selectVoiceTargets, voiceEffects, type VoiceParticipant } from "../../src/logic/scenarios/shared/VoiceEffects";
import { VoiceEffectService, type VoiceChange, type VoiceEffectAdapter, type VoiceEffectRequest } from "../../src/logic/scenarios/shared/VoiceEffectService";

const zero = () => 0;
const roster = (red: number, blue = red) => ({
  RED: Array.from({ length: red }, (_, i) => `r${i}`),
  BLUE: Array.from({ length: blue }, (_, i) => `b${i}`),
});

function rejects(fn: () => unknown, message: string) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

test("Impostors: fixed catalogue, five distinct missions and equal roles based on smaller team", () => {
  assertEqual(impostorMissions.length, 11, "approved catalogue only");
  assertEqual(impostorMissions[0].objective, "Place a sign in the open in your base saying 'THE IMPOSTER? ITS ME'", "exact wording");
  for (const [red, blue, count] of [[8, 8, 1], [9, 12, 2], [12, 10, 2], [16, 30, 3], [40, 40, 3]]) {
    const sides = roster(red, blue);
    assertEqual(impostorsPerTeam(sides), count, "equal count");
    const drawn = drawImpostors(sides, zero);
    assertEqual(new Set(drawn.RED).size, count, "unique red roles");
    assertEqual(new Set(drawn.BLUE).size, count, "unique blue roles");
  }
  rejects(() => drawImpostors(roster(7, 12)), "minimum");
  const hand = drawMissionHand(zero);
  assertEqual(new Set(hand).size, 5, "five unique missions");
  const replacement = rerollMission(hand, hand[0], zero);
  assert(!hand.includes(replacement[0]), "reroll uses unused mission");
  assertEqual(replacement.slice(1).join(), hand.slice(1).join(), "other missions unchanged");
});

test("Private ballot: majority positive quorum, cutoff ties and owner validation", () => {
  const ids = roster(10).RED;
  const ballot = new PrivateBallot(ids, ids, 2);
  rejects(() => ballot.submit("r0", ["r0"]), "self vote");
  rejects(() => ballot.submit("r0", ["r1", "r1"]), "duplicate");
  rejects(() => ballot.submit("r0", ["b1"]), "enemy");
  rejects(() => ballot.submit("unknown", ["r1"]), "nonparticipant");
  rejects(() => ballot.submit("r0", ["r1", "r2", "r3"]), "over capacity");
  ballot.submit("r0", ["r1", "r2"]);
  ballot.submit("r1", ["r0", "r2"]);
  ballot.submit("r2", ["r0", "r1"]);
  ballot.submit("r3", ["r0", "r1"]);
  ballot.submit("r4", ["r0", "r2"]);
  ballot.submit("r5", ["r0", "r1"]);
  const tally = ballot.lock();
  assertEqual(tally.positiveBallots, 6, "positive quorum");
  assertEqual(tally.definite.join(), "r0,r1", "definite top two");
  assert(tally.complete, "complete");
  rejects(() => ballot.submit("r6", ["r0"]), "locked");
  const noQuorum = new PrivateBallot(ids, ids, 2);
  for (const id of ids.slice(1, 6)) noQuorum.submit(id, ["r0"]);
  noQuorum.submit("r6", []);
  noQuorum.submit("r7", []);
  assert(!noQuorum.lock().quorum, "abstain not positive");
  const tied = new PrivateBallot(ids, ids, 2);
  for (const id of ids.slice(3, 6)) tied.submit(id, ["r0", "r1"]);
  for (const id of ids.slice(6, 9)) tied.submit(id, ["r0", "r2"]);
  const result = tied.lock();
  assertEqual(result.definite.join(), "r0", "cutoff tie leaves seat unresolved");
  assertEqual(result.unresolvedSeats, 1, "unresolved seat");
  assertEqual(coverResult("r1", result), "inconclusive", "unaccused not hidden");
  assertEqual(coverResult("r0", result), "exposed", "definite accused exposed");
});

test("Impostors: all eight scoring axes and neutral incomplete outcomes", () => {
  const expected = [
    "Perfect Impostor Victory", "Won the War, Cover Blown", "Won the War, Assignment Incomplete", "Won the War, Exposed",
    "Successful Deception (match lost)", "Missions Complete, Cover Blown", "Stayed Hidden, Assignment Incomplete", "Assignment Incomplete, Exposed",
  ];
  const actual = [true, false].flatMap((won) => (["pass", "fail"] as const).flatMap((assignment) =>
    (["hidden", "exposed"] as const).map((cover) => impostorOutcome(won, assignment, cover))));
  assertEqual(actual.join("|"), expected.join("|"), "truth table");
  assertEqual(assignmentResult(3, "fulfilled"), "fail", "physical quota");
  assertEqual(assignmentResult(4, "void"), "inconclusive", "no technical free credit");
  assertEqual(impostorOutcome(null, "pass", "hidden"), "Outcome inconclusive", "unknown winner");
  assertEqual(impostorOutcome(true, "pass", "inconclusive"), "Outcome inconclusive", "unknown deduction");
});

test("Impostors: role and ballot privacy, stage deadlines, claims and staged reveal", () => {
  let now = 0;
  const sides = roster(8);
  const round = new ImpostorRound("match", sides, () => now, zero);
  assertEqual(round.result("RED"), null, "no role reveal before ballots");
  rejects(() => round.ownCard("wrong", "r0"), "wrong token");
  const card = round.ownCard("match", "r0");
  assert(card.role === "impostor", "deterministic role");
  assertEqual(round.ownCard("match", "r1").role, "innocent", "innocent card");
  if (card.role !== "impostor") throw new Error("fixture");
  round.reroll("match", "r0", card.hand[0]);
  rejects(() => round.reroll("match", "r0", card.hand[1]), "one reroll");
  rejects(() => round.beginPlaying(), "readiness");
  for (const id of [...sides.RED, ...sides.BLUE]) round.acknowledge("match", id);
  round.submitBallot("match", "r1", ["r0"]);
  round.beginPlaying();
  rejects(() => round.submitBallot("match", "r1", ["r0"]), "prediction locked");
  round.recordVoiceResult("r0", "fulfilled");
  round.beginDiscussion();
  rejects(() => round.advance(), "discussion not skipped");
  now = round.deadline!;
  assertEqual(round.advance(), "voting", "vote stage");
  for (const id of sides.RED.slice(2, 7)) round.submitBallot("match", id, ["r1"]);
  for (const id of sides.BLUE.slice(1, 6)) round.submitBallot("match", id, ["b0"]);
  rejects(() => round.anonymousClaims(), "no pre-vote claims leak");
  now = round.deadline!;
  rejects(() => round.submitBallot("match", "r7", ["r0"]), "deadline not dependent on callback");
  assertEqual(round.advance(), "claims", "both ballots locked");
  const hand = round.ownClaims("match", "r0").hand;
  rejects(() => round.ownClaims("match", "r1"), "innocent cannot claim");
  rejects(() => round.submitClaims("match", "r0", [hand[0], hand[0]]), "duplicate claim");
  round.submitClaims("match", "r0", hand.slice(0, 4));
  now = round.deadline!;
  round.advance();
  assertEqual(Object.keys(round.anonymousClaims().RED).length, 4, "anonymous reported missions");
  assertEqual(round.result("RED"), null, "identities held until speculation ends");
  now = round.deadline!;
  round.advance();
  const result = round.result("RED");
  assert(result?.status === "revealed", "final reveal");
  if (result?.status !== "revealed") throw new Error("fixture");
  assertEqual(result.RED.impostors[0].outcome, "Perfect Impostor Victory", "perfect requires all axes");
  assertEqual(result.BLUE.impostors[0].cover, "exposed", "other team exposed");
  assertEqual(result.RED.awards.psychic, 1, "early prediction award");
  assert(!JSON.stringify(result).includes("positiveBallots"), "no raw vote totals");
  assertEqual(round.result("BLUE")?.status, "revealed", "winner correction retains locked result");
});

const connected = (): VoiceParticipant[] => Array.from({ length: 10 }, (_, i) => ({
  id: `r${i}`, channelId: "red", eligible: true, serverMute: false, serverDeaf: false,
}));

test("Impostors: all six voice target policies, estimated windows and duration bounds", () => {
  const ids = Object.keys(voiceEffects) as (keyof typeof voiceEffects)[];
  const counts = [3, 2, 3, 5, 1, 1];
  ids.forEach((id, i) => {
    assertEqual(selectVoiceTargets(id, "red", connected(), "r4", zero).length, counts[i], id);
    const timing = slotTiming({ ownerId: "r0", effect: id, windowIndex: 0 }, 0, () => 0.99);
    assertEqual(timing.opens, 23 * 60_000, "announcement plus 3 plus 20");
    assert(timing.fallback + voiceEffects[id].durationMs <= timing.closes, "fallback fits");
  });
  assertEqual(selectVoiceTargets("leaderless", "red", connected(), "enemy", zero).length, 0, "missing captain");
  const pool = connected();
  pool[0].serverMute = true;
  pool[1].serverDeaf = true;
  pool[2].eligible = false;
  pool[3].channelId = "blue";
  assert(selectVoiceTargets("radio-silence", "red", pool, undefined, zero).every((id) => Number(id.slice(1)) >= 4), "exclude conflicting/out of channel");
  assertEqual(new Set(drawVoiceSlots(["a", "b", "c"], zero).map((s) => s.windowIndex)).size, 3, "distinct windows");
});

function fakeVoice() {
  const changes: VoiceChange[] = [], restored: VoiceChange[] = [];
  let created = 0, deleted = 0;
  const adapter: VoiceEffectAdapter = {
    inspect: async () => connected(),
    createIsolation: async () => { created++; return "isolated"; },
    apply: async (change) => { changes.push(change); return "applied"; },
    restore: async (change) => { restored.push(change); return "restored"; },
    removeIsolation: async () => { deleted++; return true; },
    receipt: () => {},
  };
  return { adapter, changes, restored, get created() { return created; }, get deleted() { return deleted; } };
}
const request = (effect: keyof typeof voiceEffects): VoiceEffectRequest => ({
  token: "match", slotId: "slot", team: "RED", channelId: "red", eligibleIds: connected().map((p) => p.id),
  captainId: "r4", effect, latestStart: 10,
});

test("Voice effects: all six operations restore only applied fields and own isolation", async () => {
  for (const effect of Object.keys(voiceEffects) as (keyof typeof voiceEffects)[]) {
    const fake = fakeVoice();
    const service = new VoiceEffectService("match", fake.adapter, () => true, () => 0, zero);
    assertEqual(await service.activate(request(effect)), "fulfilled", effect);
    assertEqual(await service.activate(request(effect)), "void", "same slot cannot repeat");
    assert(fake.changes.every((change) => change.operation === voiceEffects[effect].operation), "correct property");
    const cleanup = await service.stop();
    assertEqual(cleanup.unresolved.length, 0, "known changes restored");
    assertEqual(fake.restored.length, fake.changes.length, "no extra mutation");
    assertEqual(fake.created, voiceEffects[effect].operation === "move" ? 1 : 0, "owned channel only");
    assertEqual(fake.deleted, fake.created, "owned channel removed");
    await service.stop();
    assertEqual(fake.restored.length, fake.changes.length, "idempotent stop");
  }
});

test("Voice effects: stop waits for in-flight application and uncertain writes need reconciliation", async () => {
  const fake = fakeVoice();
  let resolveApply!: (value: "applied") => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fake.adapter.apply = async (change) => {
    fake.changes.push(change);
    entered();
    return new Promise((resolve) => { resolveApply = resolve; });
  };
  const service = new VoiceEffectService("match", fake.adapter, () => true, () => 0, zero);
  const pending = service.activate(request("radio-silence"));
  await started;
  const cleanup = service.stop();
  resolveApply("applied");
  assertEqual(await pending, "void", "incomplete group not credited");
  assertEqual((await cleanup).unresolved.length, 0, "cleanup waits");
  assertEqual(fake.changes.length, 1, "no later targets after stop");
  assertEqual(fake.restored.length, 1, "late success restored");
  const failure = fakeVoice();
  failure.adapter.apply = async () => "uncertain";
  const failed = new VoiceEffectService("match", failure.adapter, () => true, () => 0, zero);
  assertEqual(await failed.activate(request("blackout")), "void", "uncertain no credit");
  const outstanding = await failed.stop();
  assert(outstanding.unresolved.length > 0, "manual reconciliation");
  assertEqual(failure.restored.length, 0, "never blindly undo uncertain writes");
});

function runtimeFixture(size = 10) {
  let now = 0;
  let current = true, playing = true, matches = true;
  const sides = roster(size);
  const round = new ImpostorRound("match", sides, () => now, zero);
  const fake = fakeVoice();
  const voice = new VoiceEffectService("match", fake.adapter, () => current && playing, () => now, zero);
  const jobs = new Map<string, { at: number; run: () => Promise<void> }>();
  const stages: string[] = [];
  const runtime = new ImpostorRuntime(round, voice, {
    now: () => now,
    schedule: (id, at, run) => { jobs.set(id, { at, run }); },
    cancel: id => { jobs.delete(id); },
  }, {
    current: () => current,
    canPlay: () => playing,
    rosterMatches: () => matches,
    voiceRequest: (team) => ({ team, channelId: "red", eligibleIds: sides[team], captainId: sides[team][0] }),
    stageChanged: async stage => { stages.push(stage); },
    cleanupRequired: () => {},
  }, () => 0.5);
  return {
    round, runtime, jobs, stages, fake, sides,
    time: (value: number) => { now = value; },
    finish: () => { playing = false; },
    stale: () => { current = false; },
    rosterChanged: () => { matches = false; },
    ready: () => { for (const id of [...sides.RED, ...sides.BLUE]) round.acknowledge("match", id); },
    advance: async () => {
      now = round.deadline!;
      const job = [...jobs.values()].find(j => j.at === now);
      assert(job, "deadline job exists");
      await job!.run();
    },
  };
}

test("Impostors runtime: optional activation races fallback, stale jobs and early finish", async () => {
  const f = runtimeFixture();
  f.ready();
  f.runtime.start(0);
  const timing = f.runtime.ownTiming("match", "r0");
  const entry = [...f.jobs.entries()].find(([id]) => id.includes(":RED:0"))!;
  f.time(timing.opens);
  rejects(() => f.runtime.delayActivation("match", "r1", 0), "innocent cannot activate");
  f.runtime.delayActivation("match", "r0", 15_000);
  rejects(() => f.runtime.delayActivation("match", "r0", 0), "cannot reserve twice");
  await entry[1].run();
  assertEqual(f.fake.changes.length, 0, "replaced callback cannot activate");
  const job = f.jobs.get(entry[0])!;
  f.time(job.at);
  await job.run();
  assert(f.fake.changes.length > 0, "manual activation applied");
  const count = f.fake.changes.length;
  await job.run();
  assertEqual(f.fake.changes.length, count, "duplicate ignored");
  const stale = [...f.jobs.values()];
  f.finish();
  await f.runtime.end();
  assertEqual(f.round.stage, "discussion", "discussion starts after restoration");
  assertEqual(f.fake.restored.length, count, "voice restored before discussion");
  for (const old of stale) await old.run();
  assertEqual(f.fake.changes.length, count, "pending voice never replays");
  assert(!!f.runtime.shutdownBlock(), "shutdown waits for postgame");
  await f.advance(); await f.advance(); await f.advance(); await f.advance();
  assertEqual(f.stages.join(","), "discussion,voting,claims,mission-reveal,result-ready", "stage order");
  assertEqual(f.runtime.shutdownBlock(), null, "final result permits shutdown");
});

test("Impostors runtime: roster change voids, stale match cannot mutate", async () => {
  const f = runtimeFixture();
  f.ready(); f.runtime.start(0);
  const job = [...f.jobs.values()][0];
  f.time(job.at);
  f.rosterChanged();
  await job.run();
  assertEqual(f.round.stage, "aborted", "roster mutation voids scenario");
  assertEqual(f.fake.changes.length, 0, "no effects");
  assertEqual(f.runtime.shutdownBlock(), null, "clean abort");
  const g = runtimeFixture();
  g.ready(); g.runtime.start(0);
  const old = [...g.jobs.values()][0];
  g.time(old.at); g.stale(); await old.run();
  assertEqual(g.fake.changes.length, 0, "old match never mutates");
  await g.runtime.abort();
});

test("Impostors private editor paginates, saves atomically, rejects other users and stale controls", () => {
  const f = runtimeFixture(40);
  const controls = new ImpostorPrivateControls(f.runtime, id => id);
  const actor = "r39";
  const first = controls.open(actor)!;
  assert(first.content.includes("Page 1/2"), "large roster paginates");
  const id = (revision: number, action: string) => "fwscr:match:" + actor + ":p:" + revision.toString(36) + ":" + action;
  rejects(() => controls.apply(id(0, "select"), "r38", ["r0"]), "wrong owner");
  rejects(() => controls.apply(id(0, "select"), actor, ["b0"]), "wrong team");
  controls.apply(id(0, "select"), actor, ["r0", "r1"]);
  rejects(() => controls.apply(id(0, "submit"), actor, true), "stale revision");
  assertEqual(f.round.ballot("match", actor).submitted, undefined, "draft not submitted");
  const second = controls.apply(id(1, "next"), actor, true);
  assert(second.content.includes("Page 2/2"), "second page");
  controls.apply(id(2, "select"), actor, ["r30"]);
  controls.apply(id(3, "submit"), actor, true);
  assertEqual(f.round.ballot("match", actor).submitted?.join(","), "r0,r1,r30", "cross-page submission");
  f.ready(); f.runtime.start(0);
  rejects(() => controls.apply(id(4, "submit"), actor, true), "stage locked");
  void f.runtime.abort();
});

test("Impostors Discord stream adapter: preserve unrelated overwrite bits and refuse privileged or active streams", async () => {
  const P = PermissionFlagsBits;
  const bot = { id: "bot" };
  const member = {
    id: "member", permissions: new PermissionsBitField(), voice: { streaming: false },
  };
  const overwrites = new Map<string, any>();
  const bits = (allow: bigint, deny: bigint) => ({
    type: OverwriteType.Member, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny),
  });
  overwrites.set(member.id, bits(P.Speak | P.Stream, P.SendMessages));
  const channel = {
    id: "red", type: ChannelType.GuildVoice, parent: null,
    permissionsFor: (user: any) => user === bot ? new PermissionsBitField(P.Administrator) :
      new PermissionsBitField(P.ViewChannel | P.Connect | (overwrites.get(user.id)?.deny.has(P.Stream) ? 0n : P.Stream)),
    permissionOverwrites: {
      cache: overwrites,
      edit: async (user: any, change: { Stream: boolean | null }) => {
        const existing = overwrites.get(user.id) ?? bits(0n, 0n);
        const allow = existing.allow.bitfield & ~P.Stream;
        const deny = existing.deny.bitfield & ~P.Stream;
        overwrites.set(user.id, bits(allow | (change.Stream === true ? P.Stream : 0n), deny | (change.Stream === false ? P.Stream : 0n)));
      },
      delete: async (user: any) => { overwrites.delete(user.id); },
    },
  };
  const guild = { ownerId: "owner", members: { me: bot, fetch: async () => member }, channels: { fetch: async () => channel } };
  const teams = [{ channelId: "red", memberIds: [member.id] }];
  const service = new DiscordStreamRestrictions(guild as any, "match", () => true, () => false);
  await service.enforce(teams);
  assert(overwrites.get(member.id).deny.has(P.Stream), "effective deny applied");
  await service.verify(teams);
  assertEqual((await service.restore()).length, 0, "successful cleanup");
  assertEqual(overwrites.get(member.id).allow.bitfield, P.Speak | P.Stream, "prior allow restored");
  assertEqual(overwrites.get(member.id).deny.bitfield, P.SendMessages, "unrelated deny preserved");
  overwrites.clear();
  await service.enforce(teams);
  assertEqual((await service.restore()).length, 0, "new overwrite cleanup");
  assert(!overwrites.has(member.id), "only scenario-created empty overwrite removed");
  member.voice.streaming = true;
  let denied = false;
  try { await service.enforce(teams); } catch { denied = true; }
  assert(denied, "active screenshare blocks");
  member.voice.streaming = false;
  member.permissions.add(P.Administrator);
  denied = false;
  try { await service.enforce(teams); } catch { denied = true; }
  assert(denied, "administrator bypass blocks");
});

test("Impostors Discord voice adapter: recheck permissions, preexisting flags, disconnect and moderation conflicts", async () => {
  const P = PermissionFlagsBits;
  let allowed = true, staff = false, eligible = true;
  const member = { id: "r0", manageable: true, user: { bot: false }, isCommunicationDisabled: () => false };
  const bot = { id: "bot" };
  const voice = {
    channelId: "red" as string | null, serverMute: false, serverDeaf: false,
    setMute: async (value: boolean) => { voice.serverMute = value; },
    setDeaf: async (value: boolean) => { voice.serverDeaf = value; },
    setChannel: async (channel: any) => { voice.channelId = typeof channel === "string" ? channel : channel.id; },
  };
  const channel = {
    id: "red", type: ChannelType.GuildVoice, parentId: null,
    permissionsFor: (user: any) => new PermissionsBitField(user === bot ?
      (allowed ? P.Administrator : 0n) : P.ViewChannel | P.Connect),
  };
  const guild = {
    members: { me: bot, fetch: async () => member },
    voiceStates: { fetch: async () => voice },
    channels: { fetch: async () => channel },
  };
  const adapter = new DiscordVoiceEffectAdapter(guild as any, "match", () => eligible, () => staff);
  const mute = { memberId: "r0", operation: "mute" as const, originalChannel: "red" };
  const deaf = { ...mute, operation: "deafen" as const };
  voice.serverMute = true;
  assertEqual(await adapter.apply(deaf, () => true), "skipped", "preexisting server mute not touched");
  voice.serverMute = false;
  allowed = false;
  assertEqual(await adapter.apply(mute, () => true), "skipped", "missing bot permission");
  allowed = true;
  assertEqual(await adapter.apply(mute, () => false), "skipped", "stale activation");
  assertEqual(await adapter.apply(deaf, () => true), "applied", "deafen only");
  assert(!voice.serverMute && voice.serverDeaf, "mute unchanged");
  staff = true;
  assertEqual(await adapter.restore(deaf), "unresolved", "staff action preserved");
  assert(voice.serverDeaf, "no blind clear");
  staff = false;
  voice.channelId = null;
  assertEqual(await adapter.restore(deaf), "unresolved", "no forced reconnect");
  voice.channelId = "red";
  eligible = false;
  assertEqual(await adapter.restore(deaf), "unresolved", "eligibility changed");
  eligible = true;
  assertEqual(await adapter.restore(deaf), "restored", "known field restored");
  assert(!voice.serverDeaf, "deafen clear");
});
