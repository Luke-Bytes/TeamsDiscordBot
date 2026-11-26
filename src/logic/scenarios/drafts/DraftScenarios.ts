import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { escapeIgn } from "../../../util/Utils";
import { MYSTERY_HINT } from "./MaskedDraftHints";
import TeamCommand from "../../../commands/TeamCommand";
import { ScenarioDraftSession, ScenarioDraftProgress, ScenarioDraftMode } from "./ScenarioDraftSession";
import { data } from "../ScenarioGameplay";

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
      if (!progress || progress.mode !== "masked" || !progress.finished || progress.remaining.length)
        throw new Error("Masked draft mapping is incomplete; identities cannot be revealed safely.");
      const cards = Object.entries(progress.cards);
      const picks = [...progress.red, ...progress.blue];
      const red = game.getPlayersOfTeam("RED");
      const blue = game.getPlayersOfTeam("BLUE");
      const matches = (ids: string[], players: typeof red) =>
        ids.length === players.length && new Set(ids).size === ids.length &&
        players.every((player) => ids.includes(player.discordSnowflake));
      if (cards.length !== picks.length || new Set(cards.map(([, id]) => id)).size !== picks.length ||
          !cards.every(([card, id]) => /^M[0-9]{2,}$/.test(card) && picks.includes(id)) ||
          new Set([progress.redCaptain, progress.blueCaptain, ...picks]).size !== picks.length + 2 ||
          !matches([progress.redCaptain, ...progress.red], red) ||
          !matches([progress.blueCaptain, ...progress.blue], blue))
        throw new Error("Masked draft mapping does not match the confirmed teams.");
      const lookup = new Map([...red, ...blue].map((player) => [player.discordSnowflake, player]));
      const header = "🎭 **The Masked Draft - identities revealed!**";
      const messages: string[] = [];
      let message = header;
      for (const side of ["RED", "BLUE"] as const) {
        message += `\n\n**${side === "RED" ? "🔴 RED" : "🔵 BLUE"}**`;
        for (const [card, id] of cards.filter(([, id]) => progress[side === "RED" ? "red" : "blue"].includes(id))) {
          const player = lookup.get(id)!;
          const name = escapeIgn(player.ignUsed ?? player.latestIGN ?? "Unnamed player");
          const line = `\n**${card}** - ${name} · ${progress.cardHints?.[card] ?? MYSTERY_HINT}`;
          if (message.length + line.length > 1800) {
            messages.push(message);
            message = `${header}\n\n**${side} (continued)**`;
          }
          message += line;
        }
      }
      messages.push(message);
      for (const content of messages)
        await DiscordUtil.sendMessage("gameFeed", { content, allowedMentions: { parse: [] } });
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
      return mode === "masked" ? "Anonymous cards may show shared match results with today's captains, map records or other sample-backed match history, never Elo. Identities are revealed only after team confirmation."
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
