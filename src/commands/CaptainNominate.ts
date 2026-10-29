import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ButtonInteraction,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil.js";
import { GameInstance } from "../database/GameInstance";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import TeamCommand from "./TeamCommand";
import { Team } from "@prisma/client";
import { escapeIgn } from "../util/Utils";
import { PrismaUtils } from "../util/PrismaUtils";
import { fetchGuildMember } from "../util/DiscordFailures";

export default class CaptainNominateCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("captainnominate")
    .setDescription("Nominate yourself to be a captain");

  name = "captainnominate";
  description = "Nominate yourself to be a captain";
  buttonIds = ["captainnominate-set:"];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = GameInstance.getInstance();
    if (!game.announced) {
      await interaction.reply({ content: "No game has been announced yet!" });
      return;
    }
    if (game.getGameStartStatus() !== "idle" || game.isFinished) {
      await interaction.reply({ content: "Captain nominations are closed after the game starts." });
      return;
    }

    const user = interaction.user;
    const nominatedPlayer = game.getPlayers().find((p) => p.discordSnowflake === user.id);
    if (!nominatedPlayer) {
      await interaction.reply({
        content: "You must be registered for the current game to nominate yourself.",
      });
      return;
    }
    if (game.captainNominations.has(user.id)) {
      await interaction.reply({
        content: "You have already nominated yourself to be a captain.",
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const token = game.getLifecycleToken();
    game.captainNominations.add(user.id);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`captainnominate-set:${token}:${user.id}`)
        .setStyle(ButtonStyle.Primary)
        .setLabel("Set Captain")
    );

    try {
      const displayName = await PrismaUtils.getDisplayNameWithTitle(
        nominatedPlayer.playerId,
        `<@${nominatedPlayer.discordSnowflake}>`
      );
      if (game.getLifecycleToken() !== token || !game.announced) {
        game.captainNominations.delete(user.id);
        await interaction.editReply("This nomination expired because the game changed.");
        return;
      }

      await DiscordUtil.sendMessage("gameFeed", {
        content: `${displayName} has nominated themselves to be a captain!`,
        components: [row],
      });
      await interaction.editReply("You have nominated yourself to be a captain!");
    } catch (error) {
      if (game.getLifecycleToken() === token) game.captainNominations.delete(user.id);
      console.error("Captain nomination announcement failed", error);
      await interaction.editReply("Could not publish the nomination. Please retry.");
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const game = CurrentGameManager.getCurrentGame();
    const match = /^captainnominate-set:([a-f0-9-]{36}):(\d+)$/.exec(interaction.customId);
    if (!match || match[1] !== game.getLifecycleToken() ||
        !game.announced || game.isFinished || game.getGameStartStatus() !== "idle") {
      await interaction.editReply("This captain nomination belongs to an expired game.");
      return;
    }
    const nominatedId = match[2];
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply("This nomination requires a guild.");
      return;
    }

    try {
      const member = await fetchGuildMember(guild, interaction.user.id);
      if (!PermissionsUtil.hasRole(member ?? undefined, "organiserRole")) {
        await interaction.editReply("Only an organiser can select a nominated captain.");
        return;
      }
    } catch (error) {
      console.error("Unable to verify nomination organiser membership", error);
      await interaction.editReply("Cannot verify organiser permissions with Discord right now.");
      return;
    }

    const perform = async (): Promise<string> => {
      if (match[1] !== game.getLifecycleToken() ||
          !game.announced || game.isFinished || game.getGameStartStatus() !== "idle") {
        return "This captain nomination belongs to an expired game.";
      }
      if (TeamCommand.instance?.isTeamPickingSessionActive()) {
        return "Captains cannot be changed while team picking is in progress.";
      }
      if (!game.captainNominations.has(nominatedId)) {
        return "This player no longer has an active captain nomination.";
      }

      const player = game.getPlayers().find((p) => p.discordSnowflake === nominatedId);
      if (!player) return "The nominated player is not registered in the game.";

      const redCaptain = game.getCaptainOfTeam("RED");
      const blueCaptain = game.getCaptainOfTeam("BLUE");
      if (redCaptain && blueCaptain) return "Both teams already have captains.";

      const currentTeam = game.getPlayersTeam(player);
      let teamToSet: Team | null = null;
      if (currentTeam === "RED" && !redCaptain) teamToSet = "RED";
      else if (currentTeam === "BLUE" && !blueCaptain) teamToSet = "BLUE";
      else if (!redCaptain) teamToSet = "RED";
      else if (!blueCaptain) teamToSet = "BLUE";
      if (!teamToSet) return "Unable to determine which team to set.";

      const newCaptainMember = await fetchGuildMember(guild, player.discordSnowflake);
      if (!newCaptainMember) return "The nominated player is no longer in the server.";
      const roles = PermissionsUtil.config.roles;
      if (game.getLifecycleToken() !== match[1] ||
          game.getGameStartStatus() !== "idle") {
        return "The game changed during captain validation; no captain was selected.";
      }

      // Do external changes before committing to authoritative game state.
      await newCaptainMember.roles.add(roles.captainRole);
      await newCaptainMember.roles.add(
        teamToSet === "RED" ? roles.redTeamRole : roles.blueTeamRole
      );
      await newCaptainMember.roles.remove(
        teamToSet === "RED" ? roles.blueTeamRole : roles.redTeamRole
      );
      if (game.getLifecycleToken() !== match[1] ||
          game.getGameStartStatus() !== "idle") {
        return "The game changed during Discord role updates. Captain state was not committed; inspect partial roles.";
      }
      game.setTeamCaptain(teamToSet, player);
      game.captainNominations.delete(nominatedId);
      return `Set captain of team **${teamToSet.toLowerCase()}** to **${escapeIgn(
        player.ignUsed ?? "Unknown Player"
      )}**.`;
    };

    try {
      const message = TeamCommand.instance
        ? await TeamCommand.instance.runRosterOperation(perform)
        : await perform();
      await interaction.editReply(message);
    } catch (error) {
      console.error("Captain nomination role update failed", error);
      await interaction.editReply(
        "Discord role updates failed. Captain state was not changed; check for partial role changes before retrying."
      );
    }
  }
}
