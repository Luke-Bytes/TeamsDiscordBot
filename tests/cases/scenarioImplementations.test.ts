import { randomUUID } from "node:crypto";
import type { GameInstance } from "../../src/database/GameInstance";
import { ScenarioRegistry, scenarioRegistry } from "../../src/logic/scenarios/ScenarioRegistry";
import { ScenarioCoordinator, validateScenarioState } from "../../src/logic/scenarios/ScenarioCoordinator";
import { allocateScenarioTeams } from "../../src/logic/scenarios/ScenarioTeamAllocation";
import { classify, mysteryDungeon } from "../../src/logic/scenarios/mysteryDungeon/MysteryDungeon";
import { mutualPairs, partnersInCrime } from "../../src/logic/scenarios/partnersInCrime/PartnersInCrime";
import { createBalancedBallots, tallyElection, peoplesCaptains } from "../../src/logic/scenarios/peoplesCaptains/PeoplesCaptains";
import { maskedCards, rouletteOffer, snakeTurn } from "../../src/logic/scenarios/drafts/ScenarioDraftRules";
import { maskedDraft, draftRoulette } from "../../src/logic/scenarios/drafts/DraftScenarios";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { captainsWildcards } from "../../src/logic/scenarios/captainsWildcards/CaptainsWildcards";
import { classHex, configureHexPool, eligibleClasses, reportUnavailableClass } from "../../src/logic/scenarios/classHex/ClassHex";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

type Player = { discordSnowflake: string; elo: number; ignUsed: string; captain: boolean };
function fixture(count: number, captains = false) {
  const players: Player[] = Array.from({ length: count }, (_, i) => ({
    discordSnowflake: (100000000000000000n + BigInt(i)).toString(),
    elo: 800 + (i % 4) * 150, ignUsed: `Test${i}`,
    captain: captains && i < 2,
  }));
  const token = randomUUID();
  const sides: Record<string, Player[]> = {
    RED: captains ? [players[0]] : [],
    BLUE: captains ? [players[1]] : [],
    UNDECIDED: captains ? players.slice(2) : [...players],
  };
  let state: Record<string, any> = {};
  let phase: string = "collecting";
  let scenarioId = "mystery-dungeon";
  let reviewed = "";
  const game = {
    announced: false, isFinished: false,
    teams: sides,
    settings: {
      organiserBannedClasses: [], sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { RED: [], BLUE: [] }, modifiers: [],
    },
    getPlayers: () => Object.values(sides).flat(),
    getPlayersOfTeam: (team: string) => sides[team],
    getPlayersTeam: (p: Player) =>
      sides.RED.includes(p) ? "RED" : sides.BLUE.includes(p) ? "BLUE" : "UNDECIDED",
    getCaptainOfTeam: (team: string) => sides[team].find((p) => p.captain),
    getGameStartStatus: () => "idle",
    hasFinalizedPlayableTeams: () => sides.RED.length && sides.BLUE.length,
    getLifecycleToken: () => token,
    scenarios: {
      snapshot: () => ({ data: structuredClone(state), phase }),
      setData: (key: string, value: any) => { state[key] = structuredClone(value); },
      get selectedId() { return scenarioId; },
      get phase() { return phase; },
      needsReview: (reason: string) => { reviewed = reason; phase = "needs_review"; },
      complete: () => { phase = "completed"; },
    },
  } as unknown as GameInstance;
  return {
    game, players, sides,
    setPhase: (p: string) => { phase = p; },
    setScenario: (s: string) => { scenarioId = s; },
    data: () => state,
    reviewed: () => reviewed,
  };
}
function responseAction(owner: string, kind: string, value: string, id = "a") {
  return { id, kind, ownerId: owner, role: "participant" as const, phase: "collecting" as const,
    deadline: new Date(Date.now() + 60_000).toISOString(), allowUpdates: true, response: [value] };
}
function throws(task: () => unknown, why: string) {
  let rejected = false;
  try { task(); } catch { rejected = true; }
  assert(rejected, why);
}
test("Mystery Dungeon scores exactly five complete answers and deterministically resolves ties", async () => {
  assertEqual(classify([0, 0, 1, 2, 3]), "Guardian", "two Guardians win");
  assertEqual(classify([0, 1, 2, 3, 1]), "Pathfinder", "Pathfinder majority");
  assertEqual(classify([1, 0, 2, 3, 0]), "Guardian", "equal top scorer uses fixed order");
  assertEqual(classify([0, 1, 2]), "Unclassified", "incomplete questionnaire");
  assertEqual(classify([0, 1, 2, 3, 8]), "Unclassified", "invalid answer");
  const { game, players, data } = fixture(4);
  const user = players[0].discordSnowflake;
  assert((await mysteryDungeon.registrationPrompt!(game, user, "fwsc:x:a:y")).content.includes("Question 1"), "private first question");
  mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "answer:0:1"), ["answer:0:1"]);
  mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", "answer:0:1"));
  assertEqual(data().quizzes[user].answers[0], 1, "answer persisted privately");
  throws(() => mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "submit"), ["submit"]), "must finish all five");
  for (let i = 1; i < 5; i++)
    mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", `answer:${i}:1`));
  mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "submit"), ["submit"]);
  mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", "submit"));
  assertEqual(data().quizzes[user].submitted, true, "explicit submission");
  assert((await mysteryDungeon.registrationPrompt!(game, user, "fwsc:x:a:y")).content.includes("Pathfinder"), "private personality reveal");
  mysteryDungeon.onRegistrationChanged!(game, user, false);
  assert(!data().quizzes[user], "dropout clears private quiz");
});
test("Scenario allocator balances Elo, preserves captain sides and includes unclassified/nonrespondents", () => {
  const { game, players } = fixture(20, true);
  const types = Object.fromEntries(players.slice(0, 11).map((p, i) => [p.discordSnowflake, ["Guardian", "Vanguard"][i % 2]]));
  const first = allocateScenarioTeams(game, types);
  const again = allocateScenarioTeams(game, types);
  assertEqual(JSON.stringify(first), JSON.stringify(again), "allocation stable for same roster");
  assertEqual(first.proposal.red.length, 10, "RED size");
  assertEqual(first.proposal.blue.length, 10, "BLUE size");
  assert(first.proposal.red.includes(players[0].discordSnowflake) &&
    first.proposal.blue.includes(players[1].discordSnowflake), "captains fixed to correct sides");
  assertEqual(new Set([...first.proposal.red, ...first.proposal.blue]).size, 20, "all 20 included exactly once");
  const mean = (ids: string[]) => ids.reduce((s, id) =>
    s + players.find((p) => p.discordSnowflake === id)!.elo, 0) / ids.length;
  assert(Math.abs(mean(first.proposal.red) - mean(first.proposal.blue)) < 120, "reasonable Elo gap");
});
test("Partners in Crime recognises only reciprocal private choices and no player appears twice", async () => {
  const { game, players, data } = fixture(6);
  const [a, b, c, d] = players.map((p) => p.discordSnowflake);
  const prefs = {
    [a]: { target: b, reveal: true }, [b]: { target: a, reveal: false },
    [c]: { target: d, reveal: true }, [d]: { target: null, reveal: true },
  };
  assertEqual(JSON.stringify(mutualPairs(prefs, players.map((p) => p.discordSnowflake))), JSON.stringify([{ a, b }]), "only consent-based mutual pair");
  const result = allocateScenarioTeams(game, {}, [{ a, b }]);
  assertEqual(result.kept.length, 1, "mutual pair preserved");
  assertEqual(result.split.length, 0, "no unnecessary split");
  assertEqual(new Set([...result.proposal.red, ...result.proposal.blue]).size, 6, "all players assigned");
  partnersInCrime.validateAction!(game, responseAction(a, "preferences", b), [b]);
  throws(() => partnersInCrime.validateAction!(game, responseAction(a, "preferences", a), [a]), "self preference rejected");
  throws(() => partnersInCrime.validateAction!(game, responseAction(a, "preferences", "99999999"), ["99999999"]), "absent target rejected");
  partnersInCrime.onActionSubmitted!(game, responseAction(a, "preferences", b));
  partnersInCrime.onActionSubmitted!(game, responseAction(a, "preferences", "reveal:yes"));
  assertEqual(data().preferences[a].target, b, "stable Discord ID retained through display-name changes");
  assertEqual(data().preferences[a].reveal, true, "public consent recorded independently");
  const prompt = await partnersInCrime.registrationPrompt!(game, a, "fwsc:x:a:y");
  assert(!prompt.content.includes("Private nominations from other players"), "no unilateral leak");
  partnersInCrime.onRegistrationChanged!(game, b, false);
  assertEqual(data().preferences[a].target, null, "departure erases stale preference");
});
test("Partners in Crime splits minimum necessary pairs when even teams cannot hold every duo", () => {
  const { game, players } = fixture(18);
  const pairs = Array.from({ length: 9 }, (_, i) => ({
    a: players[i * 2].discordSnowflake, b: players[i * 2 + 1].discordSnowflake,
  }));
  const result = allocateScenarioTeams(game, {}, pairs);
  assertEqual(result.proposal.red.length, 9, "hard size constraint takes priority");
  assertEqual(result.proposal.blue.length, 9, "hard size constraint takes priority");
  assertEqual(result.split.length, 1, "exactly one pair split when 9 is odd");
});
test("People's Captains distributes three unique no-self ballots deterministically and scores exposure", () => {
  const voters = Array.from({ length: 18 }, (_, i) => String(1000 + i));
  const slate = voters.slice(0, 7);
  const first = createBalancedBallots(voters, slate);
  assertEqual(JSON.stringify(first), JSON.stringify(createBalancedBallots(voters, slate)), "ballots reproducible");
  for (const [voter, options] of Object.entries(first)) {
    assertEqual(options.length, 3, "exact three candidates");
    assertEqual(new Set(options).size, 3, "no duplicates");
    assert(!options.includes(voter), "no self vote");
  }
  const tally = tallyElection(first, Object.fromEntries(Object.entries(first).slice(0, 8)
    .map(([voter, options]) => [voter, options[0]])), slate);
  assertEqual(tally.turnout, 8, "count each registered voter once");
  assertEqual(tally.ranked.length, slate.length, "all willing candidates ranked");
  const exposures = Object.values(tally.exposure);
  assert(Math.max(...exposures) - Math.min(...exposures) <= 3, "bounded exposure imbalance");
  const invalid = tallyElection(first, { [voters[0]]: voters[0], [voters[1]]: first[voters[1]][1] }, slate);
  assertEqual(invalid.turnout, 1, "self or unavailable votes excluded");
  throws(() => createBalancedBallots(voters, slate.slice(0, 3)), "too few willing candidates rejected");
  assertEqual(JSON.stringify(tallyElection(first, {}, slate)), JSON.stringify(tallyElection(first, {}, slate)), "no-vote ordering stable");
});
test("People's Captains validates a vote against its frozen personal ballot", () => {
  const { game, players, data } = fixture(6);
  const voter = players[0].discordSnowflake;
  const slate = players.slice(1).map((p) => p.discordSnowflake);
  const ballots = createBalancedBallots(players.map((p) => p.discordSnowflake), slate);
  (game.scenarios as any).setData("ballots", ballots);
  const vote = `vote:${ballots[voter][0]}`;
  peoplesCaptains.validateAction!(game, responseAction(voter, "ballot", vote), [vote]);
  throws(() => peoplesCaptains.validateAction!(game, responseAction(voter, "ballot", `vote:${voter}`), [`vote:${voter}`]), "no self votes");
  peoplesCaptains.onActionSubmitted!(game, responseAction(voter, "ballot", vote));
  assertEqual(data().votes[voter], ballots[voter][0], "vote saved privately");
});
test("Masked and roulette draft rules cover snake order, unique offers, deterministic card mapping", () => {
  const turns = Array.from({ length: 8 }, (_, i) => snakeTurn(i, "RED"));
  assertEqual(turns.join(","), "RED,BLUE,BLUE,RED,RED,BLUE,BLUE,RED", "snake order");
  const pool = ["u1", "u2", "u3", "u4", "u5"];
  const hand = rouletteOffer(pool, () => 0);
  assertEqual(hand.length, 3, "three offered players");
  assertEqual(new Set(hand).size, 3, "offer is unique");
  assertEqual(rouletteOffer(["u1", "u2"]).length, 2, "small pool supported");
  throws(() => rouletteOffer(["u1", "u1"]), "duplicate pool rejected");
  const cards = maskedCards(pool, () => 0);
  assertEqual(Object.keys(cards).length, 5, "one card for each player");
  assertEqual(new Set(Object.values(cards)).size, 5, "anonymous mapping is bijective");
  assert(Object.keys(cards).every((c) => /^M\d\d$/.test(c)), "anonymous card labels only");
  assertEqual(JSON.stringify(cards), JSON.stringify(maskedCards(pool, () => 0)), "card mapping stable with stored RNG draw");
  assert(!!maskedDraft.publicSummary && !!draftRoulette.publicSummary, "draft modes expose public status");
});
test("Captain's Wildcards veto restrictions and Switcheroo preserve team size and ownership", async () => {
  const draft = new DraftTeamPickingSession("snake") as any;
  const { players } = fixture(8, true);
  draft.redCaptain = players[0];
  draft.blueCaptain = players[1];
  draft.proposedTeams.RED = [players[0], players[2]];
  draft.proposedTeams.BLUE = [players[1]];
  draft.proposedTeams.UNDECIDED = players.slice(3);
  draft.turn = "RED";
  draft.firstPickTeam = "RED";
  draft.totalPicksMade = 2;
  const before = draft.proposedTeams.RED.length;
  await draft.useWildcardSwap(players[0].discordSnowflake, players[2].discordSnowflake, players[3].discordSnowflake);
  assertEqual(draft.proposedTeams.RED.length, before, "swap preserves team size");
  assert(draft.proposedTeams.RED.includes(players[3]), "new player joins team");
  assert(draft.proposedTeams.UNDECIDED.includes(players[2]), "replaced player returns to pool");
  let invalidSwap = false;
  try { await draft.useWildcardSwap(players[1].discordSnowflake, players[3].discordSnowflake, players[4].discordSnowflake); }
  catch { invalidSwap = true; }
  assert(invalidSwap, "wrong captain cannot swap");
  draft.totalPicksMade = 1;
  await draft.useWildcardVeto(players[0].discordSnowflake, players[4].discordSnowflake);
  draft.turn = "BLUE";
  assert(!(draft as any).getPickPool().pool.some((p: Player) => p.discordSnowflake === players[4].discordSnowflake), "veto blocks opponent's eligible pool");
  draft.turn = "RED";
  assert((draft as any).getPickPool().pool.some((p: Player) => p.discordSnowflake === players[4].discordSnowflake), "veto never blocks vetoing captain");
  assert(!!captainsWildcards.publicResult, "credit and history are auditable");
});
test("Class Hex rejects banned/invalid classes and duplicate or same-team targets", () => {
  const { game, players, sides, setScenario, data, setPhase, reviewed } = fixture(8, true);
  setScenario("class-hex");
  sides.RED.push(players[2], players[4], players[6]);
  sides.BLUE.push(players[3], players[5], players[7]);
  sides.UNDECIDED.length = 0;
  const valid = configureHexPool(game, "civilian, farmer, tinkerer, bard", players[0].discordSnowflake);
  assertEqual(valid.length, 4, "organiser-approved valid pool");
  (game.settings.organiserBannedClasses as string[]).push("FARMER");
  assert(!eligibleClasses(game).includes("FARMER"), "banned class excluded");
  throws(() => configureHexPool(game, "farmer,farmer,bard", players[0].discordSnowflake), "duplicate class rejected");
  throws(() => configureHexPool(game, "no-such-class,bard,farmer", players[0].discordSnowflake), "invalid class rejected");
  (game.scenarios as any).setData("hexPool", ["CIVILIAN", "FARMER", "TINKERER", "BARD"]);
  (game.scenarios as any).setData("hexDraw", ["CIVILIAN", "TINKERER", "BARD"]);
  (game.scenarios as any).setData("hexEditors", { [players[0].discordSnowflake]: {
    team: "RED", cursor: 0, targets: [], submitted: false,
  } });
  classHex.validateAction!(game, responseAction(players[0].discordSnowflake, "hex", players[3].discordSnowflake), [players[3].discordSnowflake]);
  throws(() => classHex.validateAction!(game, responseAction(players[0].discordSnowflake, "hex", players[2].discordSnowflake), [players[2].discordSnowflake]), "cannot target own side");
  throws(() => classHex.validateAction!(game, responseAction(players[0].discordSnowflake, "hex", "submit"), ["submit"]), "cannot submit incomplete");
  (game.scenarios as any).setData("hexEditors", { [players[0].discordSnowflake]: {
    team: "RED", cursor: 3, targets: [players[3].discordSnowflake, players[5].discordSnowflake, players[7].discordSnowflake], submitted: true,
  } });
  setPhase("completed");
  const report = reportUnavailableClass(game, players[3].discordSnowflake);
  assert(report.includes("recorded"), "affected player can report unavailable class");
  assert(reviewed().includes("unavailable"), "report requires organiser review");
  assertEqual(data().access[players[3].discordSnowflake], "unavailable", "access issue persisted");
});
test("All seven scenario definitions are enabled and normal none remains a no-scenario match", () => {
  assertEqual(scenarioRegistry.available().length, 7, "seven selectable scenarios");
  for (const id of ["mystery-dungeon", "partners-in-crime", "peoples-captains",
    "masked-draft", "draft-roulette", "captains-wildcards", "class-hex"]) {
    const definition = scenarioRegistry.requireAvailable(id);
    assert(!!definition.implementation, `${id}: actual implementation present`);
  }
  const { game } = fixture(4);
  const controller = new ScenarioCoordinator(game, scenarioRegistry);
  controller.configure("none");
  assertEqual(controller.selectedId, null, "none stays ordinary match");
  controller.configure("mystery-dungeon");
  assertEqual(controller.selectedId, "mystery-dungeon", "scenario configured independently");
  controller.configure("none");
  assertEqual(controller.selectedId, null, "choosing none clears scenario without other game mutation");
});
