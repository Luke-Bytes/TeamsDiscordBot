import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { SeasonClosureReason, SeasonType } from "@prisma/client";
import { Command } from "./CommandInterface";
import { prismaClient } from "../database/prismaClient";
import { SeasonService } from "../database/SeasonService";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import { Channels } from "../Channels";

type PendingOperation =
  | { kind: "end"; userId: string; nextType?: SeasonType }
  | { kind: "start"; userId: string; type: SeasonType; number?: number };

const typeChoices = [
  { name: "Ranked", value: SeasonType.RANKED },
  { name: "Relaxed", value: SeasonType.RELAXED },
];

export default class SeasonCommand implements Command {
  public name = "season";
  public description = "View and manage seasons.";
  public data: SlashCommandSubcommandsOnlyBuilder;
  public buttonIds = ["season-confirm", "season-cancel"];
  private readonly pendingByMessage = new Map<string, PendingOperation>();
  private readonly pendingByUser = new Map<string, PendingOperation>();

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("View statistics for a season")
          .addIntegerOption((option) =>
            option
              .setName("number")
              .setDescription("Season number")
              .setMinValue(1)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("status").setDescription("View rollover status")
      )
      .addSubcommand((sub) =>
        sub
          .setName("configure")
          .setDescription("Configure the active season")
          .addIntegerOption((option) =>
            option
              .setName("game-limit")
              .setDescription("Finished games; 0 clears")
              .setMinValue(0)
          )
          .addIntegerOption((option) =>
            option
              .setName("month-limit")
              .setDescription("Calendar months; 0 clears")
              .setMinValue(0)
          )
          .addStringOption((option) =>
            option
              .setName("current-type")
              .setDescription("Current season type")
              .addChoices(...typeChoices)
          )
          .addStringOption((option) =>
            option
              .setName("next-type")
              .setDescription("One-time successor type")
              .addChoices(...typeChoices, {
                name: "Automatic alternation",
                value: "AUTO",
              })
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("end")
          .setDescription("Close the active season")
          .addStringOption((option) =>
            option
              .setName("next-type")
              .setDescription("Successor type override")
              .addChoices(...typeChoices)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("start")
          .setDescription("Bootstrap a season when none is active")
          .addStringOption((option) =>
            option
              .setName("type")
              .setDescription("Season type")
              .addChoices(...typeChoices)
          )
          .addIntegerOption((option) =>
            option
              .setName("number")
              .setDescription("New, highest season number")
              .setMinValue(1)
          )
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "view") return this.view(interaction);
    if (subcommand === "status") return this.status(interaction);

    if (!(await PermissionsUtil.isUserAuthorised(interaction))) return;
    try {
      if (subcommand === "configure") {
        const gameLimit = interaction.options.getInteger("game-limit");
        const monthLimit = interaction.options.getInteger("month-limit");
        const currentType = interaction.options.getString(
          "current-type"
        ) as SeasonType | null;
        const nextRaw = interaction.options.getString("next-type");
        const season = await SeasonService.configure({
          gameLimit: gameLimit === null ? undefined : gameLimit || null,
          monthLimit: monthLimit === null ? undefined : monthLimit || null,
          currentType: currentType ?? undefined,
          nextTypeOverride:
            nextRaw === null
              ? undefined
              : nextRaw === "AUTO"
                ? null
                : (nextRaw as SeasonType),
        });
        await interaction.reply({
          content: `Season ${season.number} configuration saved.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === "end") {
        const nextType = interaction.options.getString(
          "next-type"
        ) as SeasonType | null;
        return this.requestConfirmation(
          interaction,
          {
            kind: "end",
            userId: interaction.user.id,
            nextType: nextType ?? undefined,
          },
          "Close the active season, publish its recap and titles, and activate its successor?"
        );
      }

      const type =
        (interaction.options.getString("type") as SeasonType | null) ??
        SeasonType.RANKED;
      const number = interaction.options.getInteger("number") ?? undefined;
      if (await SeasonService.getActiveSeason())
        throw new Error("An active season already exists.");
      return this.requestConfirmation(
        interaction,
        {
          kind: "start",
          userId: interaction.user.id,
          type,
          number,
        },
        `Start Season ${number ?? "(next number)"} as ${type.toLowerCase()}?`
      );
    } catch (error) {
      await interaction.reply({
        content:
          error instanceof Error ? error.message : "Season operation failed.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async requestConfirmation(
    interaction: ChatInputCommandInteraction,
    pending: PendingOperation,
    description: string
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("season-confirm")
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("season-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );
    const message = await DiscordUtil.replyWithMessage(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle("Confirm Season Operation")
          .setDescription(description),
      ],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    if (message?.id) this.pendingByMessage.set(message.id, pending);
    this.pendingByUser.set(interaction.user.id, pending);
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const pending =
      this.pendingByMessage.get(interaction.message.id) ??
      this.pendingByUser.get(interaction.user.id);
    if (!pending) {
      await interaction.reply({
        content: "This confirmation expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (pending.userId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the organiser who requested this may confirm.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.pendingByMessage.delete(interaction.message.id);
    this.pendingByUser.delete(interaction.user.id);
    if (interaction.customId === "season-cancel") {
      await interaction.update({
        content: "Season operation cancelled.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.update({
      content: "Applying season operation...",
      embeds: [],
      components: [],
    });
    try {
      const season =
        pending.kind === "end"
          ? await SeasonService.closeActiveSeason(
              SeasonClosureReason.MANUAL,
              pending.nextType
            )
          : await SeasonService.bootstrap(pending.type, pending.number);
      await interaction.editReply({
        content: `Season ${season.number} is active (${(season.type ?? SeasonType.RANKED).toLowerCase()}).`,
      });
    } catch (error) {
      await interaction.editReply({
        content:
          error instanceof Error ? error.message : "Season operation failed.",
      });
    }
  }

  private async status(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const { season, finishedGames, pendingAnnouncements } =
        await SeasonService.getStatus();
      const deadline = season.rolloverDeadline
        ? `<t:${Math.floor(season.rolloverDeadline.getTime() / 1000)}:F> (<t:${Math.floor(season.rolloverDeadline.getTime() / 1000)}:R>)`
        : "Disabled";
      const embed = new EmbedBuilder()
        .setTitle(`Season ${season.number} Status`)
        .setColor(season.type === SeasonType.RELAXED ? "Aqua" : "Gold")
        .addFields(
          {
            name: "Type",
            value: season.type ?? SeasonType.RANKED,
            inline: true,
          },
          {
            name: "Games",
            value: season.gameLimit
              ? `${finishedGames} / ${season.gameLimit}`
              : `${finishedGames} (no limit)`,
            inline: true,
          },
          {
            name: "Month limit",
            value: season.monthLimit?.toString() ?? "Disabled",
            inline: true,
          },
          { name: "Deadline", value: deadline },
          {
            name: "Next type",
            value: season.nextTypeOverride ?? "Automatic alternation",
            inline: true,
          },
          {
            name: "Rollover",
            value: season.rolloverPending
              ? "Pending current game"
              : (season.lifecycleState ?? "ACTIVE"),
            inline: true,
          },
          {
            name: "Announcement retries",
            value: `${pendingAnnouncements} block(s) pending`,
            inline: true,
          }
        );
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply(
        error instanceof Error ? error.message : "No season status available."
      );
    }
  }

  private async view(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const seasonNumber = interaction.options.getInteger("number");
    const season = seasonNumber
      ? await prismaClient.season.findUnique({
          where: { number: seasonNumber },
        })
      : await SeasonService.getActiveSeason();
    if (!season) {
      await interaction.editReply(
        `Season ${seasonNumber ?? "active"} not found.`
      );
      return;
    }
    const [games, participations] = await Promise.all([
      prismaClient.game.findMany({
        where: { seasonId: season.id, finished: true },
      }),
      prismaClient.gameParticipation.findMany({
        where: { seasonId: season.id },
      }),
    ]);
    const gameSizes = games.map(
      (game) => participations.filter((p) => p.gameId === game.id).length
    );
    const embed = new EmbedBuilder()
      .setTitle(
        `📅 Season ${season.number} ${season.type === SeasonType.RELAXED ? "Relaxed" : "Ranked"} Stats`
      )
      .addFields(
        {
          name: "Start",
          value: season.startDate.toLocaleDateString(),
          inline: true,
        },
        {
          name: "End",
          value: season.endDate?.toLocaleDateString() ?? "Active",
          inline: true,
        },
        { name: "Total Games", value: games.length.toString(), inline: true },
        {
          name: "Unique Players",
          value: new Set(participations.map((p) => p.playerId)).size.toString(),
          inline: true,
        },
        {
          name: "Largest Game",
          value: Math.max(...gameSizes, 0).toString(),
          inline: true,
        }
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();
    const message = await interaction.editReply({ embeds: [embed] });
    if (interaction.channelId !== Channels.botCommands.id) {
      setTimeout(() => message.delete().catch(() => undefined), 120_000);
    }
  }
}
