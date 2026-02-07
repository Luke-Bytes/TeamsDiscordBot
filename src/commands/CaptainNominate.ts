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
import { Team } from "@prisma/client";
import { escapeText } from "../util/Utils";
import { PrismaUtils } from "../util/PrismaUtils";

export default class CaptainNominateCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("captainnominate")
    .setDescription("Nominate yourself to be a captain");

  name = "captainnominate";
  description = "Nominate yourself to be a captain";
  buttonIds = ["captainnominate-set"];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!GameInstance.getInstance().announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
      });
      return;
    }

    const game = GameInstance.getInstance();
    const user = interaction.user;

    const isRegistered = game
      .getPlayers()
      .some((p) => p.discordSnowflake === user.id);
    if (!isRegistered) {
      await interaction.reply({
        content:
          "You must be registered for the current game to nominate yourself.",
      });
      return;
    }

    if (game.captainNominations.has(user.id)) {
      await interaction.reply({
        content: "You have already nominated yourself to be a captain.",
      });
      return;
    }

    game.captainNominations.add(user.id);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("captainnominate-set")
        .setStyle(ButtonStyle.Primary)
        .setLabel("Set Captain")
    );

    const nominatedPlayer = game
      .getPlayers()
      .find((p) => p.discordSnowflake === user.id);
    const displayName = nominatedPlayer
      ? await PrismaUtils.getDisplayNameWithTitle(
          nominatedPlayer.playerId,
          `<@${nominatedPlayer.discordSnowflake}>`
        )
      : `<@${user.id}>`;

    await DiscordUtil.sendMessage("gameFeed", {
      content: `${displayName} has nominated themselves to be a captain!`,
      components: [row],
    });
    await interaction.reply({
      content: "You have nominated yourself to be a captain!",
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.deferUpdate();
      return;
    }

    const member = await guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.deferUpdate();
      return;
    }

    const content = interaction.message.content ?? "";
    const match = content.match(/<@(\d+)>/);
    const nominatedId = match?.[1];

    if (!nominatedId) {
      await interaction.reply({
        content: "Could not determine the nominated player.",
      });
      return;
    }

    const game = CurrentGameManager.getCurrentGame();
    if (!game.announced) {
      await interaction.reply({
        content: "No game is currently announced.",
      });
      return;
    }

    const player = game
      .getPlayers()
      .find((p) => p.discordSnowflake === nominatedId);
    if (!player) {
      await interaction.reply({
        content: "The nominated player is not registered in the game.",
      });
      return;
    }

    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");
    if (redCaptain && blueCaptain) {
      await interaction.reply({
        content: "Both teams already have captains.",
      });
      return;
    }

    const currentTeam = game.getPlayersTeam(player);
    let teamToSet: Team | null = null;
    if (currentTeam === "RED" && !redCaptain) teamToSet = "RED";
    else if (currentTeam === "BLUE" && !blueCaptain) teamToSet = "BLUE";
    else if (!redCaptain) teamToSet = "RED";
    else if (!blueCaptain) teamToSet = "BLUE";

    if (!teamToSet) {
      await interaction.reply({
        content: "Unable to determine which team to set.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const captains = game.setTeamCaptain(teamToSet, player);

    if (captains.oldCaptain) {
      const oldCaptainMember = await guild.members
        .fetch(captains.oldCaptain)
        .catch(() => null);
      if (oldCaptainMember) {
        await oldCaptainMember.roles.remove(
          PermissionsUtil.config.roles.captainRole
        );
      }
    }

    const newCaptainMember = await guild.members
      .fetch(player.discordSnowflake)
      .catch(() => null);
    if (!newCaptainMember) {
      await interaction.reply({
        content: "Could not fetch the nominated player's guild member.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await newCaptainMember.roles.add(PermissionsUtil.config.roles.captainRole);
    if (teamToSet === "RED") {
      await newCaptainMember.roles.add(
        PermissionsUtil.config.roles.redTeamRole
      );
      await newCaptainMember.roles.remove(
        PermissionsUtil.config.roles.blueTeamRole
      );
    } else if (teamToSet === "BLUE") {
      await newCaptainMember.roles.add(
        PermissionsUtil.config.roles.blueTeamRole
      );
      await newCaptainMember.roles.remove(
        PermissionsUtil.config.roles.redTeamRole
      );
    }

    await interaction.reply({
      content: `Set captain of team **${teamToSet.toLowerCase()}** to **${escapeText(
        player.ignUsed ?? "Unknown Player"
      )}**.`,
    });
  }
}
