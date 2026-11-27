import { ComponentType, EmbedBuilder, type Message } from "discord.js";
import type { GameInstance } from "../../database/GameInstance";
import type { ScenarioDefinition } from "./ScenarioTypes";
import { Channels } from "../../Channels";
import { scenarioInformation, scenarioGuideButton, GUIDE_OPEN_ID } from "./ScenarioGuide";

/** Keep the primary announcement first for existing recovery and edit paths. */
export function announcementScenarioEmbeds(base: EmbedBuilder, definition?: ScenarioDefinition): EmbedBuilder[] {
  if (!definition) return [base];
  const page = scenarioInformation(definition);
  // Discord applies a 6000-character limit across all embeds in a message.
  return base.length + page.length <= 6000 ? [base, page] : [base];
}

const feedMessages = new WeakMap<GameInstance, { token: string; message: Message }>();

/** Advisory publication: the confirmed announcement must not depend on this extra content. */
export async function publishScenarioInformation(game: GameInstance, base: EmbedBuilder): Promise<void> {
  const definition = game.scenarios.definition;
  if (!definition) return;
  const token = game.getLifecycleToken();
  const current = () => game.getLifecycleToken() === token && game.scenarios.selectedId === definition.id;
  try {
    if (current()) await game.announcementMessage?.edit({
      embeds: announcementScenarioEmbeds(base, definition),
      components: [scenarioGuideButton(token)],
    });
  } catch (error) {
    console.warn("Could not attach scenario information to announcement:", error instanceof Error ? error.message : String(error));
  }
  try {
    if (!current() || feedMessages.get(game)?.token === token || !Channels.gameFeed?.isSendable()) return;
    const message = await Channels.gameFeed.send({
      embeds: [scenarioInformation(definition)],
      components: [scenarioGuideButton(token)],
    });
    if (current()) feedMessages.set(game, { token, message });
    else await message.delete();
  } catch (error) {
    console.warn("Could not publish scenario information in game feed:", error instanceof Error ? error.message : String(error));
  }
}

/** Remove active instructions when an organiser cancels just the scenario. */
export async function clearScenarioInformation(game: GameInstance, token: string, previousName?: string): Promise<void> {
  if (game.getLifecycleToken() !== token || game.scenarios.selectedId) return;
  const refs = [game.announcementMessage, game.announcementPreviewMessage];
  for (const message of refs) {
    if (!message || game.getLifecycleToken() !== token) continue;
    try {
      const base = message.embeds[0];
      if (!base) continue;
      const updated = new EmbedBuilder(base.toJSON()).setFields(
        base.fields.map((field) => field.name === "🎭 **SCENARIO**" ? { ...field, value: "None" } : field),
      );
      await message.edit({
        embeds: [updated],
        ...(message === game.announcementMessage ? { components: [] } : {}),
      });
    } catch (error) {
      console.warn("Could not remove cancelled scenario from announcement:", error instanceof Error ? error.message : String(error));
    }
  }
  const feed = feedMessages.get(game);
  if (feed?.token === token) {
    feedMessages.delete(game);
    try { await feed.message.delete(); }
    catch (error) {
      console.warn("Could not remove cancelled scenario information from game feed:", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  // Preserved restarts restore the match token, not this advisory in-memory
  // reference. Only consider recent bot-authored, exact match-bound guide pages.
  if (!previousName || game.getLifecycleToken() !== token) return;
  try {
    const channel = Channels.gameFeed;
    if (!channel?.client.user) return;
    const recent = await channel.messages.fetch({ limit: 100 });
    for (const message of recent.values()) {
      if (game.getLifecycleToken() !== token || game.scenarios.selectedId) break;
      if (message.author.id !== channel.client.user.id || message.embeds.length !== 1 ||
          message.embeds[0].title !== previousName) continue;
      const ids = message.components.flatMap((row) =>
        row.type === ComponentType.ActionRow ? row.components.flatMap((component) =>
          "customId" in component ? [component.customId] : []) : []);
      if (ids.includes(`${GUIDE_OPEN_ID}:${token}`) ||
          (ids.includes(GUIDE_OPEN_ID) && ids.includes(`fwscopen:${token}`))) {
        await message.delete();
      }
    }
  } catch (error) {
    console.warn("Could not locate cancelled scenario information after recovery:", error instanceof Error ? error.message : String(error));
  }
}
