import {
  ButtonInteraction, MessageFlags, ModalSubmitInteraction, StringSelectMenuInteraction, UserSelectMenuInteraction,
} from "discord.js";
import { GameInstance } from "../../database/GameInstance";
import TeamCommand from "../../commands/TeamCommand";
import { ScenarioDraftSession } from "./drafts/ScenarioDraftSession";
import { PermissionsUtil } from "../../util/PermissionsUtil";
import { fetchGuildMember } from "../../util/DiscordFailures";
import { ScenarioValue } from "./ScenarioTypes";
import { Channels } from "../../Channels";
import { handleScenarioDashboard } from "./ScenarioDashboard";

type ScenarioInteraction = ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction;

export function isScenarioInteraction(interaction: { customId: string }): boolean {
  return interaction.customId.startsWith("fwscr:") || interaction.customId.startsWith("fwsc:") ||
    interaction.customId.startsWith("fwscapprove:") ||
    interaction.customId.startsWith("fwscdraft:") || interaction.customId.startsWith("fwscpanel:") || interaction.customId.startsWith("fwscopen:");
}

/** Common private Discord adapter. Unique game/user/phase/deadline checks live in the coordinator. */
export async function routeScenarioInteraction(interaction: ScenarioInteraction): Promise<void> {
  const game = GameInstance.getInstance();
  if (interaction.customId.startsWith("fwscpanel:") && (interaction.isButton() || interaction.isUserSelectMenu())) {
    await handleScenarioDashboard(game, interaction);
    return;
  }
  if (interaction.customId.startsWith("fwscopen:") && interaction.isButton()) {
    try {
      const guild = Channels.gameFeed?.guild;
      if (!guild || interaction.guild?.id !== guild.id ||
          interaction.customId !== `fwscopen:${game.getLifecycleToken()}` ||
          !(await fetchGuildMember(guild, interaction.user.id)))
        throw new Error("This scenario prompt is no longer available.");
      const token = game.getLifecycleToken();
      const prompt = await game.scenarios.reopenAction(interaction.user.id);
      if (!prompt || token !== game.getLifecycleToken())
        throw new Error("There’s nothing for you to fill in right now. Register first if you haven’t already, and keep an eye on the game feed.");
      await interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral });
      if (token === game.getLifecycleToken()) game.scenarios.markPromptDelivered(interaction.user.id);
    } catch (error) {
      if (!interaction.replied) await interaction.reply({ content: error instanceof Error ? error.message : "Scenario unavailable.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (interaction.customId.startsWith("fwscapprove:")) {
    try {
      if (!interaction.isButton() || interaction.customId !== `fwscapprove:${game.getLifecycleToken()}:${game.scenarios.controlRevision}` || !interaction.guild ||
          (Channels.gameFeed?.guild && interaction.guild.id !== Channels.gameFeed.guild.id))
        throw new Error("That approval is no longer available.");
      const member = await fetchGuildMember(interaction.guild, interaction.user.id);
      if (!PermissionsUtil.hasRole(member ?? undefined, "organiserRole"))
        throw new Error("Only organisers can approve scenario results.");
      const revision = interaction.customId.split(":")[2];
      const token = interaction.customId.split(":")[1];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (token !== game.getLifecycleToken()) throw new Error("That game has changed.");
      await game.scenarios.approveResult(interaction.guild, revision);
      await interaction.editReply("Scenario result confirmed.");
    } catch (error) {
      const content = error instanceof Error ? error.message : "Scenario approval failed.";
      if (interaction.deferred) await interaction.editReply(content);
      else if (!interaction.replied) await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (interaction.customId.startsWith("fwscdraft:")) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    try {
      const guild = Channels.teamPicking?.guild;
      if (!guild || interaction.guild?.id !== guild.id || !(await fetchGuildMember(guild, interaction.user.id)))
        throw new Error("Only members of the current game server can use draft controls.");
      const command = TeamCommand.instance;
      if (!command) throw new Error("Team picking is unavailable.");
      await command.runRosterOperation(async () => {
        const session = command.teamPickingSession;
        if (!(session instanceof ScenarioDraftSession)) throw new Error("That draft session is no longer active.");
        await session.handleControl(interaction);
      });
    } catch (error) {
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: error instanceof Error ? error.message : "Draft interaction failed.", flags: MessageFlags.Ephemeral });
      else console.error("Scenario draft control failed:", error);
    }
    return;
  }
  let value: ScenarioValue;
  if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
    value = [...interaction.values];
  } else if (interaction.isModalSubmit()) {
    value = Object.fromEntries(
      interaction.fields.fields.map((field) => [field.customId, field.value])
    );
  } else {
    value = true;
  }

  try {
    // Permission data must come from Discord, never a client-supplied flag.
    const guild = Channels.gameFeed?.guild ?? Channels.teamPicking?.guild;
    if (!guild || (interaction.guild && interaction.guild.id !== guild.id))
      throw new Error("This interaction does not belong to the current game server.");
    const member = await fetchGuildMember(guild, interaction.user.id);
    if (!member) throw new Error("You must be a current member of the game server.");
    const organiser = PermissionsUtil.hasRole(member ?? undefined, "organiserRole");
    const submit = () => game.scenarios.applyAction(interaction.customId, interaction.user.id, value, organiser);
    const result = TeamCommand.instance
      ? await TeamCommand.instance.runRosterOperation(submit)
      : await submit();
    if (typeof result === "string") {
      await interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
    } else {
      if (interaction.isModalSubmit() || (interaction.customId.startsWith("fwscr:") && interaction.guild && !interaction.message.flags.has(MessageFlags.Ephemeral))) await interaction.reply({ ...result, flags: MessageFlags.Ephemeral });
      else await interaction.update({ content: result.content, components: result.components ?? [] });
    }
  } catch (error) {
    if (!interaction.replied && !interaction.deferred) await interaction.reply({
      content: error instanceof Error ? error.message : "That scenario interaction is no longer available.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
