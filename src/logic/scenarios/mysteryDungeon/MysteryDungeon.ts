import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioAction, ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { allocateScenarioTeams } from "../ScenarioTeamAllocation";
import { choice, data, participantLabel, publishTeamProposal, selectPrompt } from "../ScenarioGameplay";

export const archetypes = ["Guardian", "Pathfinder", "Strategist", "Vanguard"] as const;
export type Archetype = typeof archetypes[number] | "Unclassified";
const questions: { title: string; answers: string[] }[] = [
  { title: "Your Nexus is under attack, but diamonds have appeared. What do you do?", answers: ["Return and defend", "Scout a flanking route", "Check whether defence can hold", "Rally a counter-push"] },
  { title: "Five minutes before the first big fight…", answers: ["Reinforce our defences", "Explore overlooked routes", "Prepare efficient gear", "Organise an attack plan"] },
  { title: "The first rush fails. You…", answers: ["Cover the retreat", "Find a new way in", "Analyse what went wrong", "Regroup the team"] },
  { title: "Your favourite match moment?", answers: ["Saving the Nexus", "Pulling off a surprise", "A plan coming together", "A coordinated team win"] },
  { title: "A new player asks for help. You…", answers: ["Keep them safe", "Show useful shortcuts", "Explain a gear plan", "Invite them on an objective"] },
];
const descriptions = [
  "the steady shield your teammates can count on.",
  "the explorer who spots an unexpected path.",
  "the planner who turns preparation into opportunity.",
  "the spark that brings a team together.",
];
export interface Quiz { answers: number[]; cursor: number; submitted: boolean; hidden: boolean }
type Quizzes = Record<string, Quiz>;
function all(game: GameInstance): Quizzes { return data<Quizzes>(game, "quizzes", {}); }
export function classify(answers: readonly number[]): Archetype {
  if (answers.length !== 5 || answers.some((a) => !Number.isInteger(a) || a < 0 || a > 3))
    return "Unclassified";
  const scores = [0, 0, 0, 0];
  answers.forEach((a) => scores[a]++);
  // Fixed priority resolves ties identically on every restart.
  return archetypes[scores.indexOf(Math.max(...scores))];
}
function validatedQuiz(game: GameInstance, user: string): Quiz {
  return all(game)[user] ?? { answers: [], cursor: 0, submitted: false, hidden: false };
}
function render(game: GameInstance, user: string, customId: string) {
  const quiz = validatedQuiz(game, user);
  if (quiz.submitted) {
    const result = classify(quiz.answers);
    const index = archetypes.indexOf(result as typeof archetypes[number]);
    return selectPrompt(
      `✨ You are **${result}** — ${descriptions[index] ?? "still a mystery!"}\nYour answers are saved until the quiz closes. Your profile label ${quiz.hidden ? "will stay private" : "will appear at team reveal"}.`,
      customId, [{ label: "Edit answers", value: "edit" }, { label: quiz.hidden ? "Show my archetype" : "Hide my archetype", value: "visibility" }],
    );
  }
  if (quiz.cursor === 5) {
    const review = questions.map((q, i) =>
      `${i + 1}. ${q.title}\n   ${quiz.answers[i] === undefined ? "❔ Unanswered" : q.answers[quiz.answers[i]]}`).join("\n");
    return selectPrompt(`**Mystery Dungeon — Review**\n${review}\nChoose a question to edit, or submit all five answers.`,
      customId, [
        ...questions.map((_, i) => ({ label: `Edit question ${i + 1}`, value: `nav:${i}` })),
        { label: "Submit my personality test", value: "submit" },
      ]);
  }
  const i = quiz.cursor;
  return selectPrompt(
    `**Mystery Dungeon — Question ${i + 1}/5**\n${questions[i].title}\n\n${quiz.answers.filter((a) => a !== undefined).length} of 5 answered. You can go back and edit before submitting.`,
    customId,
    [
      ...questions[i].answers.map((answer, index) => ({ label: answer, value: `answer:${i}:${index}` })),
      ...(i > 0 ? [{ label: "← Previous question", value: `nav:${i - 1}` }] : []),
      { label: "Review all answers", value: "nav:5" },
    ],
  );
}
export const mysteryDungeon: ScenarioImplementation = {
  registrationPrompt: (game, user, customId) => render(game, user, customId),
  renderAction: (game, action, customId) => render(game, action.ownerId, customId),
  validateAction(game, action, value) {
    if (action.kind !== "questionnaire") throw new Error("Unknown questionnaire.");
    const input = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
    const quiz = validatedQuiz(game, action.ownerId);
    if (/^answer:[0-4]:[0-3]$/.test(input)) return;
    if (/^nav:[0-5]$/.test(input) || input === "edit" || input === "visibility") return;
    if (input === "submit" && [0, 1, 2, 3, 4].every((i) => quiz.answers[i] !== undefined)) return;
    throw new Error("Answer all five questions before submitting.");
  },
  onActionSubmitted(game, action) {
    const input = choice(action);
    const quizzes = all(game);
    const quiz = validatedQuiz(game, action.ownerId);
    if (input.startsWith("answer:")) {
      const [, i, answer] = input.split(":").map(Number);
      quiz.answers[i] = answer;
      quiz.cursor = Math.min(5, i + 1);
      quiz.submitted = false;
    } else if (input.startsWith("nav:")) {
      quiz.cursor = Number(input.slice(4));
      quiz.submitted = false;
    } else if (input === "submit") {
      quiz.submitted = true;
    } else if (input === "edit") {
      quiz.submitted = false; quiz.cursor = 0;
    } else if (input === "visibility") quiz.hidden = !quiz.hidden;
    quizzes[action.ownerId] = quiz;
    game.scenarios.setData("quizzes", quizzes as unknown as ScenarioValue);
  },
  onRegistrationChanged(game, id, joined) {
    if (joined) return;
    const quizzes = all(game);
    delete quizzes[id];
    game.scenarios.setData("quizzes", quizzes as unknown as ScenarioValue);
  },
  activateTrigger(game, policy, roster) {
    if (policy.id !== "lock") return;
    game.scenarios.assertCapturedRoster("lock");
    const quizzes = all(game);
    const types: Record<string, string> = {};
    for (const id of roster) types[id] = quizzes[id]?.submitted ? classify(quizzes[id].answers) : "Unclassified";
    const allocation = allocateScenarioTeams(game, types);
    game.scenarios.markReady({ types, red: allocation.proposal.red, blue: allocation.proposal.blue });
    publishTeamProposal(game, allocation.proposal);
  },
  organiserSummary(game) {
    const info = data<Record<string, string>>(game, "types", {});
    const teams = game.scenarios.snapshot()?.data ?? {};
    const distribution = (ids: string[]) => archetypes.concat("Unclassified" as never)
      .map((type) => `${type} ${ids.filter((id) => info[id] === type).length}`).join(" · ");
    const quizzes = all(game);
    return `Submitted: ${Object.values(quizzes).filter((q) => q.submitted).length}/${game.getPlayers().length}\nRED: ${distribution((teams.red ?? []) as string[])}\nBLUE: ${distribution((teams.blue ?? []) as string[])}`;
  },
  async onTeamsFinalized(game) {
    if (game.scenarios.phase !== "completed" || game.scenarios.selectedId !== "mystery-dungeon") return;
    const types = data<Record<string, string>>(game, "types", {});
    const quizzes = all(game);
    const line = (side: "RED" | "BLUE") => game.getPlayersOfTeam(side)
      .map((p) => `${participantLabel(game, p.discordSnowflake)} — ${quizzes[p.discordSnowflake]?.hidden ? "Hidden" : types[p.discordSnowflake] ?? "Unclassified"}`).join("\n");
    await DiscordUtil.sendMessage("gameFeed", `✨ **Mystery Dungeon teams revealed!**\n🔴 RED\n${line("RED")}\n🔵 BLUE\n${line("BLUE")}\nCaptains can now be appointed from their respective teams.`);
  },
  publicResult(game) {
    const types = data<Record<string, string>>(game, "types", {});
    return { classified: Object.values(types).filter((s) => s !== "Unclassified").length };
  },
  checkReadyToStart(game) {
    return game.hasFinalizedPlayableTeams() ? null : "Personality-based teams have not been confirmed.";
  },
};
