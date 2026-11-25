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
import { fetchGuildMember } from "../util/DiscordFailures";
import TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { escapeText } from "../util/Utils";
import { PrismaUtils } from "../util/PrismaUtils";
import { syncRegistrationNickname } from "../util/AutoNickname";
import { deliverScenarioRegistrationPrompt } from "../logic/scenarios/ScenarioPromptDelivery";

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

    const game = CurrentGameManager.getCurrentGame();
    if (!game.announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const gameToken = game.getLifecycleToken();

    await PrismaUtils.updatePunishmentsForExpiry();

    const inGameNameOption = interaction.options.getString("ingamename");
    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;
    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;
    const safeDiscordUserName = escapeText(discordUserName);

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (
      !PermissionsUtil.hasRole(member, "organiserRole") &&
      !PermissionsUtil.isSameUser(interaction, targetUser.id)
    ) {
      await interaction.editReply({
        content: "You do not have permission to register other users.",
      });
      return;
    }

    if (!interaction.guild) {
      await interaction.editReply({ content: "Registration requires a Discord server." });
      return;
    }
    try {
      if (!(await fetchGuildMember(interaction.guild, discordUserId))) {
        await interaction.editReply({ content: "That user is no longer a member of this server." });
        return;
      }
    } catch (error) {
      console.error(`Registration membership check failed member=${discordUserId}`, error);
      await interaction.editReply({ content: "Cannot verify Discord membership right now. Please retry." });
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
    const hasStoredIgn = Boolean(player?.primaryMinecraftAccount);

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

      // Keep a previously verified identity during external outages; never invent one.
      if (!resolvedUsername && MojangAPI.validUUID(uuid) &&
          player.latestIGN && MojangAPI.validateUsername(player.latestIGN)) {
        resolvedUsername = player.latestIGN;
      }
      if (!resolvedUsername) {
        await interaction.editReply({ content: "Unable to retrieve a verified Minecraft username. Please retry later." });
        return;
      }
    } else {
      // Validate ign if provided by converting it to a UUID
      uuid = await MojangAPI.usernameToUUID(inGameNameOption);
      if (!uuid && player && MojangAPI.validUUID(player.primaryMinecraftAccount) &&
          (player.latestIGN?.toLowerCase() === inGameNameOption.toLowerCase() ||
            player.minecraftAccounts?.some((name) => name.toLowerCase() === inGameNameOption.toLowerCase()))) {
        uuid = player.primaryMinecraftAccount;
      }
      if (!uuid) {
        await interaction.editReply({
          content:
            "Could not verify that Minecraft username. Check its spelling or retry when the identity service is available.",
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

    if (!MojangAPI.validUUID(uuid) || !resolvedUsername) {
      await interaction.editReply({ content: "Could not verify your Minecraft account. No registration was created." });
      return;
    }

    const validatedIgn = resolvedUsername;

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

    let result;
    let registrationCommitted = false;
    try {
      result = await this.teamCommand.runRosterOperation(async () => {
        // I/O or game shutdown may have replaced the announcement while waiting.
        if (!game.announced || game.getLifecycleToken() !== gameToken) {
          return { error: "The announced game changed. Please check the roster before registering again." } as const;
        }
        // Recheck immediately before committing after Mojang/DB I/O.
        if (!(await fetchGuildMember(interaction.guild!, discordUserId))) {
          return { error: "That user left the server before registration completed." } as const;
        }
        const added = await CurrentGameManager.getCurrentGame().addPlayerByDiscordId(
          discordUserId, validatedIgn, uuid
        );
        const session = this.teamCommand.teamPickingSession;
        if (!added.error) registrationCommitted = true;
        if (!added.error && session instanceof DraftTeamPickingSession && !session.latePickingStarted) {
          await session.registerLateSignup(added.playerInstance);
        }
        return added;
      });
    } catch (error) {
      console.error(`Registration workflow failed member=${discordUserId} committed=${registrationCommitted}`, error);
      await interaction.editReply({ content: registrationCommitted
        ? "Registration succeeded, but the draft display could not be updated. Ask an organiser to check the team-picking session."
        : "Unable to verify membership or save registration right now. Check current registrations before retrying." });
      return;
    }

    if (result.error) {
      await interaction.editReply({
        content: result.error,
      });
      return;
    }

    // Use the latest verified IGN committed to the roster, not an input alias.
    // Nickname updates are best-effort and never invalidate a registration.
    resolvedUsername = result.playerInstance.ignUsed ?? resolvedUsername;
    const nicknameResult = await syncRegistrationNickname(
      interaction.guild,
      discordUserId,
      resolvedUsername
    );
    const nicknameNote =
      nicknameResult === "failed"
        ? " The server nickname could not be updated; registration still succeeded."
        : "";

    // late signups
    const shouldNudgeIgn =
      Boolean(inGameNameOption) &&
      hasStoredIgn &&
      PermissionsUtil.isSameUser(interaction, targetUser.id);
    const ignNudge = shouldNudgeIgn
      ? " You don't need to type your IGN next time."
      : "";

    if (this.teamCommand.isTeamPickingSessionActive()) {
      if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
        await interaction.editReply({
          content: `You have successfully registered as \`${resolvedUsername}\` but please note this is a late sign-up as team picking is currently ongoing. You may be unable to play.${ignNudge}${nicknameNote}`,
        });
      } else {
        await interaction.editReply({
          content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`, but it's a late sign-up during team picking.${nicknameNote}`,
        });
      }
      await deliverScenarioRegistrationPrompt(interaction, game, discordUserId);
      return;
    }

    if (CurrentGameManager.getCurrentGame().teamsDecidedBy !== null) {
      if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
        await interaction.editReply({
          content: `You have successfully registered as \`${resolvedUsername}\` but please note this is a late sign-up as team picking has been completed. You may be unable to play.${ignNudge}${nicknameNote}`,
        });
      } else {
        await interaction.editReply({
          content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`, but it's a late sign-up post team picking.${nicknameNote}`,
        });
      }
      await deliverScenarioRegistrationPrompt(interaction, game, discordUserId);
      return;
    }

    // success messages
    if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
      await interaction.editReply({
        content: `You have successfully registered as \`${resolvedUsername}\`!${ignNudge}${nicknameNote}`,
      });
    } else {
      await interaction.editReply({
        content: `${safeDiscordUserName} has been successfully registered as \`${resolvedUsername}\`!${nicknameNote}`,
      });
    }
    await deliverScenarioRegistrationPrompt(interaction, game, discordUserId);
  }
}
