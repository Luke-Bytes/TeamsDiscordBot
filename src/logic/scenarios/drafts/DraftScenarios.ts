import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { Channels } from "../../../Channels";
import TeamCommand from "../../../commands/TeamCommand";
import { ScenarioDraftSession, ScenarioDraftProgress, ScenarioDraftMode } from "./ScenarioDraftSession";
import { data, participantLabel } from "../ScenarioGameplay";

export function makeDraftScenario(mode: ScenarioDraftMode): ScenarioImplementation {
  const selected = mode === "masked" ? "masked-draft" : "draft-roulette";
  return {
    async activateTrigger(game, policy) {
      if (policy.id !== "draft") return;
      game.scenarios.assertCapturedRoster("draft");
      if (!TeamCommand.instance) throw new Error("Team command unavailable.");
      await TeamCommand.instance.startScenarioDraftUnderLock(mode);
    },
    async onTeamsFinalized(game) {
      if (mode !== "masked" || game.scenarios.selectedId !== selected ||
          game.scenarios.phase !== "completed" || !game.hasFinalizedPlayableTeams()) return;
      const progress = data<ScenarioDraftProgress | null>(game, "draft", null);
      if (!progress || Object.keys(progress.cards).length !== progress.red.length + progress.blue.length)
        throw new Error("Masked draft mapping is incomplete; identities cannot be revealed safely.");
      const text = Object.entries(progress.cards).sort(([a], [b]) => a.localeCompare(b))
        .map(([card, id]) => {
          const side = game.getPlayersOfTeam("RED").some((p) => p.discordSnowflake === id)
            ? "RED" : "BLUE";
          return `**${card}** was ${participantLabel(game, id)} — **${side}**`;
        }).join("\n");
      await DiscordUtil.sendMessage("gameFeed", `🎭 **The Masked Draft — identities revealed!**\n${text}`);
    },
    publicResult(game): ScenarioValue {
      const p = data<ScenarioDraftProgress | null>(game, "draft", null);
      return {
        picks: (p?.red.length ?? 0) + (p?.blue.length ?? 0),
        ...(mode === "roulette"
          ? { redReroll: p?.rerolls.RED ?? false, blueReroll: p?.rerolls.BLUE ?? false }
          : { revealed: game.scenarios.phase === "completed" }),
      };
    },
    publicSummary(game) {
      return mode === "masked" ? "Anonymous cards are revealed only after team confirmation."
        : "Each captain chooses from a frozen hand of up to three and has one reroll.";
    },
    organiserSummary(game) {
      const p = data<ScenarioDraftProgress | null>(game, "draft", null);
      return p ? `Pick ${p.pickIndex}, remaining ${p.remaining.length}, first captain ${p.first}. ${p.finished ? "Awaiting confirmation" : "Picking in progress"}.`
        : "Awaiting captains and draft start.";
    },
    checkReadyToStart(game) {
      return game.hasFinalizedPlayableTeams() ? null : "Scenario draft teams are not confirmed.";
    },
    async onCancel(_game: GameInstance) {
      const active = TeamCommand.instance?.teamPickingSession;
      if (active instanceof ScenarioDraftSession && active.mode === mode &&
          active.getState() === "inProgress") await active.cancelSession();
    },
    onRestore(game) {
      // The recovery coordinator pauses unfinished drafts and retains the exact
      // mapping, pick history, offers and deadlines for organiser inspection.
      if (game.scenarios.phase === "completed") return;
      const p = data<ScenarioDraftProgress | null>(game, "draft", null);
      if (p && p.mode !== mode)
        game.scenarios.needsReview("Restored draft mode does not match the stored progress.");
    },
  };
}
export const maskedDraft = makeDraftScenario("masked");
export const draftRoulette = makeDraftScenario("roulette");
