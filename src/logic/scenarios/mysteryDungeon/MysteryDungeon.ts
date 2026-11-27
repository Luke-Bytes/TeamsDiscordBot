import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioAction, ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { allocateScenarioTeams } from "../ScenarioTeamAllocation";
import { choice, data, participantLabel, publishTeamProposal, selectPrompt } from "../ScenarioGameplay";

import { archetypes, legacyQuestions, QUESTION_COUNT, questions, selectQuestions } from "./QuestionBank";
import type { Archetype, Question, QuestionId } from "./QuestionBank";
export { archetypes };
export type { Archetype };
const descriptions = [
  "the steady shield your teammates can count on.",
  "the explorer who spots an unexpected path.",
  "the planner who turns preparation into opportunity.",
  "the spark that brings a team together.",
];
export interface Quiz {
  questionIds?: QuestionId[]; // Absent only in legacy recovery snapshots.
  answers: (number | null)[];
  cursor: number;
  submitted: boolean;
  hidden: boolean;
}
type Quizzes = Record<string, Quiz>;
function all(game: GameInstance): Quizzes { return data<Quizzes>(game, "quizzes", {}); }
function assignedQuestions(ids?: readonly QuestionId[]): readonly Question[] {
  if (ids === undefined) return legacyQuestions;
  if (!Array.isArray(ids) || ids.length !== QUESTION_COUNT ||
      new Set(ids).size !== QUESTION_COUNT ||
      !ids.every((id) => Object.prototype.hasOwnProperty.call(questions, id)))
    throw new Error("Invalid saved questionnaire.");
  return ids.map((id: QuestionId) => questions[id]);
}
function validAnswer(question: Question | undefined, answer: unknown): answer is number {
  return !!question && typeof answer === "number" && Number.isInteger(answer) &&
    answer >= 0 && answer < question.answers.length;
}
export function classify(answers: readonly (number | null)[], ids?: readonly QuestionId[]): Archetype {
  const assigned = assignedQuestions(ids);
  if (answers.length !== QUESTION_COUNT ||
      !assigned.every((q, i) => validAnswer(q, answers[i]))) return "Unclassified";
  const scores = [0, 0, 0, 0];
  assigned.forEach((q, i) => scores[archetypes.indexOf(q.answers[answers[i]!][1])]++);
  // Keep existing deterministic tie priority.
  return archetypes[scores.indexOf(Math.max(...scores))];
}
function validatedQuiz(game: GameInstance, user: string): Quiz {
  const quizzes = all(game);
  if (quizzes[user]) return quizzes[user];
  const quiz: Quiz = {
    questionIds: selectQuestions(), answers: Array<number | null>(QUESTION_COUNT).fill(null),
    cursor: 0, submitted: false, hidden: false,
  };
  quizzes[user] = quiz;
  game.scenarios.setData("quizzes", quizzes as unknown as ScenarioValue);
  return quiz;
}
function render(game: GameInstance, user: string, customId: string) {
  const quiz = validatedQuiz(game, user);
  const assigned = assignedQuestions(quiz.questionIds);
  if (quiz.submitted) {
    const result = classify(quiz.answers, quiz.questionIds);
    const index = archetypes.indexOf(result as typeof archetypes[number]);
    return selectPrompt(
      `✨ You are **${result}** - ${descriptions[index] ?? "still a mystery!"}\nYour personality test is complete. Your answers are saved until the quiz closes. Your profile label ${quiz.hidden ? "will stay private" : "will appear at team reveal"}.`,
      customId, [{ label: "Edit answers", value: "edit" }, { label: quiz.hidden ? "Show my archetype" : "Hide my archetype", value: "visibility" }],
    );
  }
  const firstUnanswered = assigned.findIndex((q, i) => !validAnswer(q, quiz.answers[i]));
  if (quiz.cursor === QUESTION_COUNT && firstUnanswered === -1) {
    const review = assigned.map((q, i) =>
      `${i + 1}. ${q.title}\n   ${validAnswer(q, quiz.answers[i]) ? q.answers[quiz.answers[i]!][0] : "❔ Unanswered"}`).join("\n");
    return selectPrompt(`**Mystery Dungeon - Review**\n${review}\nChoose a question to edit, or submit all five answers.`,
      customId, [
        ...assigned.map((_, i) => ({ label: `Edit question ${i + 1}`, value: `nav:${i}` })),
        { label: "Submit my personality test", value: "submit" },
      ]);
  }
  const i = quiz.cursor === QUESTION_COUNT ? firstUnanswered : quiz.cursor;
  return selectPrompt(
    `**Mystery Dungeon - Question ${i + 1}/${QUESTION_COUNT}**\n${assigned[i].title}\n\n${assigned.filter((q, index) => validAnswer(q, quiz.answers[index])).length} of ${QUESTION_COUNT} answered. You can go back and edit before submitting.`,
    customId,
    [
      ...assigned[i].answers.map(([label], index) => ({ label, value: `answer:${i}:${index}` })),
      ...(i > 0 ? [{ label: "← Previous question", value: `nav:${i - 1}` }] : []),
      ...(firstUnanswered === -1 ? [{ label: "Review all answers", value: `nav:${QUESTION_COUNT}` }] : []),
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
    const assigned = assignedQuestions(quiz.questionIds);
    const answer = /^answer:([0-4]):([0-3])$/.exec(input);
    if (answer) {
      if (validAnswer(assigned[Number(answer[1])], Number(answer[2]))) return;
      throw new Error("Invalid answer for this question.");
    }
    if (/^nav:[0-4]$/.test(input) || input === "edit" || input === "visibility") return;
    if ((input === `nav:${QUESTION_COUNT}` || input === "submit") &&
        assigned.every((q, i) => validAnswer(q, quiz.answers[i]))) return;
    throw new Error("Answer all five questions before submitting.");
  },
  isActionComplete: (game, action) => all(game)[action.ownerId]?.submitted ?? false,
  onActionSubmitted(game, action) {
    const input = choice(action);
    const quizzes = all(game);
    const quiz = validatedQuiz(game, action.ownerId);
    if (input.startsWith("answer:")) {
      const [, i, answer] = input.split(":").map(Number);
      quiz.answers[i] = answer;
      quiz.cursor = Math.min(QUESTION_COUNT, i + 1);
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
    for (const id of roster) types[id] = quizzes[id]?.submitted ? classify(quizzes[id].answers, quizzes[id].questionIds) : "Unclassified";
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
      .map((p) => `${participantLabel(game, p.discordSnowflake)} - ${quizzes[p.discordSnowflake]?.hidden ? "Hidden" : types[p.discordSnowflake] ?? "Unclassified"}`).join("\n");
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
