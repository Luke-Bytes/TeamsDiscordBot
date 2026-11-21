import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type AnnouncementCommand from "./AnnouncementCommand";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import {
  buildDiscordRecovery,
  ensureRecoveryAllowed,
  installDiscordRecovery,
  RecoveryOptions,
  RecoveryPhase,
  RecoveryProposal,
} from "../logic/DiscordGameRecovery";
import { GameInstance } from "../database/GameInstance";
import { escapeText } from "../util/Utils";
import type { TeamPlanRecord } from "../util/PlanUtil";
import { GameRecoveryCoordinator } from "../logic/ActiveGameRecovery";

type Pending = {
  guildId: string;
  userId: string;
  lifecycleToken: string;
  expiresAt: number;
  options: RecoveryOptions;
  preview: RecoveryProposal;
};

export default class RecoverGameCommand implements Command {
  name = "recover-game";
  description = "Rebuild a lost live game from the bot's Discord messages";
  buttonIds = ["recover-game-confirm:", "recover-game-cancel:"];
  private readonly pending = new Map<string, Pending>();
  private committing = false;

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((option) =>
      option
        .setName("phase")
        .setDescription("The phase to restore (choose deliberately)")
        .setRequired(true)
        .addChoices(
          { name: "Announced / registering", value: "announced" },
          { name: "Teams finalised, not started", value: "teams" },
          { name: "Game already started", value: "started" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("announcement_link")
        .setDescription("Link to the original confirmed bot announcement")
    )
    .addStringOption((o) =>
      o
        .setName("registered_link")
        .setDescription("Link to the bot's registered-players embed")
    )
    .addStringOption((o) =>
      o
        .setName("teams_link")
        .setDescription("Link to the bot's current-teams or draft embed")
    )
    .addStringOption((o) =>
      o
        .setName("start_time")
        .setDescription(
          "Fallback ISO timestamp with timezone, e.g. 2026-11-20T22:00:00Z"
        )
    )
    .addStringOption((o) =>
      o
        .setName("map")
        .setDescription("Fallback/correction to the announced map")
    )
    .addStringOption((o) =>
      o
        .setName("banned_classes")
        .setDescription("Fallback/correction: comma-separated classes or none")
    )
    .addStringOption((o) =>
      o
        .setName("modifiers")
        .setDescription(
          "Fallback/correction: Category: Value; Category: Value or none"
        )
    )
    .addStringOption((o) =>
      o
        .setName("double_elo")
        .setDescription("Fallback/correction for Double ELO")
        .addChoices({ name: "Yes", value: "yes" }, { name: "No", value: "no" })
    )
    .addStringOption((o) =>
      o
        .setName("organiser_name")
        .setDescription("Organiser's display name, if missing/wrong")
    )
    .addStringOption((o) =>
      o
        .setName("host_name")
        .setDescription("Host's display name, if missing/wrong")
    )
    .addStringOption((o) =>
      o
        .setName("selection_method")
        .setDescription(
          "How the teams were picked, if not known from the draft"
        )
        .addChoices(
          { name: "Snake draft", value: "SNAKE_DRAFT" },
          { name: "Draft", value: "DRAFT" },
          { name: "Random", value: "RANDOMISED" },
          { name: "ELO", value: "ELO" },
          { name: "Balance", value: "BALANCE" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("red_captain")
        .setDescription("Red captain IGN, if not first in the team embed")
    )
    .addStringOption((o) =>
      o
        .setName("blue_captain")
        .setDescription("Blue captain IGN, if not first in the team embed")
    );

  constructor(private readonly announcementCommand: AnnouncementCommand) {}

  private getOptions(
    interaction: ChatInputCommandInteraction
  ): RecoveryOptions {
    const value = (key: string) =>
      interaction.options.getString(key) ?? undefined;
    return {
      phase: interaction.options.getString("phase", true) as RecoveryPhase,
      announcementLink: value("announcement_link"),
      registeredLink: value("registered_link"),
      teamsLink: value("teams_link"),
      startTime: value("start_time"),
      map: value("map"),
      bannedClasses: value("banned_classes"),
      modifiers: value("modifiers"),
      doubleElo: value("double_elo") as "yes" | "no" | undefined,
      organiser: value("organiser_name"),
      host: value("host_name"),
      selectionMethod: value(
        "selection_method"
      ) as GameInstance["teamsDecidedBy"],
      redCaptain: value("red_captain"),
      blueCaptain: value("blue_captain"),
    };
  }

  private previewEmbed(result: RecoveryProposal): EmbedBuilder {
    const names = (team: "RED" | "BLUE" | "UNDECIDED") =>
      result.teams[team]
        .map(
          (p) =>
            `${p.captain ? "👑 " : ""}${escapeText(p.ignUsed ?? "?")}${result.lateSignups.includes(p.discordSnowflake) ? " (late)" : ""}`
        )
        .join("\n") || "None";
    const planText = (plan?: TeamPlanRecord): string => {
      if (!plan) return "No recoverable plan";
      return `Mid Blocks:\n${escapeText(plan.midBlocks ?? "(missing)")}\nGame Plan:\n${escapeText(plan.gamePlan ?? "(missing)")}${plan.raw ? `\nRaw:\n${escapeText(plan.raw)}` : ""}`;
    };
    const plans = [planText(result.redPlan), planText(result.bluePlan)];
    const voteText = (team: "RED" | "BLUE") => {
      const players = new Map(
        result.teams[team].map((player) => [
          player.discordSnowflake,
          escapeText(player.ignUsed ?? "?"),
        ])
      );
      return (
        result.mvpVotes
          .filter((vote) => vote.team === team)
          .map(
            (vote) =>
              `${players.get(vote.voterId) ?? "Unknown"} → ${players.get(vote.targetId) ?? "Unknown"}`
          )
          .join("\n") || "No verified votes"
      );
    };
    if (
      [
        names("RED"),
        names("BLUE"),
        names("UNDECIDED"),
        ...plans,
        voteText("RED"),
        voteText("BLUE"),
        result.sourceSummary.join("\n"),
        result.warnings.join("\n"),
      ].some((item) => item.length > 1024)
    )
      throw new Error(
        "Recovery preview exceeds Discord field limits; cannot display all evidence for confirmation."
      );
    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("⚠️ Game recovery — review before confirming")
      .setDescription(
        `Phase: **${result.phase}**${result.recoveredEndTime ? " (already ended; not saved)" : ""} · Season: **${result.seasonNumber}** (${result.relaxed ? "Relaxed" : "Ranked"})\nTime: <t:${Math.floor(result.startTime.getTime() / 1000)}:F>\n` +
          `Map: **${result.map}** · Double ELO: **${result.doubleElo ? "Yes" : "No"}**\n` +
          `Method: **${result.teamsDecidedBy ?? "Not picked"}** · ` +
          `Rated: **${
            result.relaxed ||
            (result.phase === "started" &&
              result.teams.RED.length + result.teams.BLUE.length <
                GameInstance.MIN_ELO_PLAYER_COUNT)
              ? "No"
              : "Yes"
          }**\n` +
          `Organiser: ${escapeText(result.organiser)} · Host: ${escapeText(result.host)}\n` +
          `Banned classes: ${result.bannedClasses.join(", ") || "None"}\n` +
          `Modifiers: ${result.modifiers.map((m) => `${m.category}: ${m.name}`).join("; ") || "None"}`
      )
      .addFields(
        {
          name: `🔴 Red (${result.teams.RED.length})`,
          value: names("RED"),
          inline: true,
        },
        {
          name: `🔵 Blue (${result.teams.BLUE.length})`,
          value: names("BLUE"),
          inline: true,
        },
        {
          name: `Unassigned (${result.teams.UNDECIDED.length})`,
          value: names("UNDECIDED"),
          inline: true,
        },
        {
          name: "Discord evidence",
          value: result.sourceSummary.join("\n"),
        },
        {
          name: "Limitations / review",
          value: result.warnings.join("\n"),
        },
        {
          name: `🔴 Verified MVP votes (${result.mvpVotes.filter((vote) => vote.team === "RED").length})`,
          value: voteText("RED"),
          inline: true,
        },
        {
          name: `🔵 Verified MVP votes (${result.mvpVotes.filter((vote) => vote.team === "BLUE").length})`,
          value: voteText("BLUE"),
          inline: true,
        },
        { name: "Red plan (as recovered)", value: plans[0] },
        { name: "Blue plan (as recovered)", value: plans[1] }
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await PermissionsUtil.isUserAuthorised(interaction))) return;
    if (!interaction.guild) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (this.committing) {
      await interaction.editReply(
        "Another recovery confirmation is already in progress."
      );
      return;
    }
    try {
      for (const [id, preview] of this.pending) {
        if (preview.expiresAt <= Date.now()) this.pending.delete(id);
      }
      const options = this.getOptions(interaction);
      const initialToken = GameInstance.getInstance().getLifecycleToken();
      const preview = await buildDiscordRecovery(interaction.guild, options);
      if (GameInstance.getInstance().getLifecycleToken() !== initialToken) {
        throw new Error("Game lifecycle changed during the Discord scan.");
      }
      const nonce = randomUUID();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`recover-game-confirm:${nonce}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel("Confirm recovery"),
        new ButtonBuilder()
          .setCustomId(`recover-game-cancel:${nonce}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Cancel")
      );
      await interaction.editReply({
        content:
          "No state has been changed. Verify every player, captain and setting. Confirm within 5 minutes or cancel.",
        embeds: [this.previewEmbed(preview)],
        components: [row],
        allowedMentions: { parse: [] },
      });
      this.pending.set(nonce, {
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        lifecycleToken: initialToken,
        expiresAt: Date.now() + 5 * 60_000,
        options,
        preview,
      });
    } catch (error) {
      await interaction.editReply({
        content: `Recovery preview failed; nothing was modified. ${error instanceof Error ? error.message : "Unknown error"}`,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const [action, nonce] = interaction.customId.split(":");
    const pending = this.pending.get(nonce);
    if (!pending || Date.now() > pending.expiresAt) {
      this.pending.delete(nonce);
      await interaction.reply({
        content: "Recovery preview expired. Run /recover-game again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      interaction.user.id !== pending.userId ||
      interaction.guildId !== pending.guildId ||
      !interaction.guild
    ) {
      await interaction.reply({
        content: "Only the organiser who created this preview can confirm it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const member = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You no longer have the organiser role.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (this.committing) {
      await interaction.reply({
        content: "A recovery is already being committed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.pending.delete(nonce); // Single-use regardless of success or Discord acknowledgement.
    if (action === "recover-game-cancel") {
      await interaction.update({
        content: "Recovery cancelled. No game state was changed.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (action !== "recover-game-confirm" || !interaction.guild) return;
    this.committing = true;
    let installed = false;
    let releaseExclusive: (() => void) | undefined;
    try {
      await interaction.deferUpdate();
      releaseExclusive = await GameRecoveryCoordinator.claimDiscordRecovery();
      if (
        GameInstance.getInstance().getLifecycleToken() !==
        pending.lifecycleToken
      ) {
        throw new Error("Game lifecycle changed since the preview.");
      }
      await ensureRecoveryAllowed(pending.preview.startTime, true);
      const current = await buildDiscordRecovery(
        interaction.guild,
        pending.options,
        true
      );
      if (current.fingerprint !== pending.preview.fingerprint) {
        throw new Error(
          "Discord evidence or player stats changed since the preview. Run /recover-game again."
        );
      }
      // Role membership can change while the final Discord/database scan runs.
      const finalMember = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => null);
      if (
        !finalMember ||
        !PermissionsUtil.hasRole(finalMember, "organiserRole")
      )
        throw new Error(
          "Your organiser role was revoked during recovery verification."
        );
      await ensureRecoveryAllowed(current.startTime, true);
      if (
        GameInstance.getInstance().getLifecycleToken() !==
        pending.lifecycleToken
      ) {
        throw new Error("Game lifecycle changed during verification.");
      }
      installDiscordRecovery(current);
      installed = true;
      if (current.announcementMessage) {
        this.announcementCommand.attachRecoveredAnnouncementMessage(
          current.announcementMessage
        );
      }
      this.pending.clear();
      console.info(
        `event=game.discord_recovery outcome=succeeded players=${Object.values(current.teams).flat().length} phase=${current.phase}`
      );
      await interaction.editReply({
        content:
          `✅ Game reconstructed in memory (${current.phase}${current.recoveredEndTime ? ", ended pending save" : ""}, ${Object.values(current.teams).flat().length} players). ` +
          `${current.mvpVotes.length} verified MVP vote(s) restored; inspect the preview for any skipped or missing votes. ` +
          "No messages, Discord roles or VCs were recreated. Inspect /team list and /game diagnostics before continuing. " +
          "Timers, vote sessions and game feeds remain paused. The reconstructed game will still be lost if the process crashes again.",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (installed) {
        console.error(
          "Recovery was installed, but the Discord response failed. Do NOT retry blindly.",
          error
        );
      } else {
        console.warn(
          "Discord message recovery rejected:",
          error instanceof Error ? error.message : String(error)
        );
        await interaction
          .editReply({
            content: `Recovery not confirmed: ${error instanceof Error ? error.message : "Unknown error"}`,
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
          })
          .catch((responseError) =>
            console.warn("Recovery rejection response failed", responseError)
          );
      }
    } finally {
      releaseExclusive?.();
      this.committing = false;
    }
  }
}
