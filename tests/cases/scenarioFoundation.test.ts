import { randomUUID } from "node:crypto";
import { GameInstance } from "../../src/database/GameInstance";
import { ScenarioCoordinator, validateScenarioState } from "../../src/logic/scenarios/ScenarioCoordinator";
import { ScenarioRegistry, plannedScenarios, scenarioRegistry } from "../../src/logic/scenarios/ScenarioRegistry";
import { ScenarioDefinition } from "../../src/logic/scenarios/ScenarioTypes";
import { ScenarioTeamPickingSession } from "../../src/logic/scenarios/ScenarioTeamPickingSession";
import { deliverScenarioRegistrationPrompt, deliverScenarioAction } from "../../src/logic/scenarios/ScenarioPromptDelivery";
import { Channels } from "../../src/Channels";
import { handleScenarioDashboard } from "../../src/logic/scenarios/ScenarioDashboard";
import GameCommand from "../../src/commands/GameCommand";
import { MessageFlags } from "discord.js";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";
import { SeasonService } from "../../src/database/SeasonService";
import { SeasonType } from "@prisma/client";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { Scheduler } from "../../src/util/SchedulerUtil";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

const definition = (override: Partial<ScenarioDefinition> = {}): ScenarioDefinition => ({
  id: "fixture", name: "Test Scenario", description: "Test-only scenario",
  category: "team-formation", stage: "registration", version: 1,
  capabilities: { teams: true }, enabled: true, implementation: {},
  ...override,
});

function fakeCoordinator() {
  let token = randomUUID();
  const roster = [{ discordSnowflake: "1001", captain: true }, { discordSnowflake: "1002", captain: false }];
  const game = {
    announced: false, isFinished: false,
    getGameStartStatus: () => "idle",
    getLifecycleToken: () => token,
    getPlayers: () => roster,
    getPlayersTeam: (p: typeof roster[number]) => p.discordSnowflake === "1001" ? "RED" : "UNDECIDED",
    hasFinalizedPlayableTeams: () => false,
  } as unknown as GameInstance;
  const registry = new ScenarioRegistry([definition()]);
  return {
    game, registry, roster,
    coordinator: new ScenarioCoordinator(game, registry),
    newMatch: () => { token = randomUUID(); },
  };
}

test("Scenario trigger policies are declared for all seven enabled definitions", () => {
  const policies = new Map(plannedScenarios.map((s) => [s.id, s.triggers?.map((t) => t.type)]));
  assert(policies.get("mystery-dungeon")!.includes("on_registration"), "Mystery Dungeon collects at registration");
  assert(policies.get("mystery-dungeon")!.includes("before_game_start"), "Mystery Dungeon locks later");
  assert(policies.get("partners-in-crime")!.includes("on_registration"), "Partners collects preferences");
  assert(policies.get("peoples-captains")!.includes("before_game_start"), "election is scheduled");
  assert(!policies.get("peoples-captains")!.includes("on_registration"), "election has no volunteer prompt");
  for (const id of ["masked-draft", "draft-roulette", "captains-wildcards"])
    assert(policies.get(id)!.includes("on_draft_start"), `${id} hooks draft`);
  assert(policies.get("class-hex")!.includes("on_teams_finalized"), "Class Hex follows final teams");
  for (const planned of plannedScenarios.filter(s => s.enabled)) {
    assertEqual(planned.enabled, true, "scenario is enabled");
    assert(!!planned.implementation?.activateTrigger || !!planned.implementation?.onDraftTurn, "scenario has gameplay hooks");
  }
});

test("Scenario registration entry is private, recoverable and bound to one Discord identity", async () => {
  let renders = 0;
  const { game, roster, newMatch } = fakeCoordinator();
  const registry = new ScenarioRegistry([definition({
    triggers: [{ id: "quiz", type: "on_registration", kind: "quiz", allowUpdates: false }],
    implementation: { registrationPrompt: (_game, _id, customId) => {
      renders++;
      return { content: "Private quiz", components: [] };
    } },
  })]);
  const sc = new ScenarioCoordinator(game, registry);
  (game as any).startTime = new Date(Date.now() + 60_000);
  sc.configure("fixture");
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  const first = await sc.registrationPrompt("1002");
  assertEqual(first?.content, "Private quiz", "private prompt is rendered, not sent publicly");
  const record = sc.snapshot()!.prompts![0];
  assertEqual(record.userId, "1002", "Discord ID, not IGN");
  await sc.registrationPrompt("1002");
  assertEqual(sc.snapshot()!.actions.length, 1, "one action for repeat prompts");
  assertEqual(renders, 2, "reopening renders same pending action");
  const id = `fwsc:${game.getLifecycleToken()}:${record.actionId}:1002`;
  sc.submitAction(id, "1002", true);
  assertEqual((await sc.registrationPrompt("1002")), null, "submitted single-use interaction not repeated");
  roster.splice(1, 1);
  await sc.onRegistrationChanged("1002", false);
  assertEqual(sc.snapshot()!.prompts!.length, 0, "unregister invalidates old prompt");
  roster.push({ discordSnowflake: "1002", captain: false });
  await sc.onRegistrationChanged("1002", true);
  await sc.registrationPrompt("1002");
  assert(sc.snapshot()!.prompts![0].actionId !== record.actionId, "rejoining gets fresh interaction ID");
  (game as any).startTime = new Date(Date.now() - 1_000);
  assertEqual(await sc.registrationPrompt("1002"), null, "late registration cannot reopen expired collection");
  sc.reset();
});

test("Scenario prompt failures do not roll back a registered player, and private DM delivery is used for organisers", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const original = game.scenarios;
  (game as any).scenarios = new ScenarioCoordinator(game, new ScenarioRegistry([definition({
    triggers: [{ id: "quiz", type: "on_registration", kind: "quiz" }],
    implementation: { registrationPrompt: (_g, _id, customId) => ({ content: "Private question", components: [] }) },
  })]));
  try {
    game.scenarios.configure("fixture");
    game.startTime = new Date(Date.now() + 20 * 60_000);
    game.beginConfirmedAnnouncement();
    game.teams.UNDECIDED.push({ discordSnowflake: "1002" } as any);
    let flags = 0;
    const failed = {
      user: { id: "1002" },
      followUp: async (message: any) => { flags = message.flags; throw new Error("expired interaction"); },
    };
    await deliverScenarioRegistrationPrompt(failed as any, game, "1002");
    assertEqual(flags, MessageFlags.Ephemeral, "self registration prompt is ephemeral");
    assertEqual(game.getPlayers().length, 1, "Discord failure never undoes registration");
    assertEqual(game.scenarios.snapshot()!.prompts![0].status, "failed", "failure is recorded");
    let dm: any;
    const organiser = {
      user: { id: "1001" },
      client: { users: { fetch: async (id: string) => {
        assertEqual(id, "1002", "DM is addressed to the registered player");
        return { send: async (message: any) => { dm = message; } };
      } } },
    };
    await deliverScenarioRegistrationPrompt(organiser as any, game, "1002");
    assertEqual(dm?.content, "Private question", "organiser registration delivers only a private DM");
    assertEqual(game.scenarios.snapshot()!.actions.length, 1, "failure/retry keeps original action");
    assertEqual(game.scenarios.snapshot()!.prompts![0].status, "delivered", "DM success tracked");
  } finally {
    game.reset();
    (game as any).scenarios = original;
  }
});

test("Scenario organiser command group enforces organiser permissions and private self-service access", async () => {
  const command = new GameCommand();
  const json = command.data.toJSON() as any;
  const group = json.options.find((option: any) => option.name === "scenario");
  assert(group && group.options.length === 8, "scenario has guide, status, start, resume, open, pool, report-class and cancel");
  const denied: any[] = [];
  const guild = new FakeGuild();
  const nonOrganiser = new FakeGuildMember("1002");
  guild.addMember(nonOrganiser);
  const interaction = {
    user: { id: "1002" }, member: nonOrganiser, guild,
    options: { getSubcommand: () => "start", getSubcommandGroup: () => "scenario", getString: () => null },
    reply: async (message: any) => { denied.push(message); },
  };
  await command.execute(interaction as any);
  assert(denied.some((message) => JSON.stringify(message).includes("permission")), "non-organiser may not activate scenario stage");
});

test("Scenario stage manual starts, concurrency and prerequisites share one idempotent activation", async () => {
  const { game, newMatch, roster } = fakeCoordinator();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new ScenarioRegistry([definition({
    triggers: [{ id: "elect", type: "before_game_start", offsetMinutes: 15, manual: true, minPlayers: 3, captureRoster: true }],
    implementation: { activateTrigger: async () => { runs++; await gate; } },
  })]);
  const sc = new ScenarioCoordinator(game, registry);
  sc.configure("fixture");
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  let blocked = false;
  try { await sc.activateTrigger("elect"); } catch (e) { blocked = String(e).includes("At least 3"); }
  assert(blocked, "minimum roster checked");
  roster.push({ discordSnowflake: "1003", captain: false });
  const first = sc.activateTrigger("elect");
  const second = sc.activateTrigger("elect", "automatic");
  assert((await second).includes("already starting"), "concurrent timer cannot rerun hook");
  release();
  await first;
  assertEqual(runs, 1, "stage ran once");
  assertEqual(sc.snapshot()!.triggers![0].rosterIds!.length, 3, "snapshot captured at activation");
  assert((await sc.activateTrigger("elect")).includes("already active"), "manual duplicate is idempotent");
  roster.pop();
  let stale = false;
  try { sc.assertCapturedRoster("elect"); } catch { stale = true; }
  assert(stale, "authoritative commits cannot trust stale roster");
  sc.reset();
});

// Exercise the coordinator's real scheduled callbacks without wall-clock sleeps.
// Scheduler's own timer implementation is covered by its separate tests.
async function withScenarioClock(
  sc: ScenarioCoordinator,
  run: (clock: {
    tasks: Map<string, { callback: Parameters<typeof Scheduler.schedule>[1]; at: number }>;
    cancelled: string[];
    advanceTo: (time: number) => void;
  }) => Promise<void>
): Promise<void> {
  const originalNow = Date.now;
  const originalSchedule = Scheduler.schedule;
  const originalCancel = Scheduler.cancel;
  let now = Date.UTC(2026, 10, 25, 12);
  const tasks = new Map<string, { callback: Parameters<typeof Scheduler.schedule>[1]; at: number }>();
  const cancelled: string[] = [];
  Date.now = () => now;
  Scheduler.schedule = (id, callback, targetTime) => {
    tasks.set(id, { callback, at: targetTime.getTime() });
  };
  Scheduler.cancel = (id) => {
    cancelled.push(id);
    tasks.delete(id);
  };
  try {
    await run({ tasks, cancelled, advanceTo: (time) => { now = time; } });
  } finally {
    try {
      sc.reset();
    } finally {
      Date.now = originalNow;
      Scheduler.schedule = originalSchedule;
      Scheduler.cancel = originalCancel;
    }
  }
}

test("Scenario timers honour T-15 rescheduling and cancellation without replay", async () => {
  const { game, newMatch } = fakeCoordinator();
  let runs = 0;
  const sc = new ScenarioCoordinator(game, new ScenarioRegistry([definition({
    triggers: [{ id: "lock", type: "before_game_start", offsetMinutes: 15, manual: true }],
    implementation: { activateTrigger: () => { runs++; } },
  })]));
  await withScenarioClock(sc, async ({ tasks, cancelled, advanceTo }) => {
    sc.configure("fixture");
    game.announced = true;
    newMatch();
    sc.confirmAnnouncement();
    const now = Date.now();
    const taskId = `scenario:${game.getLifecycleToken()}:lock`;
    game.startTime = new Date(now + 15 * 60_000 + 200);
    sc.syncTriggerSchedule();
    assertEqual(sc.snapshot()!.triggers![0].status, "scheduled", "T-15 job armed");
    const original = tasks.get(taskId)!;
    assertEqual(original.at, now + 200, "exact original T-15 deadline");
    game.startTime = new Date(now + 15 * 60_000 + 400);
    sc.syncTriggerSchedule();
    const rescheduled = tasks.get(taskId)!;
    assertEqual(cancelled.join(","), taskId, "original timer cancelled");
    assertEqual(tasks.size, 1, "only one replacement timer");
    assertEqual(rescheduled.at, now + 400, "exact edited T-15 deadline");
    assert(original.callback !== rescheduled.callback, "replacement has a new callback");

    advanceTo(original.at);
    await original.callback(); // Simulate an already queued stale callback.
    assertEqual(runs, 0, "old deadline cannot activate the rescheduled stage");
    advanceTo(rescheduled.at - 1);
    await rescheduled.callback();
    assertEqual(runs, 0, "replacement cannot activate before its deadline");
    advanceTo(rescheduled.at);
    await rescheduled.callback();
    assertEqual(runs, 1, "rescheduled job activates once");
    assertEqual(sc.snapshot()!.triggers![0].status, "active", "stage activated");
    assertEqual(tasks.size, 0, "activation releases the scheduled timer");
    await rescheduled.callback();
    assertEqual(runs, 1, "duplicate callback cannot replay activation");
    await sc.cancel();
    assertEqual(sc.selectedId, null, "cancelling releases trigger state");
    await rescheduled.callback();
    assertEqual(runs, 1, "cancelled scenario cannot replay activation");

    // Cancellation before the deadline must also remove an armed task.
    game.announced = false;
    newMatch();
    sc.configure("fixture");
    game.announced = true;
    sc.confirmAnnouncement();
    game.startTime = new Date(Date.now() + 16 * 60_000);
    sc.syncTriggerSchedule();
    const pendingId = `scenario:${game.getLifecycleToken()}:lock`;
    const pending = tasks.get(pendingId)!;
    await sc.cancel();
    assert(cancelled.includes(pendingId), "pending timer cancelled");
    assertEqual(tasks.size, 0, "no timer remains after cancellation");
    advanceTo(pending.at);
    await pending.callback();
    assertEqual(runs, 1, "cancelled pending stage never activates");
  });
});

test("Scenario hook failures pause the workflow, preserve a reason, and cannot double-execute", async () => {
  const { game, newMatch } = fakeCoordinator();
  let attempts = 0;
  const sc = new ScenarioCoordinator(game, new ScenarioRegistry([definition({
    triggers: [{ id: "start", type: "manual", manual: true }],
    implementation: { activateTrigger: () => {
      attempts++;
      throw new Error("Mocked stage error");
    } },
  })]));
  sc.configure("fixture");
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  let failed = false;
  try { await sc.activateTrigger("start"); } catch (error) {
    failed = String(error).includes("Mocked stage error");
  }
  assert(failed, "hook error propagates to organiser");
  assertEqual(sc.phase, "needs_review", "scenario fails closed");
  assertEqual(sc.snapshot()!.triggers![0].status, "failed", "failed trigger retained");
  assert(sc.triggerStatus().includes("Mocked stage error"), "organiser status is actionable");
  try { await sc.activateTrigger("start"); } catch { /* recovery gate prevents retry */ }
  assertEqual(attempts, 1, "a failed stage cannot rerun without review");
  await sc.cancel();
});

test("Old scheduled callback cannot run in a later match", async () => {
  const { game, newMatch } = fakeCoordinator();
  let executions = 0;
  const sc = new ScenarioCoordinator(game, new ScenarioRegistry([definition({
    triggers: [{ id: "close", type: "before_game_start", offsetMinutes: 15, manual: true }],
    implementation: { activateTrigger: () => { executions++; } },
  })]));
  await withScenarioClock(sc, async ({ tasks, advanceTo }) => {
    sc.configure("fixture");
    game.announced = true;
    newMatch();
    sc.confirmAnnouncement();
    game.startTime = new Date(Date.now() + 15 * 60_000 + 80);
    sc.syncTriggerSchedule();
    const taskId = `scenario:${game.getLifecycleToken()}:close`;
    const stale = tasks.get(taskId)!;
    newMatch();
    advanceTo(stale.at);
    await stale.callback();
    assertEqual(executions, 0, "stale timer rejected by game-token guard");
    assertEqual(sc.snapshot()!.triggers![0].status, "scheduled", "stale callback did not mutate trigger state");
  });
});

test("Scenario recovery retains trigger state but pauses all scheduled and private actions", async () => {
  const { game, newMatch } = fakeCoordinator();
  const registry = new ScenarioRegistry([definition({
    triggers: [{ id: "lock", type: "before_game_start", offsetMinutes: 15, manual: true }],
  })]);
  const sc = new ScenarioCoordinator(game, registry);
  sc.configure("fixture");
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  (game as any).startTime = new Date(Date.now() + 16 * 60_000);
  sc.syncTriggerSchedule();
  const snapshot = sc.snapshot()!;
  validateScenarioState(snapshot, registry);
  const recovered = new ScenarioCoordinator(game, registry);
  recovered.restore(snapshot, game.getLifecycleToken());
  assertEqual(recovered.phase, "needs_review", "restored timers never automatically fire");
  assertEqual(recovered.snapshot()!.triggers![0].status, "scheduled", "trigger evidence retained");
  await sc.cancel();
  await recovered.cancel();
});

test("Scenario catalogue includes eight planned IDs and advertises only implemented, enabled scenarios", () => {
  assertEqual(plannedScenarios.length, 8, "eight planned scenarios");
  assertEqual(new Set(plannedScenarios.map((d) => d.id)).size, 8, "unique scenario IDs");
  assertEqual(scenarioRegistry.available().length, 7, "all seven gameplay implementations advertised");
  for (const scenario of plannedScenarios) {
    assertEqual(scenarioRegistry.get(scenario.id)?.name, scenario.name, "lookup matches catalogue");
    if (scenario.enabled) assertEqual(scenarioRegistry.requireAvailable(scenario.id).id, scenario.id, `${scenario.id} selectable`);
    else {
      let rejected = false;
      try { scenarioRegistry.requireAvailable(scenario.id); } catch { rejected = true; }
      assert(rejected, `${scenario.id} not selectable before release`);
    }
  }
  let unknown = false;
  try { scenarioRegistry.requireAvailable("no-such-scenario"); } catch { unknown = true; }
  assert(unknown, "unknown scenario cannot activate");
  const enabled = new ScenarioRegistry([definition()]);
  assertEqual(enabled.requireAvailable("fixture").id, "fixture", "enabled implementation selectable");
  const disabled = new ScenarioRegistry([definition({ enabled: false })]);
  assertEqual(disabled.available().length, 0, "disabled implementation hidden");
  let duplicate = false;
  try { new ScenarioRegistry([definition(), definition()]); } catch { duplicate = true; }
  assert(duplicate, "duplicate stable IDs rejected");
});

test("Announcements default to no_elo=false, scenario none, and reject No Elo plus Double Elo", () => {
  const game = GameInstance.getInstance();
  game.reset();
  const command = new AnnouncementCommand() as any;
  const options = (command.data.toJSON() as any).options.find((o: any) => o.name === "start").options;
  const noElo = options.find((o: any) => o.name === "no_elo");
  const scenario = options.find((o: any) => o.name === "scenario");
  assert(noElo && !noElo.required && noElo.type === 5, "optional boolean no_elo");
  assert(scenario && !scenario.required && scenario.choices.length === 8, "all seven scenarios plus None selectable");
  assertEqual(scenario.choices[0].value, "none", "None default");
  assert(!game.organiserNoElo && !game.scenarios.selectedId, "default game is a normal game");
  const values = (preview: boolean) => {
    const fields = command.createGameAnnouncementEmbed(preview).embeds[0].toJSON().fields;
    return Object.fromEntries(fields.map((field: any) => [field.name, field.value]));
  };
  assertEqual(values(true)["🎭 **SCENARIO**"], "None", "preview scenario None");
  assertEqual(
    values(true)["🏅 **ELO**"],
    `**Enabled** (requires ${GameInstance.MIN_ELO_PLAYER_COUNT}+ active players at game start)`,
    "preview default rating eligibility"
  );
  game.reset();
});

test("Announcement rating wording covers all organiser, season and Double Elo choices", () => {
  const game = GameInstance.getInstance();
  game.reset();
  const command = new AnnouncementCommand() as any;
  const attendance = `requires ${GameInstance.MIN_ELO_PLAYER_COUNT}+ active players at game start`;
  const cases = [
    { organiser: false, relaxed: false, double: false, expected: `**Enabled** (${attendance})` },
    { organiser: false, relaxed: false, double: true, expected: `**Enabled — Double Elo** (${attendance})` },
    { organiser: true, relaxed: false, double: false, expected: "**Disabled** (Organiser selected)" },
    { organiser: true, relaxed: false, double: true, expected: "**Disabled** (Organiser selected)" },
    { organiser: false, relaxed: true, double: false, expected: "**Disabled** (Relaxed season)" },
    { organiser: false, relaxed: true, double: true, expected: "**Disabled** (Relaxed season)" },
    { organiser: true, relaxed: true, double: false, expected: "**Disabled** (Organiser selected; Relaxed season)" },
    { organiser: true, relaxed: true, double: true, expected: "**Disabled** (Organiser selected; Relaxed season)" },
  ];
  try {
    game.scenarios.configure("mystery-dungeon");
    for (const c of cases) {
      game.organiserNoElo = c.organiser;
      game.isRelaxedSeason = c.relaxed;
      game.isDoubleElo = c.double;
      // Before the game starts, zero active players must not imply a
      // permanently unrated game. Also cover stale effective No Elo state.
      game.refreshNoElo();
      for (const preview of [true, false]) {
        const embed = command.createGameAnnouncementEmbed(preview).embeds[0].toJSON();
        const elo = embed.fields.find((f: any) => f.name === "🏅 **ELO**");
        assertEqual(elo?.value, c.expected, "correct rating wording");
        assert(!embed.fields.some((f: any) => f.name.includes("NO ELO")), "no double-negative label");
        const eligibleDouble = c.double && !c.organiser && !c.relaxed;
        assertEqual(embed.description.includes("Double Elo planned"), eligibleDouble, "conditional Double Elo banner");
        assertEqual(embed.description.includes("Relaxed season"), c.relaxed, "relaxed season marker retained");
        if (eligibleDouble) {
          assert(embed.description.includes("attendance requirement"), "banner does not guarantee Double Elo");
        }
        assert(game.noElo, "rendering leaves effective rating state unchanged");
      }
    }
  } finally {
    game.reset();
  }
});

test("Announcement start validates choices before modifying the game and saves explicit No Elo in preview", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const command = new AnnouncementCommand() as any;
  const replies: any[] = [];
  const values: Record<string, string | boolean | null> = {
    scenario: "none", doubleelo: "yes", modifiers: "none",
  };
  const interaction = {
    deferReply: async () => {},
    editReply: async (payload: any) => {
      replies.push(payload);
      return { id: "preview", edit: async () => {} };
    },
    options: {
      getBoolean: (name: string) => values[name] ?? null,
      getString: (name: string) => values[name] ?? null,
    },
  } as any;
  // Stub only unrelated Discord/map/date/season dependencies, not the option logic.
  command.setMap = async () => true;
  command.setDate = async () => true;
  command.setBannedClasses = async () => true;
  command.configureModifierMode = () => {};
  const previous = SeasonService.requireActiveSeason;
  (SeasonService as any).requireActiveSeason = async () => ({ type: SeasonType.RANKED });
  try {
    values.no_elo = true;
    await command.handleAnnouncementStart(interaction);
    assert(String(replies.at(-1)).includes("cannot be enabled together"), "explicit No Elo and Double Elo refused");
    assert(!game.organiserNoElo && !game.scenarios.selectedId, "conflict does not create a proposal");

    values.doubleelo = null;
    values.scenario = "mystery-dungeon";
    await command.handleAnnouncementStart(interaction);
    assertEqual(game.scenarios.selectedId, "mystery-dungeon", "implemented scenario is configurable");
    // Finish inspecting the selected-mode preview before testing a separate
    // announcement. Starting a second preview in the same match is forbidden.
    game.reset();
    command.announcementPreviewMessage = undefined;

    values.scenario = "none";
    await command.handleAnnouncementStart(interaction);
    assert(game.organiserNoElo && game.noElo, "valid No Elo selection saved");
    assert(!game.isDoubleElo, "no rating multiplier applied");
    const embedFields = replies.at(-1).embeds[0].toJSON().fields;
    assertEqual(
      embedFields.find((f: any) => f.name === "🏅 **ELO**")?.value,
      "**Disabled** (Organiser selected)",
      "No Elo displayed clearly in preview"
    );
    game.beginConfirmedAnnouncement();
    assert(game.organiserNoElo && game.noElo, "confirmation preserves No Elo");
  } finally {
    (SeasonService as any).requireActiveSeason = previous;
    command.announcementPreviewMessage = undefined;
    await CurrentGameManager.resetCurrentGame();
  }
});

test("No Elo remains additive through attendance rules, relaxed seasons and confirmed announcements", () => {
  const game = GameInstance.getInstance();
  try {
    for (let i = 0; i < 20; i++) {
      const team = i % 2 ? "RED" : "BLUE";
      game.teams[team].push({ discordSnowflake: String(1000 + i) } as any);
    }
    assertEqual(game.refreshNoElo(), false, "ranked full roster rated");
    game.organiserNoElo = true;
    assertEqual(game.refreshNoElo(), true, "full roster explicit No Elo");
    game.organiserNoElo = false;
    game.isRelaxedSeason = true;
    assertEqual(game.refreshNoElo(), true, "relaxed season unrated");
    game.isRelaxedSeason = false;
    game.teams.RED.pop();
    assertEqual(game.refreshNoElo(), true, "low player count unrated");
    game.organiserNoElo = true;
    assertEqual(game.refreshNoElo(), true, "explicit No Elo and low attendance unrated");
    game.beginConfirmedAnnouncement();
    assert(game.organiserNoElo && game.noElo, "confirmation cannot clear organiser-selected No Elo");
    assertEqual(game.scenarios.selectedId, null, "ordinary game has no scenario");
  } finally { game.reset(); }
});

test("Coordinator enforces ownership, phases, private submissions, deadlines and lifecycle tokens", async () => {
  const { game, coordinator: sc, newMatch, roster } = fakeCoordinator();
  sc.configure("fixture");
  assertEqual(sc.phase, "configured", "selected but not announced");
  assert(sc.automationBlock("teams") !== null, "configuration reserves its team-selection stage");
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  assertEqual(sc.phase, "collecting", "announced scenario collects");
  assert(sc.automationBlock("teams") !== null, "normal team automation is suppressed");
  assert(sc.automationBlock("draft") !== null, "ordinary draft suppressed");
  assert(sc.automationBlock("captains") === null, "captains unaffected by team-only scenario");
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const customId = sc.openAction({
    id: "quiz1", kind: "questionnaire", ownerId: "1002",
    role: "participant", deadline, allowUpdates: true,
  });
  assert(customId.includes(game.getLifecycleToken()), "custom ID bound to game");
  let rejected = 0;
  try { sc.submitAction(customId, "1001", "wrong person"); } catch { rejected++; }
  assertEqual(sc.submitAction(customId, "1002", "answer"), "Choice saved; you may update it before the deadline.", "private answer");
  try { sc.submitAction(customId, "1002", "answer"); } catch { rejected++; }
  assertEqual(sc.submitAction(customId, "1002", "new answer").includes("saved"), true, "editable answer");
  assertEqual(rejected, 2, "cross-user and duplicate submissions rejected");
  const once = sc.openAction({ id: "single", kind: "vote", ownerId: "1001", role: "captain", deadline, allowUpdates: false });
  sc.submitAction(once, "1001", "vote");
  try { sc.submitAction(once, "1001", "again"); } catch { rejected++; }
  const expired = sc.openAction({ id: "expired", kind: "vote", ownerId: "1002", role: "participant", deadline: new Date(Date.now() - 1).toISOString(), allowUpdates: true });
  try { sc.submitAction(expired, "1002", "late"); } catch { rejected++; }
  const organiser = sc.openAction({ id: "organiser", kind: "approve", ownerId: "1001", role: "organiser", deadline, allowUpdates: false });
  try { sc.submitAction(organiser, "1001", true, false); } catch { rejected++; }
  sc.submitAction(organiser, "1001", true, true);
  assertEqual(rejected, 5, "duplicate, expired and permission checks");
  roster.splice(1, 1);
  await sc.onRegistrationChanged("1002", false);
  assert(!sc.snapshot()!.actions.some((a) => a.ownerId === "1002"), "unregistration clears private actions");
  sc.markReady({ result: "balanced" });
  assertEqual(sc.phase, "ready", "ready after processing");
  assert(sc.startBlock() !== null, "match start is blocked until complete");
  sc.complete();
  assertEqual(sc.startBlock(), null, "completed preparation permits start");
  assertEqual(sc.automationBlock("teams"), null, "automation ownership released");
  newMatch();
  assert(sc.startBlock() !== null, "old scenario cannot authorise new game start");
  try { sc.submitAction(customId, "1002", "old"); } catch { rejected++; }
  assertEqual(rejected, 6, "old game interaction rejected");
});

test("Captain-only and restrictions-only scenarios reserve the right automation stages", () => {
  const { game, newMatch } = fakeCoordinator();
  const captains = new ScenarioCoordinator(game, new ScenarioRegistry([
    definition({ capabilities: { captains: true, normalDraft: true } }),
  ]));
  captains.configure("fixture");
  (game as any).announced = true;
  newMatch();
  captains.confirmAnnouncement();
  assert(captains.automationBlock("captains") !== null, "captain election blocks captain selection");
  assert(captains.automationBlock("draft") !== null, "captain election blocks an early normal draft");
  assert(captains.automationBlock("teams") === null, "captain election alone does not own team generation");
  captains.complete();
  assertEqual(captains.automationBlock("draft"), null, "normal draft unblocked after election");

  (game as any).announced = false;
  const restrictions = new ScenarioCoordinator(game, new ScenarioRegistry([
    definition({ capabilities: { requiresFinalTeams: true }, category: "gameplay-restriction", stage: "pre-game" }),
  ]));
  restrictions.configure("fixture");
  (game as any).announced = true;
  newMatch();
  restrictions.confirmAnnouncement();
  assertEqual(restrictions.automationBlock("captains"), null, "Class Hex does not own captains");
  assertEqual(restrictions.automationBlock("teams"), null, "Class Hex does not own team generation");
  assertEqual(restrictions.automationBlock("draft"), null, "Class Hex does not own drafting");
  assert(restrictions.startBlock() !== null, "Class Hex preparation still required");
  restrictions.invalidateTeams();
  assertEqual(restrictions.phase, "needs_review", "pre-game restrictions invalidated by team reset");
});

test("Scenario recovery never replays collectors and preserves validated payload", async () => {
  const { game, registry, coordinator: sc, newMatch } = fakeCoordinator();
  sc.configure("fixture", { mode: "test" });
  (game as any).announced = true;
  newMatch();
  sc.confirmAnnouncement();
  sc.openAction({ id: "choice", kind: "vote", ownerId: "1001", role: "participant", deadline: new Date(Date.now() + 10_000).toISOString(), allowUpdates: true });
  const snapshot = sc.snapshot()!;
  validateScenarioState(snapshot, registry);
  const restored = new ScenarioCoordinator(game, registry);
  restored.restore(snapshot, game.getLifecycleToken());
  assertEqual(restored.phase, "needs_review", "recovery cannot silently resume");
  assert(restored.startBlock() !== null, "unfinished scenario blocks start");
  assertEqual(restored.snapshot()!.actions.length, 0, "private collectors invalidated");
  restored.resumeAfterReview();
  assertEqual(restored.phase, "collecting", "manual review can resume with fresh interaction tokens");
  await restored.cancel();
  assertEqual(restored.selectedId, null, "cancel clears match state");
  await restored.cancel();
  let rejected = false;
  try { restored.restore({ ...snapshot, gameToken: randomUUID() }, game.getLifecycleToken()); } catch { rejected = true; }
  assert(rejected, "cross-game scenario snapshot rejected");
});

test("Captain-election result safely assigns confirmed captains through the shared roster lock", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const original = game.scenarios;
  const registry = new ScenarioRegistry([definition({
    category: "captain-selection", stage: "captains", capabilities: { captains: true, normalDraft: true },
  })]);
  (game as any).scenarios = new ScenarioCoordinator(game, registry);
  try {
    game.scenarios.configure("fixture");
    game.beginConfirmedAnnouncement();
    const guild = new FakeGuild();
    game.teams.UNDECIDED = ["1001", "1002", "1003"].map((id) => ({
      playerId: id, discordSnowflake: id, captain: false, ignUsed: id,
    } as any));
    for (const id of ["1001", "1002", "1003"]) guild.addMember(new FakeGuildMember(id));
    game.scenarios.markReady({ result: "voted" });
    const command = new TeamCommand();
    await command.confirmScenarioCaptains(guild as any, "1001", "1002");
    assertEqual(game.scenarios.phase, "completed", "captain scenario completed");
    assertEqual(game.getCaptainOfTeam("RED")?.discordSnowflake, "1001", "red captain from election");
    assertEqual(game.getCaptainOfTeam("BLUE")?.discordSnowflake, "1002", "blue captain from election");
    assert(game.getPlayersOfTeam("UNDECIDED").length === 1, "other participants remain eligible for draft");
    assert(guild.members.cache.get("1001")!.roles.cache.has(ConfigManager.getConfig().roles.captainRole), "captain role granted");
    assert(guild.members.cache.get("1002")!.roles.cache.has(ConfigManager.getConfig().roles.blueTeamRole), "team role granted");
    assertEqual(game.scenarios.automationBlock("draft"), null, "normal draft is now permitted");
  } finally {
    game.reset();
    (game as any).scenarios = original;
  }
});

test("People's Captains opens ballots for all players, preserves votes through review and confirms a replacement", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const original = game.scenarios;
  const originalCommand = TeamCommand.instance;
  const savedFeed = Channels.gameFeed;
  const sc = new ScenarioCoordinator(game);
  (game as any).scenarios = sc;
  const guild = new FakeGuild();
  const ids = ["1001", "1002", "1003", "1004", "1005", "1006"];
  const published: any[] = [];
  const client = { users: { fetch: async () => ({ send: async () => { throw new Error("DMs closed"); } }) } };
  Channels.gameFeed = { guild, client, send: async (message: any) => published.push(message) } as any;
  const command = new TeamCommand();
  try {
    await withScenarioClock(sc, async ({ advanceTo }) => {
      sc.configure("peoples-captains");
      game.startTime = new Date(Date.now() + 35 * 60_000);
      game.beginConfirmedAnnouncement();
      game.teams.UNDECIDED = ids.map((id) => ({ playerId: id, discordSnowflake: id, captain: false, ignUsed: id, elo: 1000 } as any));
      ids.forEach((id) => guild.addMember(new FakeGuildMember(id)));
      assertEqual(await sc.registrationPrompt(ids[0]), null, "no volunteering interaction");
      await sc.activateTrigger("election", "manual", guild as any);
      const first = sc.snapshot()!;
      assertEqual(first.actions.length, ids.length, "every registered player receives an action");
      assertEqual(first.prompts!.filter((p) => p.status === "failed").length, ids.length, "failed DMs are recorded");
      const frozen = first.data.ballots as Record<string, string[]>;
      const voter = ids[0];
      const action = first.actions.find((a) => a.ownerId === voter)!;
      const oldId = `fwsc:${game.getLifecycleToken()}:${action.id}:${voter}`;
      const firstPrompt = await sc.reopenAction(voter);
      assert(firstPrompt?.content.includes("your ballot"), "failed DM can reopen privately");
      await sc.applyAction(oldId, voter, ["vote:" + frozen[voter][0]]);
      sc.restore(sc.snapshot(), game.getLifecycleToken());
      assertEqual(sc.phase, "needs_review", "restart pauses voting");
      sc.resumeAfterReview();
      assertEqual(JSON.stringify(sc.snapshot()!.data.ballots), JSON.stringify(frozen), "ballots preserved across restart");
      assertEqual((sc.snapshot()!.data.votes as Record<string, string>)[voter], frozen[voter][0], "vote preserved");
      let stale = false;
      try { await sc.applyAction(oldId, voter, ["vote:" + frozen[voter][1]]); } catch { stale = true; }
      assert(stale, "old DM controls invalid after restart");
      // Choose at least three different candidates to ensure a supported replacement exists.
      const selected = new Set<string>();
      for (const a of sc.snapshot()!.actions) {
        const choices = frozen[a.ownerId];
        const pick = choices.find((id) => !selected.has(id)) ?? choices[0];
        selected.add(pick);
        if ((sc.snapshot()!.data.votes as Record<string, string>)[a.ownerId] !== pick)
          await sc.applyAction(`fwsc:${game.getLifecycleToken()}:${a.id}:${a.ownerId}`, a.ownerId, ["vote:" + pick]);
      }
      assert(selected.size >= 3, "replacement has real support");
      let earlyClose = false;
      try { await sc.activateTrigger("close", "manual", guild as any); } catch { earlyClose = true; }
      assert(earlyClose, "even full turnout cannot shorten the advertised voting window");
      assertEqual(sc.phase, "collecting", "voters can still change their vote");
      advanceTo(game.startTime!.getTime() - 20 * 60_000);
      await sc.activateTrigger("close", "manual", guild as any);
      assertEqual(sc.phase, "ready", "automatic tally is ready for review");
      const result = sc.snapshot()!;
      const red = result.data.captainRed as string;
      const blue = result.data.captainBlue as string;
      assert(red !== blue, "elected captains distinct");
      const revision = sc.controlRevision;
      game.teams.UNDECIDED = game.teams.UNDECIDED.filter((p) => p.discordSnowflake !== red);
      await sc.onRegistrationChanged(red, false);
      assertEqual(sc.phase, "needs_review", "departing captain invalidates result controls");
      let staleReview = false;
      try { sc.reviewElectionRoster(revision, "RED"); } catch { staleReview = true; }
      assert(staleReview, "old replacement controls rejected");
      sc.reviewElectionRoster(sc.controlRevision, "RED");
      const next = sc.snapshot()!;
      assert(next.data.captainRed !== red && next.data.captainRed !== blue, "next supported registered candidate replaces unavailable captain");
      assertEqual(next.data.captainBlue, blue, "other winner preserved");
      await command.confirmScenarioCaptains(guild as any, next.data.captainRed as string, blue, sc.controlRevision);
      assertEqual(sc.phase, "completed", "organiser confirmation completes election");
      assertEqual(sc.automationBlock("draft"), null, "normal draft released");
      assert(published.every((message) => !JSON.stringify(message).includes("vote:")), "no individual ballot choices published");
    });
  } finally {
    game.reset();
    (game as any).scenarios = original;
    TeamCommand.instance = originalCommand;
    Channels.gameFeed = savedFeed;
  }
});

test("People's Captains rejects legacy volunteer snapshots and blocks changed voting rosters", async () => {
  const { game, roster } = fakeCoordinator();
  (game as any).getCaptainOfTeam = () => null;
  const sc = new ScenarioCoordinator(game);
  (game as any).scenarios = sc;
  try {
    sc.configure("peoples-captains");
    game.announced = true;
    sc.confirmAnnouncement();
    const legacy = sc.snapshot()!;
    legacy.version = 1;
    legacy.triggers!.push({ id: "candidate", status: "active" });
    sc.restore(legacy, game.getLifecycleToken());
    assertEqual(sc.phase, "needs_review", "legacy snapshot is reviewable");
    let refused = false;
    try { sc.resumeAfterReview(); } catch { refused = true; }
    assert(refused, "legacy candidate slate never silently reused");
    await sc.cancel();
    game.announced = false;
    sc.configure("peoples-captains");
    game.announced = true;
    sc.confirmAnnouncement();
    sc.setData("slate", roster.map((p) => p.discordSnowflake));
    const state = sc.snapshot()!;
    state.triggers![0].rosterIds = roster.map((p) => p.discordSnowflake);
    sc.restore(state, game.getLifecycleToken());
    roster.push({ discordSnowflake: "1003", captain: false });
    refused = false;
    try { sc.resumeAfterReview(); } catch { refused = true; }
    assert(refused, "changed or incomplete frozen roster never reruns silently");
  } finally { sc.reset(); }
});

test("Cancelling a scenario team preview does not apply team assignments", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const original = game.scenarios;
  (game as any).scenarios = new ScenarioCoordinator(game, new ScenarioRegistry([definition()]));
  try {
    game.scenarios.configure("fixture");
    game.beginConfirmedAnnouncement();
    game.teams.UNDECIDED = ["1001", "1002"].map((id) => ({
      playerId: id, discordSnowflake: id, ignUsed: id, captain: false, elo: 1000,
    } as any));
    game.scenarios.markReady();
    const session = new ScenarioTeamPickingSession({
      red: ["1001"], blue: ["1002"], undecided: [], method: "BALANCE",
    });
    let acknowledged = false;
    await session.handleInteraction({
      customId: "scenario-team-cancel",
      update: async () => { acknowledged = true; },
    } as any);
    assert(acknowledged && session.getState() === "cancelled", "preview cancellation acknowledged");
    assertEqual(game.getPlayersOfTeam("RED").length, 0, "no RED assignment without confirmation");
    assertEqual(game.getPlayersOfTeam("BLUE").length, 0, "no BLUE assignment without confirmation");
    assertEqual(game.getPlayersOfTeam("UNDECIDED").length, 2, "registered participants retained");
    assertEqual(game.scenarios.phase, "needs_review", "cancelled preview requires organiser review");
  } finally {
    game.reset();
    (game as any).scenarios = original;
  }
});

test("Scenario proposal uses shared TeamCommand roster lock and role synchronisation", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const original = game.scenarios;
  const registry = new ScenarioRegistry([definition()]);
  (game as any).scenarios = new ScenarioCoordinator(game, registry);
  try {
    game.scenarios.configure("fixture");
    game.beginConfirmedAnnouncement();
    const members = ["1001", "1002", "1003", "1004"];
    game.teams.UNDECIDED = members.map((id) => ({
      playerId: `p${id}`, discordSnowflake: id, ignUsed: `IGN${id}`,
      elo: 1000, captain: false,
    } as any));
    game.scenarios.markReady();
    const proposal = { red: ["1001", "1002"], blue: ["1003", "1004"], undecided: [],
      captains: { red: "1001", blue: "1003" }, method: "ELO" as const };
    const session = new ScenarioTeamPickingSession(proposal);
    const command = new TeamCommand();
    command.teamPickingSession = session;
    const guild = new FakeGuild();
    for (const id of [...members, "9999"]) guild.addMember(new FakeGuildMember(id));
    const organiser = guild.members.cache.get("9999")!;
    await organiser.roles.add(ConfigManager.getConfig().roles.organiserRole);
    let followup = 0;
    await command.handleButtonPress({
      customId: "scenario-team-accept", user: { id: "9999" }, guild,
      update: async () => {},
      followUp: async () => { followup++; },
      reply: async () => { throw new Error("Should not reject organiser"); },
    } as any);
    assertEqual(game.teamsDecidedBy, "ELO", "existing team finalisation records method");
    assertEqual(game.scenarios.phase, "completed", "scenario completed on confirmation");
    assertEqual(game.teams.RED.length, 2, "RED assigned exactly");
    assertEqual(game.teams.BLUE.length, 2, "BLUE assigned exactly");
    assert(game.getCaptainOfTeam("RED")?.discordSnowflake === "1001", "red captain preserved");
    assert(game.getCaptainOfTeam("BLUE")?.discordSnowflake === "1003", "blue captain preserved");
    assertEqual(followup, 1, "start prompt issued after role sync");
    assert(guild.members.cache.get("1001")!.roles.cache.has(ConfigManager.getConfig().roles.captainRole), "captain role synchronised");
    assert(guild.members.cache.get("1001")!.roles.cache.has(ConfigManager.getConfig().roles.redTeamRole), "red role synchronised");
    assert(guild.members.cache.get("1004")!.roles.cache.has(ConfigManager.getConfig().roles.blueTeamRole), "blue role synchronised");
  } finally {
    game.reset();
    (game as any).scenarios = original;
  }
});

test("Scenario editors track real completion and reject stale private controls", async () => {
  const { game } = fakeCoordinator();
  const sc = new ScenarioCoordinator(game);
  (game as any).scenarios = sc;
  const owner = "1002";
  await withScenarioClock(sc, async () => {
    sc.configure("mystery-dungeon");
    game.announced = true;
    game.startTime = new Date(Date.now() + 45 * 60_000);
    sc.confirmAnnouncement();
    const first = await sc.registrationPrompt(owner);
    const idOf = (prompt: any) => prompt.components[0].toJSON().components[0].custom_id as string;
    const originalId = idOf(first);
    const second = await sc.applyAction(originalId, owner, ["answer:0:1"]);
    assert(typeof second !== "string" && second.content.includes("not yet submitted"), "first answer is progress only");
    assertEqual(sc.snapshot()!.prompts![0].status, "delivered", "intermediate choice is not complete");
    assert(!sc.snapshot()!.actions[0].submittedAt, "no final submission timestamp");
    let rejected = false;
    try { await sc.applyAction(originalId, owner, ["answer:0:0"]); } catch { rejected = true; }
    assert(rejected, "old editor cannot mutate a later step");
    let prompt = second;
    for (let i = 1; i < 5; i++)
      prompt = await sc.applyAction(idOf(prompt), owner, [`answer:${i}:1`]);
    prompt = await sc.applyAction(idOf(prompt), owner, ["submit"]);
    assert(typeof prompt !== "string" && prompt.content.includes("Submission saved"), "explicit confirmation");
    assertEqual(sc.snapshot()!.prompts![0].status, "completed", "only full submission counted");
    assert(sc.triggerStatus().includes("1/1 complete"), "dashboard counts true completion");
    const edited = await sc.applyAction(idOf(prompt), owner, ["edit"]);
    assert(typeof edited !== "string" && edited.content.includes("not yet submitted"), "editing reopens the task");
    assertEqual(sc.snapshot()!.prompts![0].status, "delivered", "completion is reversible while editable");
  });
});

test("Scenario targeted delivery and one-shot reminders remain private and match-bound", async () => {
  const { game, newMatch } = fakeCoordinator();
  const sc = new ScenarioCoordinator(game);
  (game as any).scenarios = sc;
  const saved = Channels.gameFeed;
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("1002"));
  let fail = true;
  let attempts = 0;
  const dm: any[] = [];
  const publicMessages: any[] = [];
  const client = { users: { fetch: async (id: string) => {
    assertEqual(id, "1002", "DM targets only assigned participant");
    return { send: async (message: any) => {
      attempts++;
      if (fail) throw new Error("DMs closed");
      dm.push(message);
    } };
  } } };
  (guild as any).client = client;
  Channels.gameFeed = { guild, client, send: async (message: any) => publicMessages.push(message) } as any;
  try {
    await withScenarioClock(sc, async ({ tasks, advanceTo }) => {
      sc.configure("mystery-dungeon");
      game.announced = true;
      game.startTime = new Date(Date.now() + 45 * 60_000);
      sc.confirmAnnouncement();
      const result = await deliverScenarioAction(game, "1002", client as any);
      assertEqual(result, "failed", "closed DMs reported");
      assertEqual(sc.snapshot()!.prompts![0].status, "failed", "delivery failure recorded");
      assertEqual(publicMessages.length, 1, "one safe public fallback");
      assert(!publicMessages[0].content.includes("Question 1"), "fallback contains no private editor");
      const id = sc.snapshot()!.actions[0].id;
      const reminderId = `scenario-reminder:${game.getLifecycleToken()}:${id}`;
      const original = tasks.get(reminderId)!;
      assert(!!original, "incomplete choice has a reminder");
      game.startTime = new Date(Date.now() + 55 * 60_000);
      sc.syncTriggerSchedule();
      const replacement = tasks.get(reminderId)!;
      assert(replacement.at > original.at, "reminder moves with registration cutoff");
      advanceTo(original.at);
      await original.callback();
      assertEqual(attempts, 1, "stale scheduled reminder cannot send");
      fail = false;
      advanceTo(replacement.at);
      await replacement.callback();
      assertEqual(dm.length, 1, "one private reminder delivered");
      assert(dm[0].content.includes("Scenario reminder"), "reminder identifies outstanding task");
      assertEqual(sc.snapshot()!.prompts![0].status, "delivered", "successful retry clears delivery failure");
      await replacement.callback();
      assertEqual(dm.length, 1, "duplicate callback cannot send again");
      await sc.cancel();
      newMatch();
      await replacement.callback();
      assertEqual(dm.length, 1, "cancelled or replaced game cannot notify old player");
    });
  } finally { Channels.gameFeed = saved; }
});

test("Scenario dashboard and targeted open reject non-organisers and obsolete review controls", async () => {
  const { game } = fakeCoordinator();
  const registry = new ScenarioRegistry([definition({
    triggers: [{ id: "lock", type: "manual", manual: true }],
    implementation: { activateTrigger: () => { throw new Error("must not run"); } },
  })]);
  const sc = new ScenarioCoordinator(game, registry);
  (game as any).scenarios = sc;
  const guild = new FakeGuild();
  const member = new FakeGuildMember("1002");
  guild.addMember(member);
  const saved = Channels.gameFeed;
  Channels.gameFeed = { guild } as any;
  try {
    sc.configure("fixture");
    game.announced = true;
    sc.confirmAnnouncement();
    const id = `fwscpanel:${game.getLifecycleToken()}:start:lock:${sc.controlRevision}`;
    const errors: any[] = [];
    const interaction = {
      customId: id, guild, user: { id: "1002" },
      reply: async (message: any) => { errors.push(message); },
      deferUpdate: async () => { interaction.deferred = true; },
      followUp: async (message: any) => { errors.push(message); },
      deferred: false, replied: false,
    };
    await handleScenarioDashboard(game, interaction as any);
    assert(errors[0].content.includes("Only organisers"), "ordinary player cannot use dashboard");
    const command = new GameCommand();
    await command.execute({
      guild, user: { id: "1002" },
      options: { getSubcommand: () => "open", getSubcommandGroup: () => "scenario", getUser: () => ({ id: "1001" }) },
      reply: async (message: any) => { errors.push(message); },
    } as any);
    assert(errors[1].content.includes("Only organisers"), "ordinary player cannot resend another editor");
    await member.roles.add(ConfigManager.getConfig().roles.organiserRole);
    sc.needsReview("old result");
    sc.resumeAfterReview();
    await handleScenarioDashboard(game, interaction as any);
    assert(errors[2].content.includes("changed"), "stale dashboard cannot start replacement stage");
    assertEqual(sc.phase, "collecting", "no mutation from rejected controls");
  } finally { sc.reset(); Channels.gameFeed = saved; }
});
