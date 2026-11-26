import { randomUUID } from "node:crypto";
import type { GameInstance } from "../../src/database/GameInstance";
import { ScenarioRegistry, scenarioRegistry } from "../../src/logic/scenarios/ScenarioRegistry";
import { ScenarioCoordinator, validateScenarioState } from "../../src/logic/scenarios/ScenarioCoordinator";
import { allocateScenarioTeams } from "../../src/logic/scenarios/ScenarioTeamAllocation";
import { classify, mysteryDungeon } from "../../src/logic/scenarios/mysteryDungeon/MysteryDungeon";
import { questions, selectQuestions } from "../../src/logic/scenarios/mysteryDungeon/QuestionBank";
import type { QuestionId } from "../../src/logic/scenarios/mysteryDungeon/QuestionBank";
import { mutualPairs, partnersInCrime } from "../../src/logic/scenarios/partnersInCrime/PartnersInCrime";
import { createBalancedBallots, tallyElection, peoplesCaptains } from "../../src/logic/scenarios/peoplesCaptains/PeoplesCaptains";
import { maskedCards, rouletteOffer, snakeTurn } from "../../src/logic/scenarios/drafts/ScenarioDraftRules";
import { maskedDraft, draftRoulette } from "../../src/logic/scenarios/drafts/DraftScenarios";
import { buildMaskedHints, MYSTERY_HINT, type MaskedClue } from "../../src/logic/scenarios/drafts/MaskedDraftHints";
import { deriveMaskedClues, type MaskedHistoryRow } from "../../src/logic/scenarios/drafts/MaskedDraftHistory";
import { loadMaskedStatistics } from "../../src/logic/scenarios/drafts/MaskedDraftStatistics";
import { ScenarioDraftSession } from "../../src/logic/scenarios/drafts/ScenarioDraftSession";
import { prismaClient } from "../../src/database/prismaClient";
import { Channels } from "../../src/Channels";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import TeamCommand from "../../src/commands/TeamCommand";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";
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
  assertEqual(Object.keys(questions).length, 25, "new question pool");
  assert(Object.values(questions).every((q) => q.answers.length >= 2 && q.answers.length <= 4), "variable answer counts");
  assertEqual(new Set(selectQuestions(() => 0)).size, 5, "sample without replacement");
  assert(JSON.stringify(selectQuestions(() => 0)) !== JSON.stringify(selectQuestions((max) => max - 1)), "different draws select different questions");
  const first = await mysteryDungeon.registrationPrompt!(game, user, "fwsc:x:a:y");
  assert(first.content.includes("Question 1"), "private first question");
  const ids = data().quizzes[user].questionIds as QuestionId[];
  assertEqual(new Set(ids).size, 5, "five unique questions saved before answering");
  assertEqual((await mysteryDungeon.registrationPrompt!(game, user, "fwsc:x:a:y")).content, first.content, "reopening preserves question order");
  assertEqual(JSON.stringify(data().quizzes[user].questionIds), JSON.stringify(ids), "saved question IDs unchanged");
  assertEqual(classify([0, 0, 0, 0, 0], ["switch", "trail", "mid", "balloon", "present"]), "Pathfinder", "score follows mapped archetypes, not answer position");
  assertEqual(classify([2, 0, 0, 0, 0], ["switch", "trail", "mid", "balloon", "present"]), "Unclassified", "two-choice question rejects nonexistent answer");
  const shortUser = players[1].discordSnowflake;
  const shortQuiz = { questionIds: ["switch", "trail", "mid", "balloon", "present"], answers: [null, null, null, null, null], cursor: 0, submitted: false, hidden: false };
  game.scenarios.setData("quizzes", { ...data().quizzes, [shortUser]: shortQuiz });
  const invalid = "answer:0:2";
  throws(() => mysteryDungeon.validateAction!(game, responseAction(shortUser, "questionnaire", invalid), [invalid]), "reject choice not offered");
  mysteryDungeon.validateAction!(game, responseAction(shortUser, "questionnaire", "answer:0:1"), ["answer:0:1"]);
  mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "answer:0:1"), ["answer:0:1"]);
  mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", "answer:0:1"));
  assertEqual(data().quizzes[user].answers[0], 1, "answer persisted privately");
  throws(() => mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "submit"), ["submit"]), "must finish all five");
  for (let i = 1; i < 5; i++)
    mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", `answer:${i}:1`));
  mysteryDungeon.validateAction!(game, responseAction(user, "questionnaire", "submit"), ["submit"]);
  mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", "submit"));
  assertEqual(data().quizzes[user].submitted, true, "explicit submission");
  const result = classify([1, 1, 1, 1, 1], ids);
  assert(result !== "Unclassified", "valid selections produce an archetype");
  assert((await mysteryDungeon.registrationPrompt!(game, user, "fwsc:x:a:y")).content.includes(result), "private personality reveal");
  mysteryDungeon.onActionSubmitted!(game, responseAction(user, "questionnaire", "edit"));
  assertEqual(JSON.stringify(data().quizzes[user].questionIds), JSON.stringify(ids), "editing preserves questions");
  assertEqual(data().quizzes[user].answers[0], 1, "editing preserves answers");
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
  const slate = voters;
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
  assertEqual(tally.ranked.length, slate.length, "all registered candidates ranked");
  const exposures = Object.values(tally.exposure);
  assert(exposures.every((n) => n === 3), "exactly equal exposure");
  const invalid = tallyElection(first, { [voters[0]]: voters[0], [voters[1]]: first[voters[1]][1] }, slate);
  assertEqual(invalid.turnout, 1, "self or unavailable votes excluded");
  throws(() => createBalancedBallots(voters, slate.slice(0, 3)), "partial candidate slate rejected");
  assertEqual(JSON.stringify(tallyElection(first, {}, slate)), JSON.stringify(tallyElection(first, {}, slate)), "no-vote ordering stable");
});
test("People's Captains validates a vote against its frozen personal ballot", () => {
  const { game, players, data } = fixture(6);
  const voter = players[0].discordSnowflake;
  const slate = players.map((p) => p.discordSnowflake);
  const ballots = createBalancedBallots(players.map((p) => p.discordSnowflake), slate);
  (game.scenarios as any).setData("ballots", ballots);
  const vote = `vote:${ballots[voter][0]}`;
  peoplesCaptains.validateAction!(game, responseAction(voter, "ballot", vote), [vote]);
  throws(() => peoplesCaptains.validateAction!(game, responseAction(voter, "ballot", `vote:${voter}`), [`vote:${voter}`]), "no self votes");
  peoplesCaptains.onActionSubmitted!(game, responseAction(voter, "ballot", vote));
  assertEqual(data().votes[voter], ballots[voter][0], "vote saved privately");
  const changed = `vote:${ballots[voter][1]}`;
  peoplesCaptains.validateAction!(game, responseAction(voter, "ballot", changed), [changed]);
  peoplesCaptains.onActionSubmitted!(game, responseAction(voter, "ballot", changed));
  assertEqual(data().votes[voter], ballots[voter][1], "latest vote replaces previous vote");
  assertEqual(tallyElection(ballots, data().votes, slate).turnout, 1, "one voter counts once");
  throws(() => peoplesCaptains.validateAction!(game, responseAction(voter, "candidate", "candidate:yes"), ["candidate:yes"]), "self nomination unavailable");
});
test("People's Captains balances every full roster size and fixes tie breaks per match", () => {
  for (let n = 4; n <= 100; n++) {
    const roster = Array.from({ length: n }, (_, i) => String(i + 1000));
    const frozen = createBalancedBallots(roster, roster, "match-1");
    assertEqual(Object.keys(frozen).length, n, "everyone gets a ballot");
    for (const [voter, choices] of Object.entries(frozen)) {
      assertEqual(new Set(choices).size, 3, "three distinct choices");
      assert(!choices.includes(voter), "no self votes");
    }
    const result = tallyElection(frozen, {}, roster, "match-1");
    assert(Object.values(result.exposure).every((count) => count === 3), "each candidate appears exactly three times");
    assertEqual(JSON.stringify(result.ranked), JSON.stringify(tallyElection(frozen, {}, [...roster].reverse(), "match-1").ranked), "tie order stable across roster ordering");
  }
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
function historyRow(
  playerId: string, gameId: string, day: number, team: string, winner: string,
  map = "CANYON1V1", captain = false, mvp = false,
): MaskedHistoryRow {
  return { playerId, gameId, team, captain, mvp,
    game: { winner, endTime: new Date(Date.UTC(2026, 0, day)), settings: { map } } };
}

test("Masked historical clues support real captain comparisons, map records and sample-backed form", () => {
  const rows: MaskedHistoryRow[] = [];
  const roster = ["a", "b", "r", "z", "unknown"];
  for (let i = 0; i < 5; i++) {
    const winner = i === 4 ? "BLUE" : "RED";
    rows.push(historyRow("a", `r${i}`, i + 1, "RED", winner, "CANYON1V1", true, i === 0 || i === 4));
    rows.push(historyRow("r", `r${i}`, i + 1, "RED", winner));
    rows.push(historyRow("b", `r${i}`, i + 1, "BLUE", winner));
  }
  for (let i = 0; i < 4; i++) {
    rows.push(historyRow("a", `b${i}`, i + 6, "BLUE", "BLUE", "ANDORRA1V1", false, i === 0));
    rows.push(historyRow("z", `b${i}`, i + 6, "BLUE", "BLUE", "ANDORRA1V1"));
  }
  const captains = { RED: "r", BLUE: "z" };
  const labels = () => deriveMaskedClues(rows, roster, captains, "CANYON1V1").get("a")!.map((clue) => clue.label);
  assert(labels().includes("Top lobby win-rate partner: RED captain (60%+ wins)"), "4/5 shared wins beats ineligible 4/4");
  assert(labels().includes("RED captain: 80%+ wins together"), "specific rate band and sample");
  assert(!labels().some((label) => label.includes("BLUE captain")), "insufficient shared games");
  assert(labels().includes("Canyon: 80%+ wins"), "current map record uses sufficient sample");
  assert(labels().includes("80%+ wins as captain"), "captain flags and wins independent of colour");
  assertEqual(deriveMaskedClues(rows, roster, captains).get("unknown")!.length, 0, "missing history has no invented facts");
  for (let i = 0; i < 5; i++) {
    rows.push(historyRow("a", `p${i}`, 10 + i, "RED", "RED", "CANYON1V1"));
    rows.push(historyRow("b", `p${i}`, 10 + i, "RED", "RED", "CANYON1V1"));
  }
  assert(!labels().some((label) => label.startsWith("Top lobby win-rate partner")), "better masked teammate suppresses top captain label; no masked identity disclosed");
  assert(labels().includes("RED captain: 80%+ wins together"), "useful captain record still shown");
  rows.push(historyRow("z", "b0", 6, "BLUE", "BLUE", "ANDORRA1V1")); // duplicate record
  assert(!labels().some((label) => label.includes("BLUE captain")), "duplicate cannot inflate sample");
  rows.push(historyRow("a", "b4", 15, "BLUE", "BLUE", "ANDORRA1V1", false, true));
  rows.push(historyRow("z", "b4", 15, "BLUE", "BLUE", "ANDORRA1V1"));
  assert(labels().includes("20+ pts higher win rate with BLUE captain than RED"), "comparison uses shared results with both captains");
  assert(labels().includes("Played Canyon 10+ times"), "map familiarity based on actual sample");
  assert(labels().includes("Won 8-10 of last 10 games"), "recent form is bounded and factual");
  const facts = [
    historyRow("a", "m1", 1, "RED", "BLUE", "CANYON1V1", false, true),
    historyRow("a", "m2", 2, "BLUE", "RED", "ANDORRA1V1", false, true),
  ];
  assert(deriveMaskedClues(facts, roster, captains).get("a")!.some((clue) =>
    clue.label === "Earned MVP in 2+ losses"), "losing-side MVPs counted");
  assert(!labels().some((label) => /both colours|colour switch/i.test(label)), "no historical colour-based facts");
  const tied = rows.map((row) => ({ ...row, game: { ...row.game!, endTime: new Date(0) } }));
  assert(!deriveMaskedClues(tied, roster, captains).get("a")!.some((clue) => /last 10/.test(clue.label)), "ambiguous boundary cannot create form clues");
});

test("Masked hints are grounded in full cohorts and vary without exposing rare or missing histories", () => {
  const cards = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`M0${i + 1}`, `p${i}`]));
  const partner = { label: "RED captain: 80%+ wins together", priority: 0, family: "partner" } as const;
  const map = { label: "Canyon: 60-79% wins", priority: 1, family: "map" } as const;
  const rare = { label: "MVP in 2+ of last 10 games", priority: 2, family: "mvp" } as const;
  const clues = new Map<string, readonly MaskedClue[]>([
    ...["p0", "p1", "p2"].map((id) => [id, [partner, map]] as const),
    ...["p3", "p4", "p5"].map((id) => [id, [map]] as const),
    ["p6", [rare]], ["p7", []],
  ]);
  const hints = buildMaskedHints(cards, clues);
  assertEqual(hints.M01, `${partner.label} · ${map.label}`, "two independent clues shared by a complete cohort");
  assertEqual(hints.M04, map.label, "different historical clue");
  assertEqual(hints.M07, MYSTERY_HINT, "rare characteristic suppressed");
  assertEqual(hints.M08, MYSTERY_HINT, "empty history not distinguished");
  assertEqual(hints.M09, MYSTERY_HINT, "missing history not distinguished");
  assertEqual(JSON.stringify(hints), JSON.stringify(buildMaskedHints(cards, clues)), "pure deterministic descriptions");
  assert(Object.values(buildMaskedHints({ M01: "p0", M02: "p1" }, clues)).every((hint) => hint === MYSTERY_HINT), "small pool is entirely masked");
  const intersecting = new Map<string, readonly MaskedClue[]>([
    ["p0", [partner, map]], ["p1", [partner, map]],
    ["p2", [partner]], ["p3", [partner]],
    ["p4", [map]], ["p5", [map]],
  ]);
  const intersectionHints = buildMaskedHints(cards, intersecting);
  assert(!Object.values(intersectionHints).some((label) => label.includes(" · ")),
    "individually common clues cannot be combined if only two players share them");
  assert(Object.values(intersectionHints).every((label) =>
    Object.values(intersectionHints).filter((other) => other === label).length >= 3),
    "all resulting cohorts remain anonymous");
  for (let n = 3; n <= 40; n++) {
    const roster = Array.from({ length: n }, (_, i) => `p${i}`);
    const deck = maskedCards(roster, () => 0);
    const labels = buildMaskedHints(deck, clues);
    const all = Object.values(labels);
    assert(all.every((hint) => all.filter((other) => other === hint).length >= 3), "even the mystery group is safe");
    assert(Object.entries(labels).every(([card, label]) => label === MYSTERY_HINT ||
      label.split(" · ").every((fact) => clues.get(deck[card])?.some((clue) => clue.label === fact))), "all displayed facts are true for the individual");
  }
});

test("Masked statistics use one bounded finished-game query, no profiles, with safe failure", async () => {
  const previousProfile = prismaClient.profile.findMany;
  const previousParticipation = prismaClient.gameParticipation.findMany;
  let queries = 0;
  try {
    (prismaClient.profile as any).findMany = async () => { throw new Error("Do not read self-reported roles"); };
    (prismaClient.gameParticipation as any).findMany = async (query: any) => {
      queries++;
      assertEqual(query.where.playerId.in.join(","), "a,b,r,z", "only the frozen lobby, including captains");
      assert(query.where.game.is.finished === true, "only finished games counted");
      assert(query.where.game.is.endTime.gte instanceof Date, "bounded historical window");
      assertEqual(query.take, 20001, "bounded read");
      return Array.from({ length: 5 }, (_, i) => [
        historyRow("a", `g${i}`, i + 1, "RED", "RED"),
        historyRow("r", `g${i}`, i + 1, "RED", "RED"),
      ]).flat();
    };
    const players = ["a", "b", "r", "z"].map((id) => ({ playerId: id, discordSnowflake: `discord-${id}` }));
    const captains = { RED: "discord-r", BLUE: "discord-z" };
    const stats = await loadMaskedStatistics(players, captains, Date.UTC(2026, 10, 26));
    assertEqual(queries, 1, "one query regardless of roster size");
    assert(stats.get("discord-a")!.some((clue) => clue.label === "Top lobby win-rate partner: RED captain (60%+ wins)"), "real pair results");
    assertEqual(stats.get("discord-b")!.length, 0, "no fabricated history");
    (prismaClient.gameParticipation as any).findMany = async () => Array(20001).fill(historyRow("a", "g", 1, "RED", "RED"));
    assertEqual((await loadMaskedStatistics(players, captains)).size, 0, "truncated history cannot claim a best");
    (prismaClient.gameParticipation as any).findMany = async () => { throw new Error("private database error"); };
    assertEqual((await loadMaskedStatistics(players, captains)).size, 0, "lookup failure produces mystery fallback");
  } finally {
    prismaClient.profile.findMany = previousProfile;
    prismaClient.gameParticipation.findMany = previousParticipation;
  }
});
test("Masked draft controls freeze hints, hide identities, enforce turn ownership and reveal only confirmed teams", async () => {
  const { game, players, sides, setScenario, setPhase, data } = fixture(50, true);
  setScenario("masked-draft");
  players.forEach((player, i) => { (player as any).playerId = `internal-${i}`; });
  players[2].elo = 9876;
  (game.scenarios as any).assertCapturedRoster = () => players.map((p) => p.discordSnowflake);
  (game as any).changeHowTeamsDecided = (method: string) => { (game as any).teamsDecidedBy = method; };
  const previousChannel = Channels.teamPicking;
  const previousSend = DiscordUtil.sendMessage;
  const previousProfile = prismaClient.profile.findMany;
  const previousParticipation = prismaClient.gameParticipation.findMany;
  const previousCommand = TeamCommand.instance;
  const command = new TeamCommand();
  const session = new ScenarioDraftSession("masked") as any;
  command.teamPickingSession = session;
  session.game = game;
  session.token = game.getLifecycleToken();
  const sent: any[] = [];
  const reveals: any[] = [];
  let counter = 0;
  try {
    let queries = 0;
    (prismaClient.profile as any).findMany = async () => { queries++; throw new Error("Profiles are not clues"); };
    (prismaClient.gameParticipation as any).findMany = async () => {
      queries++;
      return Array.from({ length: 5 }, (_, day) => [
        ...[0, ...Array.from({ length: 24 }, (_, i) => i + 2)].map((i) =>
          historyRow(`internal-${i}`, `red-${day}`, day + 1, "RED", "RED", "CANYON1V1")),
        ...[1, ...Array.from({ length: 24 }, (_, i) => i + 26)].map((i) =>
          historyRow(`internal-${i}`, `blue-${day}`, day + 1, "BLUE", "BLUE", "ANDORRA1V1")),
      ]).flat();
    };
    (Channels as any).teamPicking = {
      isSendable: () => true,
      send: async (payload: any) => {
        sent.push(payload);
        return { id: String(++counter), edit: async (edited: any) => { sent.push(edited); } };
      },
    };
    (DiscordUtil as any).sendMessage = async (_channel: string, payload: any) => { reveals.push(payload); };
    await session.initialize({ editReply: async () => {} });
    const progress = data().draft;
    const frozen = JSON.stringify(progress.cardHints);
    assert(new Set(Object.values(progress.cardHints)).size >= 2, "varied grounded descriptions despite one exceptional Elo");
    assert(!frozen.includes("9876"), "no Elo clue");
    assertEqual(progress.remaining.join(","), Object.values(progress.cards).join(","), "shuffled card order, not Discord ID order");
    // The private bounded snapshot contains the full frozen deck. Restoring it
    // pauses controls and preserves the exact mapping rather than redrawing.
    const previousCoordinator = game.scenarios;
    const recovered = new ScenarioCoordinator(game);
    try {
      (game as any).scenarios = recovered;
      game.announced = true;
      recovered.restore({
        id: "masked-draft", version: 1, gameToken: session.token, phase: "collecting",
        config: {}, data: { draft: progress }, actions: [],
        triggers: [{ id: "draft", status: "active", rosterIds: players.map((p) => p.discordSnowflake) }],
      }, session.token);
      assertEqual(recovered.phase, "needs_review", "interrupted draft paused");
      assertEqual(JSON.stringify(recovered.snapshot()!.data.draft), JSON.stringify(progress), "exact cards, descriptions and picks retained");
      throws(() => recovered.resumeAfterReview(), "interrupted draft cannot redraw or resume");
    } finally {
      (game as any).scenarios = previousCoordinator;
    }
    const menu = session.turnControls().components[0].toJSON();
    const wire = JSON.stringify(menu);
    assert(players.slice(2).every((p) => !wire.includes(p.discordSnowflake) && !wire.includes(p.ignUsed)), "no identity in menu payload");
    assert(menu.components[0].options.every((option: any) => /^M[0-9]+$/.test(option.value)), "opaque values");
    assertEqual(menu.components[0].options.length, 23, "dropdown page respects Discord limits");
    const captain = progress.first === "RED" ? progress.redCaptain : progress.blueCaptain;
    const pageControl = { customId: `fwscdraft:${session.token}:0:next`, message: session.turnMessage,
      user: { id: captain }, reply: async () => {}, isStringSelectMenu: () => false,
      isButton: () => true, deferUpdate: async () => {} };
    await session.handleControl(pageControl);
    assertEqual(session.page, 1, "active captain can view next page");
    const nextPage = session.turnControls().components[0].toJSON().components[0].options;
    assert(nextPage.every((option: any) => option.label === `${option.value} - ${progress.cardHints[option.value]}`), "navigation reuses frozen hints");
    await session.handleControl({ ...pageControl, customId: `fwscdraft:${session.token}:0:prev` });
    assertEqual(session.page, 0, "previous page restored");
    assertEqual(JSON.stringify(session.turnControls().components[0].toJSON()), JSON.stringify(menu), "first page exactly stable");
    const control = { customId: `fwscdraft:${session.token}:0:pick`, message: session.turnMessage,
      user: { id: "outsider" }, reply: async () => {}, isStringSelectMenu: () => true,
      values: [Object.keys(progress.cards)[0]], deferUpdate: async () => {} };
    await session.handleControl(control);
    assertEqual(data().draft.pickIndex, 0, "outsider cannot pick");
    control.user.id = progress.first === "RED" ? progress.redCaptain : progress.blueCaptain;
    await session.handleControl(control);
    assertEqual(data().draft.pickIndex, 1, "active captain picks");
    assertEqual(JSON.stringify(data().draft.cardHints), frozen, "hints remain frozen after pick");
    await session.handleControl(control);
    assertEqual(data().draft.pickIndex, 1, "stale control cannot pick again");
    await maskedDraft.onTeamsFinalized!(game);
    assertEqual(reveals.length, 0, "no reveal before confirmation");
    // Expire a real timer and wait for its serialized roster operation.
    let timeoutDone!: () => void;
    const timedOut = new Promise<void>((resolve) => { timeoutDone = resolve; });
    const originalOperation = command.runRosterOperation.bind(command);
    (command as any).runRosterOperation = async (operation: () => Promise<void>) => {
      try { await originalOperation(operation); }
      finally { timeoutDone(); }
    };
    const automatic = session.progress.remaining[0];
    session.progress.deadline = new Date(Date.now() - 1).toISOString();
    session.armTimeout();
    await timedOut;
    assertEqual(data().draft.pickIndex, 2, "actual timeout advances exactly one pick");
    assert(!data().draft.remaining.includes(automatic), "timeout picks first shuffled eligible card");
    while (session.progress.remaining.length) await session.pick(session.progress.remaining[0], true);
    assertEqual(JSON.stringify(data().draft.cardHints), frozen, "automatic picks preserve hints");
    assertEqual(queries, 1, "no statistics queries during turns or recovery");
    assert(sent.some((payload) => typeof payload === "string" && payload.includes("Time expired")), "timeout pick uses anonymous presentation");
    const guild = new FakeGuild();
    guild.addMember(new FakeGuildMember(captain));
    let denied = false;
    await command.handleButtonPress({ customId: "draft-accept", message: session.finalizeMessage,
      guild, user: { id: captain }, reply: async () => { denied = true; },
      update: async () => { throw new Error("Non-organiser must not confirm"); },
    } as any);
    assert(denied && game.scenarios.phase === "collecting", "captain cannot bypass organiser confirmation");
    await session.handleInteraction({ customId: "draft-accept", message: session.finalizeMessage, update: async () => {} });
    assertEqual(game.scenarios.phase, "completed", "organiser confirmation finalises draft");
    await maskedDraft.onTeamsFinalized!(game);
    assert(reveals.length > 1, "large reveal split into readable messages");
    assert(reveals.every((payload) => payload.content.length <= 2000), "reveal respects Discord content limit");
    const text = reveals.map((payload) => payload.content).join("\n");
    assert(players.slice(2).every((p) => text.includes(p.ignUsed)), "identities revealed after confirmation");
    assert(Object.entries(progress.cards).every(([card, id]) =>
      text.includes(`**${card}** - ${players.find((p) => p.discordSnowflake === id)!.ignUsed} · ${progress.cardHints[card]}`)), "every original clue and identity retained");
    assertEqual(sides.RED.length, sides.BLUE.length, "teams remain balanced");
    setPhase("needs_review");
    const revealedCount = reveals.length;
    await maskedDraft.onTeamsFinalized!(game);
    assertEqual(reveals.length, revealedCount, "paused recovery cannot reveal");
  } finally {
    clearTimeout(session.timeout);
    TeamCommand.instance = previousCommand;
    (Channels as any).teamPicking = previousChannel;
    DiscordUtil.sendMessage = previousSend;
    prismaClient.profile.findMany = previousProfile;
    prismaClient.gameParticipation.findMany = previousParticipation;
  }
});
test("Draft Roulette retains its ordinary named hands and does not query masked statistics", async () => {
  const { game, players, setScenario, data } = fixture(8, true);
  setScenario("draft-roulette");
  (game.scenarios as any).assertCapturedRoster = () => players.map((p) => p.discordSnowflake);
  const previousChannel = Channels.teamPicking;
  const previousProfile = prismaClient.profile.findMany;
  const previousParticipation = prismaClient.gameParticipation.findMany;
  const session = new ScenarioDraftSession("roulette") as any;
  session.game = game;
  session.token = game.getLifecycleToken();
  let queries = 0;
  let counter = 0;
  try {
    (prismaClient.profile as any).findMany = async () => { queries++; return []; };
    (prismaClient.gameParticipation as any).findMany = async () => { queries++; return []; };
    (Channels as any).teamPicking = {
      isSendable: () => true,
      send: async () => ({ id: String(++counter), edit: async () => {} }),
    };
    await session.initialize({ editReply: async () => {} });
    const progress = data().draft;
    assertEqual(queries, 0, "roulette does not need card statistics");
    assertEqual(progress.cardHints, undefined, "roulette state unchanged");
    assertEqual(progress.hand.length, 3, "fixed hand of three");
    const controls = session.turnControls();
    const options = controls.components[0].toJSON().components[0].options;
    assert(options.every((option: any) => progress.hand.includes(option.value) &&
      option.label === players.find((p) => p.discordSnowflake === option.value)?.ignUsed), "roulette offers ordinary player identities");
    assert(controls.components[1].toJSON().components.some((button: any) => button.custom_id.endsWith(":reroll")), "one reroll still offered");
    const team = progress.first;
    await session.handleControl({
      customId: `fwscdraft:${session.token}:0:reroll`, message: session.turnMessage,
      user: { id: team === "RED" ? progress.redCaptain : progress.blueCaptain },
      isButton: () => true, deferUpdate: async () => {},
    });
    assert(data().draft.rerolls[team], "reroll credit consumed");
    assertEqual(data().draft.hand.length, 3, "rerolled hand remains legal");
    const autoPick = data().draft.hand[0];
    await session.pick(autoPick, true);
    assert(!data().draft.remaining.includes(autoPick), "roulette automatic pick from current hand");
  } finally {
    clearTimeout(session.timeout);
    (Channels as any).teamPicking = previousChannel;
    prismaClient.profile.findMany = previousProfile;
    prismaClient.gameParticipation.findMany = previousParticipation;
  }
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
