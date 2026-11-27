import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client, MessageFlags } from "discord.js";
import { Channels } from "../../Channels";
import { fetchGuildMember } from "../../util/DiscordFailures";
import { DiscordUtil } from "../../util/DiscordUtil";
import type { ScenarioPrivatePrompt } from "./ScenarioTypes";

/** A fallback contains no private choices and the button always opens the clicker's own editor. */
export function openScenarioButton(game: GameInstance) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`fwscopen:${game.getLifecycleToken()}`)
      .setLabel("Open My Scenario").setStyle(ButtonStyle.Primary),
  );
}

export async function deliverScenarioAction(
  game: GameInstance, userId: string, client: Client, actionId?: string,
  reminder = false, notifyFallback = true,
): Promise<"delivered" | "failed" | "unavailable"> {
  const token = game.getLifecycleToken();
  let prompt: ScenarioPrivatePrompt | null;
  let id = actionId;
  try {
    const guild = Channels.gameFeed?.guild ?? Channels.teamPicking?.guild;
    if (!guild || !(await fetchGuildMember(guild, userId))) return "unavailable";
    if (game.getLifecycleToken() !== token) return "unavailable";
    if (game.scenarios.hasRuntime) {
      const user = await client.users.fetch(userId);
      if (game.getLifecycleToken() !== token || !game.scenarios.hasRuntime) return "unavailable";
      const privatePrompt = await game.scenarios.reopenAction(userId);
      if (!privatePrompt) return "unavailable";
      try {
        await user.send({ content: privatePrompt.content, components: privatePrompt.components });
        if (game.getLifecycleToken() === token) game.scenarios.markPromptDelivered(userId);
        return "delivered";
      } catch { return "failed"; }
    }
    prompt = id ? await game.scenarios.renderPrivateAction(id) : await game.scenarios.reopenAction(userId);
    if (!id) id = game.scenarios.availableActions().reverse().find((a) => a.ownerId === userId)?.id;
    const active = () => game.getLifecycleToken() === token &&
      game.scenarios.availableActions().some((a) => a.id === id && a.ownerId === userId &&
        (!reminder || !game.scenarios.actionComplete(a)));
    if (!prompt || !id || !active()) return "unavailable";
    const user = await client.users.fetch(userId);
    if (!active()) return "unavailable";
    await user.send({ content: `${reminder ? "Scenario reminder - your response is still outstanding.\n" : ""}${prompt.content}`, components: prompt.components });
    if (active()) game.scenarios.markPromptDelivered(userId, id);
    return "delivered";
  } catch {
    if (game.getLifecycleToken() !== token || !id ||
        !game.scenarios.availableActions().some((a) => a.id === id && a.ownerId === userId)) return "unavailable";
    game.scenarios.markPromptFailed(userId, id);
    if (!reminder && notifyFallback) await DiscordUtil.sendMessage("gameFeed", {
      content: `<@${userId}>, I couldn’t send you your scenario instructions. Click below to open them privately.`,
      components: [openScenarioButton(game)],
      allowedMentions: { users: [userId] },
    }).catch(() => {});
    return "failed";
  }
}
import { GameInstance } from "../../database/GameInstance";

/** Never place private scenario controls in a public registration reply. */
export async function deliverScenarioRegistrationPrompt(
  interaction: ChatInputCommandInteraction,
  game: GameInstance,
  userId: string,
  token = game.getLifecycleToken(),
): Promise<void> {
  if (game.getLifecycleToken() !== token) return;
  try {
    const prompt = await game.scenarios.registrationPrompt(userId);
    if (!prompt || !game.announced || game.getLifecycleToken() !== token ||
        !game.getPlayers().some((p) => p.discordSnowflake === userId)) return;
    if (interaction.user.id === userId) {
      await interaction.followUp({ ...prompt, flags: MessageFlags.Ephemeral });
    } else {
      const target = await interaction.client.users.fetch(userId);
      if (game.getLifecycleToken() !== token) return;
      await target.send({ content: prompt.content, components: prompt.components });
    }
    if (game.getLifecycleToken() === token) game.scenarios.markPromptDelivered(userId);
  } catch (error) {
    if (game.getLifecycleToken() === token) {
      game.scenarios.markPromptFailed(userId);
      if (Channels.gameFeed?.guild) await DiscordUtil.sendMessage("gameFeed", {
        content: `<@${userId}>, I couldn’t send you your scenario instructions. Click below to open them privately.`,
        components: [openScenarioButton(game)],
        allowedMentions: { users: [userId] },
      }).catch(() => {});
    }
    console.warn("Scenario private registration prompt failed (registration is retained):",
      error instanceof Error ? error.message : String(error));
    // The participant can reopen the pending action via /game scenario open.
  }
}
