import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { CurrentGameManager } from "../logic/CurrentGameManager.js";
import { prismaClient } from "../database/prismaClient";
import { MojangAPI } from "../api/MojangAPI";
import TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { escapeText } from "../util/Utils";

export default class RegisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "register";
  public description = "Register for friendly war!";
  public buttonIds: string[] = [];
  private readonly teamCommand: TeamCommand;

  constructor(teamCommand: TeamCommand) {
    this.teamCommand = teamCommand;
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("ingamename")
          .setDescription("The in-game name to register")
          .setRequired(false)
      )
      .addUserOption((option) =>
        option
          .setName("discorduser")
          .setDescription("The Discord user to register (organisers only)")
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!PermissionsUtil.isChannel(interaction, "registration")) {
      await interaction.reply({
        content: "You can only register in the registration channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!CurrentGameManager.getCurrentGame().announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const inGameNameOption = interaction.options.getString("ingamename");
    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;
    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;
    const safeDiscordUserName = escapeText(discordUserName);

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    await interaction.deferReply();

    if (
      !PermissionsUtil.hasRole(member, "organiserRole") &&
      !PermissionsUtil.isSameUser(interaction, targetUser.id)
    ) {
      await interaction.editReply({
        content: "You do not have permission to register other users.",
      });
      return;
    }

    let player = await prismaClient.player.byDiscordSnowflake(discordUserId);

    if (player) {
      const activePunishment = await prismaClient.playerPunishment.findFirst({
        where: {
          playerId: player?.id,
          AND: [
            { punishmentExpiry: { not: null } },
            { punishmentExpiry: { gt: new Date() } },
          ],
        },
      });

      if (activePunishment) {
        const expiryDate = activePunishment.punishmentExpiry
          ? new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            }).format(activePunishment.punishmentExpiry)
          : "unknown";

        await interaction.editReply({
          content: `You cannot register because you are currently banned from friendly wars. Your punishment will expire on **${expiryDate}**.`,
        });
        return;
      }
    }

    let uuid: string | null = null;
    let resolvedUsername: string | null = null;

    if (!inGameNameOption) {
      if (!player || !player.primaryMinecraftAccount) {
        await interaction.editReply({
          content:
            "You have not registered before. Please specify your in-game name with `/register <ingamename>`. Note, you must use the discord command box prompt!\nhttps://i.imgur.com/UIVbtqp.mp4",
        });
        return;
      }

      // Use stored UUID and retrieve the current username from Mojang
      uuid = player.primaryMinecraftAccount;
      resolvedUsername = await MojangAPI.uuidToUsername(uuid);

      //  If Mojang lookup fails, tell user to specify ingamename manually
      if (!resolvedUsername) {
        await interaction.editReply({
          content:
            "Error retrieving your username from the Mojang API. Please specify your in-game name manually with `/register <ingamename>`.",
        });
        return;
      }
    } else {
      // Validate ign if provided by converting it to a UUID
      uuid = await MojangAPI.usernameToUUID(inGameNameOption);
      if (!uuid) {
        await interaction.editReply({
          content:
            "That Minecraft username does not exist. Please check the spelling!",
        });
        return;
      }

      // If user is already in DB with a different UUID, block them from registering a new account
      if (
        player &&
        player.primaryMinecraftAccount &&
        player.primaryMinecraftAccount !== uuid
      ) {
        await interaction.editReply({
          content: `You are already registered with a different Minecraft account (\`${player.latestIGN}\`). You cannot register with another account.`,
        });
        return;
      }

      resolvedUsername = inGameNameOption;
    }

    if (!uuid || !resolvedUsername) {
      console.warn("Invalid UUID/Resolved Username but continuing anyway..");
      await interaction.editReply({
        content:
          "We could not resolve a valid Minecraft UUID and username probably due to an API issue, continuing anyway..",
      });
    }

    // Check if this user/UUID is already registered for the announced game
    const isAlreadyRegistered = CurrentGameManager.getCurrentGame()
      .getPlayers()
      .some(
        (existingPlayer) =>
          existingPlayer.discordSnowflake === discordUserId ||
          existingPlayer.primaryMinecraftAccount === uuid
      );

    if (isAlreadyRegistered) {
      await interaction.editReply({
        content: "You have already registered for the announced game!",
      });
      return;
    }

    const result =
      await CurrentGameManager.getCurrentGame().addPlayerByDiscordId(
        discordUserId,
        resolvedUsername,
        uuid
      );

    if (result.error) {
      await interaction.editReply({
        content: result.error,
      });
      return;
    }

    // late signups

    if (this.teamCommand.isTeamPickingSessionActive()) {
      const session = this.teamCommand.teamPickingSession;
      if (session && session instanceof DraftTeamPickingSession) {
        // Only add to late pool if late picking hasn't started
        if (!(session as DraftTeamPickingSession).latePickingStarted) {
          await session.registerLateSignup(result.playerInstance);
        }
      }
      if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
        await interaction.editReply({
          content: `You have successfully registered as \`${resolvedUsername}\` but please note this is a late sign-up as team picking is currently ongoing. You may be unable to play.`,
        });
      } else {
        await interaction.editReply({
          content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`, but it's a late sign-up during team picking.`,
        });
      }
      return;
    }

    if (CurrentGameManager.getCurrentGame().teamsDecidedBy !== null) {
      if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
        await interaction.editReply({
          content: `You have successfully registered as \`${resolvedUsername}\` but please note this is a late sign-up as team picking has been completed. You may be unable to play.`,
        });
      } else {
        await interaction.editReply({
          content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`, but it's a late sign-up post team picking.`,
        });
      }
      return;
    }

    // success messages
    if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
      await interaction.editReply({
        content: `You have successfully registered as \`${resolvedUsername}\`!`,
      });
    } else {
      await interaction.editReply({
        content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`!`,
      });
    }
  }
}
