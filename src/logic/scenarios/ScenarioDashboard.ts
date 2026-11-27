import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type UserSelectMenuInteraction, UserSelectMenuBuilder, MessageFlags } from "discord.js";
import type { GameInstance } from "../../database/GameInstance";
import { Channels } from "../../Channels";
import { PermissionsUtil } from "../../util/PermissionsUtil";
import { fetchGuildMember } from "../../util/DiscordFailures";
import TeamCommand from "../../commands/TeamCommand";
import { GuildMembership } from "../GuildMembership";
import { DiscordUtil } from "../../util/DiscordUtil";

const stageLabels: Record<string, string> = {
  lock: "Generate Teams", election: "Start Voting", close: "Close Voting",
  draft: "Start Draft", wildcards: "Enable Wildcards", hex: "Open Class Assignments",
};

/** Read-only dashboard. Every mutation goes back through the coordinator. */
export function scenarioDashboard(game: GameInstance) {
  const token = game.getLifecycleToken();
  const scenario = game.scenarios;
  const revision = scenario.controlRevision;
  const state = scenario.snapshot();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`fwscpanel:${token}:refresh`)
      .setLabel("Refresh").setStyle(ButtonStyle.Secondary),
  );
  const next = scenario.nextManualStage();
  if (state?.phase === "collecting" && next && stageLabels[next.id]) {
    row.addComponents(new ButtonBuilder().setCustomId(`fwscpanel:${token}:start:${next.id}:${revision}`)
      .setLabel(stageLabels[next.id]).setStyle(ButtonStyle.Primary));
  }
  if (state?.phase === "ready" && scenario.definition?.implementation?.approveResult)
    row.addComponents(new ButtonBuilder().setCustomId(`fwscpanel:${token}:approve:result:${revision}`)
      .setLabel("Confirm Result").setStyle(ButtonStyle.Success));
  if (scenario.hasRuntime) {
    row.addComponents(new ButtonBuilder().setCustomId(`fwscpanel:${token}:runtime-stop:runtime:${revision}`)
      .setLabel("Stop Scenario").setStyle(ButtonStyle.Danger));
    if (scenario.runtimeShutdownBlock()?.includes("reconciliation"))
      row.addComponents(new ButtonBuilder().setCustomId(`fwscpanel:${token}:runtime-cleanup:runtime:${revision}`)
        .setLabel("Confirm Manual Cleanup").setStyle(ButtonStyle.Danger));
  }
  const rows: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<UserSelectMenuBuilder>)[] = state ? [row] : [];
  if (scenario.hasRuntime) {
    rows.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId(`fwscpanel:${token}:runtime-moderation:runtime:${revision}`)
        .setPlaceholder("Stop and preserve staff voice action for member").setMinValues(1).setMaxValues(1)));
  }
  if (state?.id === "peoples-captains" && state.version === 2 && state.data.ranked && !state.data.confirmed && !state.data.roleAssignmentStarted &&
      ["ready", "needs_review"].includes(state.phase) && !game.getCaptainOfTeam("RED") && !game.getCaptainOfTeam("BLUE")) {
    const recovery = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`fwscpanel:${token}:review:roster:${revision}`)
        .setLabel("Review Roster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`fwscpanel:${token}:replace:RED:${revision}`)
        .setLabel("Replace RED Captain").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`fwscpanel:${token}:replace:BLUE:${revision}`)
        .setLabel("Replace BLUE Captain").setStyle(ButtonStyle.Danger),
    );
    rows.push(recovery);
  }
  return { content: scenario.triggerStatus(), components: rows };
}

export async function handleScenarioDashboard(game: GameInstance, interaction: ButtonInteraction | UserSelectMenuInteraction): Promise<void> {
  try {
    const [prefix, token, action, stage, revision] = interaction.customId.split(":");
    const guild = interaction.guild;
    if (prefix !== "fwscpanel" || token !== game.getLifecycleToken() || !guild ||
        (Channels.gameFeed?.guild && guild.id !== Channels.gameFeed.guild.id))
      throw new Error("That scenario dashboard is no longer available.");
    const member = await fetchGuildMember(guild, interaction.user.id);
    if (!PermissionsUtil.hasRole(member ?? undefined, "organiserRole"))
      throw new Error("Only organisers can manage scenario preparation.");
    if (token !== game.getLifecycleToken()) throw new Error("That game has changed.");
    if (interaction.isUserSelectMenu?.() && action !== "runtime-moderation") throw new Error("Invalid scenario control.");
    if (action === "runtime-moderation" && !interaction.isUserSelectMenu()) throw new Error("Invalid scenario control.");
    if (action === "refresh") {
      await interaction.update(scenarioDashboard(game));
      return;
    }
    await interaction.deferUpdate();
    if (token !== game.getLifecycleToken() || revision !== game.scenarios.controlRevision)
      throw new Error("That scenario result or stage has changed. Refresh the dashboard.");
    if (action === "start" && stage && game.scenarios.nextManualStage()?.id === stage)
      await game.scenarios.startNextManualTrigger(stage, guild);
    else if (action === "approve" && game.scenarios.phase === "ready")
      await game.scenarios.approveResult(guild, revision);
    else if (stage === "runtime" && (action === "runtime-stop" || action === "runtime-cleanup" || action === "runtime-moderation")) {
      const operate = async () => {
        if (token !== game.getLifecycleToken() || revision !== game.scenarios.controlRevision || !game.scenarios.hasRuntime)
          throw new Error("That scenario dashboard is no longer available.");
        if (action === "runtime-stop") await game.scenarios.stopRuntime();
        else if (action === "runtime-moderation" && interaction.isUserSelectMenu() && interaction.values.length === 1)
          await game.scenarios.preserveRuntimeModeration(interaction.values[0]);
        else if (action === "runtime-cleanup") game.scenarios.confirmRuntimeCleanup();
        else throw new Error("Invalid scenario control.");
      };
      if (TeamCommand.instance) await TeamCommand.instance.runRosterOperation(operate);
      else await operate();
    }
    else if ((action === "review" && stage === "roster") || (action === "replace" && (stage === "RED" || stage === "BLUE"))) {
      const command = TeamCommand.instance;
      if (!command) throw new Error("Team picking is unavailable.");
      const message = await command.runRosterOperation(async () => {
        await GuildMembership.reconcile(guild, command);
        if (token !== game.getLifecycleToken()) throw new Error("That game has changed.");
        return game.scenarios.reviewElectionRoster(revision, action === "replace" ? stage as "RED" | "BLUE" : undefined);
      });
      await DiscordUtil.sendMessage("gameFeed", { content: message + " The updated result still needs organiser confirmation.", allowedMentions: { parse: [] } });
    }
    else throw new Error("That action is no longer available. Refresh the dashboard.");
    await interaction.editReply(scenarioDashboard(game));
  } catch (error) {
    const content = error instanceof Error ? error.message : "Scenario control unavailable.";
    if (interaction.deferred || interaction.replied)
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
