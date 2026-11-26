import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import type { GameInstance } from "../../database/GameInstance";
import type { ScenarioAction, ScenarioPrivatePrompt, ScenarioTeamProposal, ScenarioValue } from "./ScenarioTypes";
import { Channels } from "../../Channels";
import { DiscordUtil } from "../../util/DiscordUtil";
import TeamCommand from "../../commands/TeamCommand";
import { deliverScenarioAction } from "./ScenarioPromptDelivery";

export function data<T>(game: GameInstance, key: string, fallback: T): T {
  return (game.scenarios.snapshot()?.data[key] ?? fallback) as T;
}

export function choice(action: ScenarioAction): string {
  return Array.isArray(action.response) && typeof action.response[0] === "string"
    ? action.response[0] : "";
}

export function selectPrompt(
  content: string, customId: string,
  options: { label: string; value: string; description?: string }[],
  placeholder = "Make a choice",
): ScenarioPrivatePrompt {
  if (!options.length) return { content };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId).setPlaceholder(placeholder).addOptions(options.slice(0, 25));
  return { content, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export function openScenarioAction(
  game: GameInstance, ownerId: string, kind: string, role: ScenarioAction["role"], deadline: Date,
  allowUpdates = true,
): string {
  return game.scenarios.openAction({
    id: randomUUID().replace(/-/g, "").slice(0, 16), kind, role, ownerId,
    deadline: deadline.toISOString(), allowUpdates,
  });
}

export async function deliverAction(game: GameInstance, userId: string, customId: string): Promise<boolean> {
  const client = Channels.gameFeed?.client ?? Channels.teamPicking?.client;
  if (!client) {
    game.scenarios.markPromptFailed(userId, customId.split(":")[2]);
    return false;
  }
  return (await deliverScenarioAction(game, userId, client, customId.split(":")[2], false, false)) === "delivered";
}

/** Notifications that do not contain an editor (e.g. final assigned class). */
export async function deliverPrivate(game: GameInstance, userId: string, prompt: ScenarioPrivatePrompt): Promise<boolean> {
  try {
    const user = await Channels.teamPicking.client.users.fetch(userId);
    await user.send({ content: prompt.content, components: prompt.components });
    return true;
  } catch {
    // Private prompts can be reopened via /game scenario open.
    return false;
  }
}

/** No nested roster lock: the caller already owns it during activation. */
export function publishTeamProposal(game: GameInstance, proposal: ScenarioTeamProposal): void {
  const token = game.getLifecycleToken();
  const revision = game.scenarios.controlRevision;
  queueMicrotask(() => {
    void (async () => {
      try {
        if (token !== game.getLifecycleToken() || game.scenarios.phase !== "ready" || revision !== game.scenarios.controlRevision)
          return;
        if (!Channels.teamPicking?.guild || !TeamCommand.instance)
          throw new Error("Team review channel or command unavailable.");
        await TeamCommand.instance.previewScenarioTeams(Channels.teamPicking.guild, proposal, token, revision);
      } catch (error) {
        if (token !== game.getLifecycleToken() || revision !== game.scenarios.controlRevision) return;
        game.scenarios.needsReview(`Failed to publish team preview: ${error instanceof Error ? error.message : "unknown error"}`);
        await DiscordUtil.sendMessage("gameFeed", "⚠️ Scenario team preview could not be published. Organiser review required.").catch(() => {});
      }
    })();
  });
}

export function publicMetadata(game: GameInstance, fields: Record<string, ScenarioValue>): ScenarioValue {
  return { ...fields, participants: game.getPlayers().length };
}

export function participantLabel(game: GameInstance, id: string): string {
  const player = game.getPlayers().find((p) => p.discordSnowflake === id);
  return (player?.ignUsed ?? player?.latestIGN ?? id).replace(/[<@\x00-\x1f]/g, "");
}
