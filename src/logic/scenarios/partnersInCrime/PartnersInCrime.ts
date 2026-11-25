import { ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioImplementation, ScenarioPrivatePrompt, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { allocateScenarioTeams, ScenarioPair } from "../ScenarioTeamAllocation";
import { choice, data, participantLabel, publishTeamProposal } from "../ScenarioGameplay";

export interface Preference { target: string | null; reveal: boolean }
type Preferences = Record<string, Preference>;
function preferences(game: GameInstance): Preferences { return data<Preferences>(game, "preferences", {}); }
export function mutualPairs(prefs: Preferences, eligible: readonly string[]): ScenarioPair[] {
  const valid = new Set(eligible);
  return Object.entries(prefs)
    .filter(([id, p]) => valid.has(id) && p.target && p.target !== id &&
      valid.has(p.target) && prefs[p.target]?.target === id && id < p.target)
    .map(([a, p]) => ({ a, b: p.target! }));
}
function render(game: GameInstance, userId: string, customId: string): ScenarioPrivatePrompt {
  const p = preferences(game)[userId] ?? { target: null, reveal: false };
  const current = p.target ? participantLabel(game, p.target) : "No preference";
  return {
    content: `🤝 **Partners in Crime**\nYour choice: **${current}**. Only mutual choices become pairs. Nobody is notified of one-sided preferences.\nBoth players must consent before a successful pair is named publicly. Public reveal: **${p.reveal ? "Yes" : "No"}**.\nEdit as often as you like before the cutoff; /game scenario open reopens this editor.`,
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId(customId)
          .setPlaceholder("Choose one registered teammate").setMinValues(1).setMaxValues(1),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Other choices")
          .addOptions(
            { label: "No preference", value: "none" },
            { label: "Allow mutual pair public reveal", value: "reveal:yes" },
            { label: "Keep mutual pair private", value: "reveal:no" },
          ),
      ),
    ],
  };
}
export const partnersInCrime: ScenarioImplementation = {
  registrationPrompt: (game, id, customId) => render(game, id, customId),
  renderAction: (game, action, customId) => render(game, action.ownerId, customId),
  validateAction(game, action, value) {
    if (action.kind !== "preferences") throw new Error("Invalid preference action.");
    const input = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
    if (["none", "reveal:yes", "reveal:no"].includes(input)) return;
    if (input === action.ownerId) throw new Error("You cannot nominate yourself.");
    if (!game.getPlayers().some((p) => p.discordSnowflake === input))
      throw new Error("That player is not registered. Please choose a registered teammate.");
  },
  onActionSubmitted(game, action) {
    const prefs = preferences(game);
    const current = prefs[action.ownerId] ?? { target: null, reveal: false };
    const input = choice(action);
    if (input === "none") current.target = null;
    else if (input.startsWith("reveal:")) current.reveal = input === "reveal:yes";
    else current.target = input;
    prefs[action.ownerId] = current;
    game.scenarios.setData("preferences", prefs as unknown as ScenarioValue);
  },
  onRegistrationChanged(game, id, joined) {
    if (joined) return;
    const prefs = preferences(game);
    delete prefs[id];
    for (const p of Object.values(prefs)) if (p.target === id) p.target = null;
    game.scenarios.setData("preferences", prefs as unknown as ScenarioValue);
  },
  activateTrigger(game, policy, roster) {
    if (policy.id !== "lock") return;
    game.scenarios.assertCapturedRoster("lock");
    const pairs = mutualPairs(preferences(game), roster);
    const allocated = allocateScenarioTeams(game, {}, pairs);
    game.scenarios.markReady({
      red: allocated.proposal.red, blue: allocated.proposal.blue,
      pairs: pairs.map(({ a, b }) => [a, b]),
      kept: allocated.kept.map(({ a, b }) => [a, b]),
      split: allocated.split.map(({ a, b }) => [a, b]),
    });
    publishTeamProposal(game, allocated.proposal);
  },
  organiserSummary(game) {
    const info = game.scenarios.snapshot()?.data ?? {};
    const pairList = (info.pairs ?? []) as string[][];
    const split = (info.split ?? []) as string[][];
    return `Mutual pairs: ${pairList.length}. Preserved: ${pairList.length - split.length}. Exceptions: ${split.length}.` +
      (split.length ? `\nSplit to preserve size/captain constraints: ${split.map((ids) => ids.map((id) => participantLabel(game, id)).join(" + ")).join(", ")}.` : "") +
      "\nUnilateral preferences are private.";
  },
  async onTeamsFinalized(game) {
    if (game.scenarios.phase !== "completed" || game.scenarios.selectedId !== "partners-in-crime") return;
    const kept = data<string[][]>(game, "kept", []);
    const prefs = preferences(game);
    const visible = kept.filter(([a, b]) => prefs[a]?.reveal && prefs[b]?.reveal);
    await DiscordUtil.sendMessage("gameFeed",
      `🤝 **Partners in Crime teams locked!** ${kept.length} mutual pair(s) kept together.` +
      (visible.length ? `\nDynamic duos: ${visible.map(([a, b]) => `${participantLabel(game, a)} & ${participantLabel(game, b)}`).join(", ")}` : "") +
      "\nPrivate and one-sided preferences remain undisclosed.");
  },
  publicResult(game) {
    return { mutualPairs: data<string[][]>(game, "pairs", []).length, preserved: data<string[][]>(game, "kept", []).length };
  },
  checkReadyToStart(game) {
    return game.hasFinalizedPlayableTeams() ? null : "Partner-based teams have not been confirmed.";
  },
};
