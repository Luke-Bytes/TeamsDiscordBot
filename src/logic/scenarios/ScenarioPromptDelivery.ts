import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { GameInstance } from "../../database/GameInstance";

/** Never place private scenario controls in a public registration reply. */
export async function deliverScenarioRegistrationPrompt(
  interaction: ChatInputCommandInteraction,
  game: GameInstance,
  userId: string
): Promise<void> {
  const token = game.getLifecycleToken();
  try {
    const prompt = await game.scenarios.registrationPrompt(userId);
    if (!prompt || !game.announced || game.getLifecycleToken() !== token ||
        !game.getPlayers().some((p) => p.discordSnowflake === userId)) return;
    if (interaction.user.id === userId) {
      await interaction.followUp({ ...prompt, flags: MessageFlags.Ephemeral });
    } else {
      const target = await interaction.client.users.fetch(userId);
      await target.send({ content: prompt.content, components: prompt.components });
    }
    if (game.getLifecycleToken() === token) game.scenarios.markPromptDelivered(userId);
  } catch (error) {
    if (game.getLifecycleToken() === token) game.scenarios.markPromptFailed(userId);
    console.warn("Scenario private registration prompt failed (registration is retained):",
      error instanceof Error ? error.message : String(error));
    // The participant can reopen the pending action via /game scenario open.
  }
}
