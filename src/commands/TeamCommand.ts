import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  Message,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { ConfigManager } from "../ConfigManager";
import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "../logic/teams/RandomTeamPickingSession";
import { TeamPickingSession } from "../logic/teams/TeamPickingSession";
import { DiscordUtil } from "../util/DiscordUtil";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { escapeText } from "../util/Utils";
import { createGameStartPrompt } from "./GameCommand";
import { GuildMembership } from "../logic/GuildMembership";
import { withObsoleteMessageGuard, discordErrorCode, fetchGuildMember } from "../util/DiscordFailures";

export default class TeamCommand implements Command {
  static instance?: TeamCommand;
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name = "team";
  public description = "Manage teams";
  public buttonIds: string[] = [
    "random-team-accept",
    "random-team-generate-reroll",
    "random-team-generate-cancel",
    "draft-accept",
    "draft-cancel",
  ];

  teamPickingSession?: TeamPickingSession;
  private serialTail: Promise<void> = Promise.resolve();

  private async serialise<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.serialTail;
    let release!: () => void;
    this.serialTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); }
    finally { release(); }
  }

  async runRosterOperation<T>(task: () => Promise<T>): Promise<T> {
    return this.serialise(task);
  }

  /** Automatic starts use the same roster lock and reconciliation as /team generate. */
  async startAutomaticDraft(guild: Guild): Promise<boolean> {
    return this.serialise(async () => {
      const game = CurrentGameManager.getCurrentGame();
      const token = game.getLifecycleToken();
      if (!game.announced || game.isFinished || game.getGameStartStatus() !== "idle" ||
          game.teamsDecidedBy || this.teamPickingSession) return false;

      try {
        await GuildMembership.reconcile(guild, this);
      } catch (error) {
        console.error("Automatic draft blocked by uncertain guild membership", error);
        return false;
      }
      if (game.getLifecycleToken() !== token || !game.announced ||
          game.getGameStartStatus() !== "idle" || game.isFinished ||
          !game.getCaptainOfTeam("RED") || !game.getCaptainOfTeam("BLUE") ||
          game.getPlayersOfTeam("UNDECIDED").length % 2 !== 0) return false;

      const session = new DraftTeamPickingSession("snake");
      this.teamPickingSession = session;
      const interaction = {
        editReply: async (_: unknown) => {},
        guild,
      } as unknown as ChatInputCommandInteraction;
      try {
        await session.initialize(interaction);
        if (game.getLifecycleToken() !== token ||
            session.getState() !== "inProgress") {
          await this.resetTeamPickingSession();
          return false;
        }
        return true;
      } catch (error) {
        await this.resetTeamPickingSession();
        throw error;
      }
    });
  }

  async handleGuildDeparture(userId: string): Promise<boolean> {
    return this.serialise(() => GuildMembership.handleDeparture(userId, this));
  }

  async handleTeamPickingMessage(message: Message<boolean>): Promise<void> {
    await this.serialise(async () => {
      const session = this.teamPickingSession;
      if (session?.getState() === "inProgress") {
        await session.handleMessage(message);
      }
    });
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (["generate", "reset", "cancel"].includes(subcommand)) {
      await interaction.deferReply();
      await this.serialise(() => this.executeUnlocked(interaction));
    } else {
      await this.executeUnlocked(interaction);
    }
  }

  constructor() {
    TeamCommand.instance = this;
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("generate")
          .setDescription("Generate teams")
          .addStringOption((option) =>
            option
              .setName("method")
              .setDescription("Method to generate teams")
              .setRequired(true)
              .addChoices(
                { name: "snake draft", value: "snake" },
                { name: "draft", value: "draft" },
                { name: "elo", value: "elo" },
                { name: "balance", value: "balance" },
                { name: "random", value: "random" }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reset").setDescription("Reset the teams")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List the current teams")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cancel")
          .setDescription("Cancel the current team picking session")
      );
  }

  private async executeUnlocked(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const subcommand = interaction.options.getSubcommand();
    const member = DiscordUtil.getGuildMember(interaction);
    const isOrganiser =
      member?.roles instanceof GuildMemberRoleManager &&
      member.roles.cache.has(config.roles.organiserRole);

    const game = CurrentGameManager.getCurrentGame();

    try {
      if (["generate", "reset", "cancel"].includes(subcommand) &&
          (game.getGameStartStatus() !== "idle" || game.isFinished)) {
        await DiscordUtil.reply(interaction, "Teams cannot be changed after the game starts.");
        return;
      }
      switch (subcommand) {
        case "generate": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          if (!game.announced) {
            await DiscordUtil.reply(
              interaction,
              "A game has not been announced yet. Please use `/announce start`."
            );
            return;
          }

          if (this.teamPickingSession) {
            await DiscordUtil.reply(
              interaction,
              "A team picking session is already in process. Cancel that one before creating another."
            );
            return;
          }
          if (!interaction.guild) {
            await DiscordUtil.reply(interaction, "This command requires a guild.");
            return;
          }
          try {
            const departed = await GuildMembership.reconcile(interaction.guild, this);
            if (departed.length) console.warn(`Removed ${departed.length} absent players before generation`);
          } catch (error) {
            console.error("Team generation blocked by uncertain member lookup", error);
            await DiscordUtil.reply(interaction, "Could not verify the roster with Discord. No teams were generated; please retry.");
            return;
          }
          if (game.getPlayers().length < 2) {
            await DiscordUtil.reply(interaction, "At least two present, registered players are required to generate teams.");
            return;
          }
          const method = interaction.options.getString("method");
          if (
            (method === "draft" || method === "snake") &&
            (!game.getCaptainOfTeam("RED") || !game.getCaptainOfTeam("BLUE"))
          ) {
            await DiscordUtil.reply(
              interaction,
              "You can't draft teams without setting captains for both teams first!"
            );
            return;
          }

          if (method === "draft" || method === "snake") {
            const undecidedCount = game.getPlayersOfTeam("UNDECIDED").length;
            if (undecidedCount % 2 !== 0) {
              await DiscordUtil.reply(
                interaction,
                "You need an even number of registered players to start draft team picking."
              );
              return;
            }
          }

          const teamPickingChannelIds = [config.channels.teamPickingChat];
          try {
            await DiscordUtil.cleanUpAllChannelMessages(
              interaction.guild!,
              teamPickingChannelIds
            );
          } catch (error) {
            console.error(
              "Failed to clean up team picking chat while generating teams:",
              error
            );
          }

          switch (method) {
            case "random":
              this.teamPickingSession = new RandomTeamPickingSession("random");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "draft":
              this.teamPickingSession = new DraftTeamPickingSession("draft");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "snake":
              this.teamPickingSession = new DraftTeamPickingSession("snake");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "elo":
              this.teamPickingSession = new RandomTeamPickingSession("elo");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "balance":
              this.teamPickingSession = new RandomTeamPickingSession("balance");
              await this.teamPickingSession.initialize(interaction);
              break;
          }

          const redTeam = [...game.getPlayersOfTeam("RED")];
          const blueTeam = [...game.getPlayersOfTeam("BLUE")];
          const roleWarnings: string[] = [];

          for (const player of redTeam) {
            if (
              !DiscordUtil.isValidSnowflake(player.discordSnowflake) &&
              PermissionsUtil.isDebugEnabled()
            ) {
              console.log(
                `Skipping invalid snowflake as probably a fake player: ${player.discordSnowflake}`
              );
              continue;
            }

            try {
              const discordUser = await interaction.guild?.members.fetch(
                player.discordSnowflake
              );
              if (discordUser) {
                await discordUser.roles.remove(config.roles.blueTeamRole);
                await discordUser.roles.add(config.roles.redTeamRole);
              }
            } catch (error) {
              console.error(`Role sync failed guild=${interaction.guild.id} member=${player.discordSnowflake} team=RED code=${discordErrorCode(error) ?? "other"}`, error);
              if (discordErrorCode(error) === 10007) {
                await GuildMembership.handleDeparture(player.discordSnowflake, this);
              } else {
                roleWarnings.push(player.ignUsed ?? player.discordSnowflake);
              }
            }
          }

          for (const player of blueTeam) {
            if (
              !DiscordUtil.isValidSnowflake(player.discordSnowflake) &&
              PermissionsUtil.isDebugEnabled()
            ) {
              console.log(
                `Skipping invalid snowflake as probably a fake player: ${player.discordSnowflake}`
              );
              continue;
            }

            try {
              const discordUser = await interaction.guild?.members.fetch(
                player.discordSnowflake
              );
              if (discordUser) {
                await discordUser.roles.remove(config.roles.redTeamRole);
                await discordUser.roles.add(config.roles.blueTeamRole);
              }
            } catch (error) {
              console.error(`Role sync failed guild=${interaction.guild.id} member=${player.discordSnowflake} team=BLUE code=${discordErrorCode(error) ?? "other"}`, error);
              if (discordErrorCode(error) === 10007) {
                await GuildMembership.handleDeparture(player.discordSnowflake, this);
              } else {
                roleWarnings.push(player.ignUsed ?? player.discordSnowflake);
              }
            }
          }

          await DiscordUtil.editReply(interaction, {
            content: !this.teamPickingSession || this.teamPickingSession.state === "cancelled"
              ? "Team generation was cancelled because the roster changed."
              : roleWarnings.length
                ? `Team picking started, but role changes failed for ${roleWarnings.length} player(s). Check Discord roles before starting the match.`
                : "Team picking now in progress.",
          });
          break;
        }

        case "reset": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          await this.resetTeamPickingSession();
          game.changeHowTeamsDecided(null);
          game.resetTeams();
          let rolesIncomplete = false;
          try {
            const members = await interaction.guild?.members.fetch();

            if (members) {
              for (const member of members.values()) {
                if (member.roles.cache.has(config.roles.redTeamRole)) {
                  await member.roles.remove(config.roles.redTeamRole);
                }
                if (member.roles.cache.has(config.roles.blueTeamRole)) {
                  await member.roles.remove(config.roles.blueTeamRole);
                }
              }
            }
          } catch (error) {
            rolesIncomplete = true;
            console.error(`Team reset completed but Discord role cleanup failed guild=${interaction.guild?.id}`, error);
          }
          await DiscordUtil.editReply(interaction, {
            content: rolesIncomplete
              ? "Teams were reset in the game, but Discord roles could not be completely cleaned up. Check roles before continuing."
              : "Teams have been reset!",
          });
          break;
        }

        case "list": {
          if (!game.announced) {
            await DiscordUtil.reply(
              interaction,
              "No game has been announced yet."
            );
          } else {
            await interaction.deferReply();
            const embed = this.createTeamViewEmbed(game);
            await DiscordUtil.editReply(interaction, embed);
          }
          break;
        }

        case "cancel": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          if (!this.teamPickingSession) {
            await DiscordUtil.reply(
              interaction,
              "No team picking session is currently active."
            );
            return;
          }

          await this.resetTeamPickingSession();
          game.changeHowTeamsDecided(null);
          await DiscordUtil.reply(
            interaction,
            "The current team picking session has been cancelled.",
            false
          );
          break;
        }

        default:
          await DiscordUtil.reply(interaction, "Invalid subcommand!");
          return;
      }
    } catch (error) {
      console.error(`Team command failed subcommand=${subcommand} guild=${interaction.guild?.id ?? "unknown"} code=${discordErrorCode(error) ?? "other"}`, error);
      // A response failure must not roll back an otherwise successful mutation.
      if (discordErrorCode(error) === 10062) {
        console.warn("Team command response expired; check actual game state before retrying");
        return;
      }
      if (subcommand === "generate" && this.teamPickingSession?.state === "inProgress") {
        try {
          await this.resetTeamPickingSession();
        } catch (cleanupError) {
          console.error("Failed to cancel incomplete team-generation session", cleanupError);
        }
      }
      try {
        await DiscordUtil.reply(interaction, "The team operation failed. Some Discord changes may have been applied; check teams and roles before retrying.");
      } catch (replyError) {
        console.warn(`Cannot deliver team command error response code=${discordErrorCode(replyError) ?? "other"}`);
      }
    }
  }

  createTeamViewEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");

    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");

    const formatPlayers = (
      players: PlayerInstance[],
      captain: PlayerInstance | undefined
    ): string => {
      const formatName = (text: string | undefined): string =>
        text ? escapeText(text) : "Unknown Player";
      if (players.length === 0) return "No players";
      const sortedPlayers = captain
        ? [captain, ...players.filter((player) => player !== captain)]
        : players;
      return (
        `**${formatName(sortedPlayers[0].ignUsed)}**\n` +
        sortedPlayers
          .slice(1)
          .map((player) => formatName(player.ignUsed))
          .join("\n")
      );
    };

    const bluePlayersString = formatPlayers(bluePlayers, blueCaptain);
    const redPlayersString = formatPlayers(redPlayers, redCaptain);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Teams")
      .addFields(
        {
          name: `🔵 Blue Team [${bluePlayers.length}] 🔵`,
          value: bluePlayersString,
          inline: true,
        },
        {
          name: `🔴 Red Team [${redPlayers.length}] 🔴`,
          value: redPlayersString,
          inline: true,
        }
      );

    return { embeds: [embed] };
  }

  private async setRoles(guild: Guild) {
    const game = CurrentGameManager.getCurrentGame();
    const config = ConfigManager.getConfig();

    const redTeam = game.getPlayersOfTeam("RED");
    for (const element of redTeam) {
      const discordUser = await guild.members.fetch(element.discordSnowflake);
      await discordUser?.roles.remove(config.roles.blueTeamRole);
      discordUser?.roles.add(config.roles.redTeamRole);
    }

    const blueTeam = game.getPlayersOfTeam("BLUE");
    for (const element of blueTeam) {
      const discordUser = await guild.members.fetch(element.discordSnowflake);
      await discordUser?.roles.remove(config.roles.redTeamRole);
      discordUser?.roles.add(config.roles.blueTeamRole);
    }
  }

  /** Role changes are a recoverable projection of finalized game state. */
  private async syncFinalizedTeamRoles(guild: Guild): Promise<string[]> {
    const warnings: string[] = [];
    const game = CurrentGameManager.getCurrentGame();
    const config = ConfigManager.getConfig();
    for (const team of ["RED", "BLUE"] as const) {
      for (const player of [...game.getPlayersOfTeam(team)]) {
        try {
          const member = await fetchGuildMember(guild, player.discordSnowflake);
          if (!member) {
            await GuildMembership.handleDeparture(player.discordSnowflake, this);
            warnings.push(`${player.ignUsed ?? player.discordSnowflake} left the guild`);
            continue;
          }
          const wrongRole = team === "RED" ? config.roles.blueTeamRole : config.roles.redTeamRole;
          const correctRole = team === "RED" ? config.roles.redTeamRole : config.roles.blueTeamRole;
          await member.roles.remove(wrongRole);
          await member.roles.add(correctRole);
        } catch (error) {
          if (discordErrorCode(error) === 10007) {
            await GuildMembership.handleDeparture(player.discordSnowflake, this);
          }
          console.error(`Final role sync failed guild=${guild.id} member=${player.discordSnowflake} team=${team} code=${discordErrorCode(error) ?? "other"}`, error);
          warnings.push(player.ignUsed ?? player.discordSnowflake);
        }
      }
    }
    return warnings;
  }

  public async handleButtonPress(interaction: ButtonInteraction) {
    await this.serialise(async () => {
    const session = this.teamPickingSession;
    if (!interaction.guild || !session || session.getState() !== "inProgress") {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: "This team-picking session has expired.", flags: MessageFlags.Ephemeral });
      }
      return;
    }
    const ownedIds = [session.embedMessage?.id, session instanceof DraftTeamPickingSession ? session.finalizeMessage?.id : undefined].filter(Boolean);
    if (interaction.message?.id && ownedIds.length && !ownedIds.includes(interaction.message.id)) {
      await interaction.reply({ content: "That button belongs to an old team-picking session.", flags: MessageFlags.Ephemeral });
      return;
    }
    {
      const previousState = session.getState();
      await session.handleInteraction(interaction);
      const state = session.getState();
      switch (state) {
        case "finalized":
          //FIXME should update original "Team picking in progress.." message to say something else too
          if (session.embedMessage?.embeds?.[0]) {
            const updatedEmbed = EmbedBuilder.from(
              session.embedMessage.embeds[0]
            ).setFooter({ text: "Teams have been locked." });
            await withObsoleteMessageGuard("edit", session.embedMessage, () =>
              session.embedMessage!.edit({ embeds: [updatedEmbed], components: [] })
            );
          }
          if (previousState !== "finalized") {
            const warnings = session instanceof RandomTeamPickingSession ||
              session instanceof DraftTeamPickingSession
              ? await this.syncFinalizedTeamRoles(interaction.guild)
              : [];
            if (warnings.length || !CurrentGameManager.getCurrentGame().teamsDecidedBy && (session instanceof RandomTeamPickingSession || session instanceof DraftTeamPickingSession)) {
              await interaction.followUp({
                content: `Teams were selected, but ${warnings.length} Discord role/member change(s) need attention. Do not start the game until roles and roster are checked. Use /team reset to recover.`,
              });
            } else {
              await interaction.followUp(
                createGameStartPrompt("Teams have been selected! Start game?")
              );
            }
          }
          break;
        case "cancelled":
          await this.resetTeamPickingSession();
          break;
      }
    }
    });
  }

  public async resetTeamPickingSession(): Promise<void> {
    const session = this.teamPickingSession;
    if (!session) return;
    session.state = "cancelled";
    try {
      await session.cancelSession?.();
    } finally {
      if (this.teamPickingSession === session) this.teamPickingSession = undefined;
    }
  }

  public isTeamPickingSessionActive(): boolean {
    return this.teamPickingSession !== undefined;
  }
}
