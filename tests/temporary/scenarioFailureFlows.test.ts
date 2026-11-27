import { AnniClass } from "@prisma/client";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { configureHexPool, reportUnavailableClass } from "../../src/logic/scenarios/classHex/ClassHex";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";
import { fixture, normalDraft, rejects, snapshot, wire } from "./scenarioMatchFlows.test";

test("FLOW Low turnout: scheduled Mystery Dungeon lock cancels one-player announcement before allocation", async () => fixture("mystery-dungeon", 1, async f => {
  const { game, guild } = f;
  const token = game.getLifecycleToken();
  const clean = DiscordUtil.cleanUpAllChannelMessages;
  DiscordUtil.cleanUpAllChannelMessages = async () => {};
  try {
    CurrentGameManager.scheduleCaptainTimers(guild);
    const lock = [...f.jobs.entries()].find(([id]: any) => id.endsWith(":lock")) as any;
    assert(lock, "scenario lock scheduled at attendance deadline");
    await f.fire(":lock");
    assert(!game.announced, "under-attended match cancelled");
    assertEqual(game.scenarios.snapshot(), null, "no scenario survives cancellation");
    assert(game.getLifecycleToken() !== token, "obsolete match invalidated");
    assert(f.published.some((m: any) => typeof m === "string" && m.includes("automatically cancelled")), "cancellation communicated");
    game.scenarios.configure("partners-in-crime");
    game.beginConfirmedAnnouncement();
    await game.scenarios.onAnnounced();
    assertEqual(game.scenarios.selectedId, "partners-in-crime", "subsequent announcement succeeds");
    await lock[1].callback();
    assertEqual(game.scenarios.selectedId, "partners-in-crime", "obsolete job cannot affect next match");
  } finally {
    DiscordUtil.cleanUpAllChannelMessages = clean;
    await CurrentGameManager.resetCurrentGame();
  }
}));

test("FLOW People's Captains: insufficient ballots fail safely, organiser fallback completes match", async () => fixture("peoples-captains", 20, async f => {
  const { game, ids } = f;
  game.scenarios.syncTriggerSchedule(Date.now(), f.guild);
  await f.fire(":election");
  await f.act(ids[0], "vote:" + snapshot(game).data.ballots[ids[0]][0]);
  await f.fire(":close");
  assertEqual(game.scenarios.phase, "needs_review", "low turnout requires review");
  assert(game.scenarios.startBlock(), "cannot start with incomplete election");
  assert(!game.getCaptainOfTeam("RED") && !game.getCaptainOfTeam("BLUE"), "no fabricated elected captains");
  await game.scenarios.cancel();
  f.captains();
  await normalDraft(f);
  await f.end();
}));

for (const id of ["masked-draft", "draft-roulette"]) {
  test("FLOW " + id + ": roster mutation cancels draft, stale control rejected, normal fallback completes", async () => fixture(id, 20, async f => {
    const { game, command, ids } = f;
    f.captains();
    await game.scenarios.activateTrigger("draft", "manual", f.guild);
    const session = command.teamPickingSession;
    const p = snapshot(game).data.draft;
    const c = wire(session.turnControls())[0];
    const actor = p.first === "RED" ? p.redCaptain : p.blueCaptain;
    const message = session.turnMessage;
    // Use the production draft session's withdrawal and registration hooks.
    const removed = ids[ids.length - 1];
    game.teams.UNDECIDED = game.teams.UNDECIDED.filter((p: any) => p.discordSnowflake !== removed);
    await game.scenarios.onRegistrationChanged(removed, false);
    await session.handleUnregister();
    assertEqual(session.getState(), "cancelled", "changed draft cancelled");
    assertEqual(game.scenarios.phase, "needs_review", "organiser review needed");
    let refused = false;
    await session.handleControl({
      customId: c.custom_id, message, user: { id: actor }, values: [c.options[0].value],
      isStringSelectMenu: () => true, isButton: () => false, deferUpdate: async () => {},
      reply: async () => { refused = true; },
    });
    assert(refused, "obsolete offer cannot allocate");
    await game.scenarios.cancel();
    await command.resetTeamPickingSession();
    await f.join(removed, ids.length - 1);
    await normalDraft(f);
    await f.end();
  }));
}

test("FLOW Cursed Classes: inaccessible assignment blocks start; cancelling overlay preserves playable teams", async () => fixture("class-hex", 20, async f => {
  const { game } = f;
  f.captains();
  configureHexPool(game, Object.values(AnniClass).slice(0, 5).join(","), f.organiser.id);
  await normalDraft(f);
  for (const side of ["RED", "BLUE"] as const) {
    const captain = game.getCaptainOfTeam(side).discordSnowflake;
    const targets = game.teams[side === "RED" ? "BLUE" : "RED"].slice(0, 3);
    for (const p of targets) await f.act(captain, p.discordSnowflake);
    await f.act(captain, "submit");
  }
  const assignment = game.scenarios.publicMatchMetadata().assignments[0];
  reportUnavailableClass(game, assignment.player);
  assertEqual(game.scenarios.phase, "needs_review", "unavailable class cannot be ignored");
  await rejects(() => f.start(), "actual game start blocked");
  assertEqual(game.getGameStartStatus(), "idle", "blocked start does not mutate lifecycle");
  const before = game.getPlayers().map((p: any) => p.discordSnowflake).sort().join(",");
  await game.scenarios.cancel();
  assertEqual(game.getPlayers().map((p: any) => p.discordSnowflake).sort().join(","), before, "fallback preserves roster");
  await f.end();
}));
