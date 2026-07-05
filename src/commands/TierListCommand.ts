import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  Message,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { ConfigManager, DEFAULT_TIER_LIST_CONFIG } from "../ConfigManager";
import { Command } from "./CommandInterface";
import { prismaClient } from "../database/prismaClient";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { escapeText } from "../util/Utils";
import {
  applyLimitedSampleGuardrail,
  buildFallbackPlacement,
  buildPlacementPromptPayload,
  hasAcceptedLimitedSampleContext,
  loadAllSeasonTierDossiers,
  ANCHOR_COUNT,
  ANCHOR_MIN_GAMES,
  suggestConsistencyMoves,
} from "../logic/tierList/AllSeasonTierList";
import { OllamaTierJudge } from "../logic/tierList/OllamaTierJudge";
import { TierListEventManager } from "../logic/tierList/TierListEventManager";
import {
  emptyTierListImageRows,
  renderTierListSnapshot,
  TierListHeadCache,
  TierListImageRows,
} from "../logic/tierList/TierListImageRenderer";
import {
  TierConfidence,
  TierListFinalVerdict,
  PlayerTierDossier,
  TierListFinalReviewRevision,
  TierPlacement,
  TierListTier,
  TierPosition,
  TIER_ORDER,
} from "../logic/tierList/types";

const BUTTON_CONTINUE = "tierlist:continue";
const BUTTON_DISCARD = "tierlist:discard";
const BUTTON_REROLL = "tierlist:reroll";
const BUTTON_SKIP = "tierlist:skip-active";
const BUTTON_QUESTION_PAUSE = "tierlist:question-pause";
const BUTTON_OLD_NAMES = "tierlist:old-names";
const BUTTON_EXTEND_TIME = "tierlist:extend-time";
const BUTTON_APPLY_CONSISTENCY = "tierlist:apply-consistency";
const BUTTON_NEXT_PLAYER = "tierlist:placement-next";
const BUTTON_PAUSE = "tierlist:placement-pause";
const BUTTON_REQUEST_RERATE = "tierlist:placement-rerate";
const MODAL_RERATE = "tierlist:rerate-modal";
const FINAL_TIER_LIST_IMAGE_MESSAGE = "Final tier list complete. Full list:";
const FILTERED_FINAL_TIER_LIST_IMAGE_MESSAGE =
  "Confidence-filtered final tier list. Limited-data players removed:";
const UNCHANGED_FILTERED_FINAL_TIER_LIST_IMAGE_MESSAGE =
  "Confidence-filtered final tier list is identical to the full list; no limited-data players were removed.";
const PROVISIONAL_SNAPSHOT_CADENCE = 5;

type PlacementResult =
  | { placement: TierPlacement; source: string }
  | { skipped: string };

type EditablePlacementMessage = {
  id?: string;
  edit?: (payload: {
    content?: string;
    embeds?: EmbedBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  }) => Promise<unknown>;
};

type FinalReviewTierResult = {
  applied: TierPlacement[];
  reviewedCount: number;
  segments: TierPosition[];
  failedSegments: { segment: TierPosition; reason: string }[];
  source: string;
};

type KnownNameEntry = {
  name: string;
  current: boolean;
  primary: boolean;
};

const FINAL_REVIEW_SEGMENTS: TierPosition[] = ["high", "mid", "low"];

export default class TierListCommand implements Command {
  public name = "tierlist";
  public description = "Run an all-season evidence-assisted tier list event.";
  public buttonIds: string[] = [
    BUTTON_CONTINUE,
    BUTTON_DISCARD,
    BUTTON_REROLL,
    BUTTON_SKIP,
    BUTTON_QUESTION_PAUSE,
    BUTTON_OLD_NAMES,
    BUTTON_EXTEND_TIME,
    BUTTON_APPLY_CONSISTENCY,
    BUTTON_NEXT_PLAYER,
    BUTTON_PAUSE,
    BUTTON_REQUEST_RERATE,
  ];
  public modalIds: string[] = [MODAL_RERATE];
  public data: SlashCommandSubcommandsOnlyBuilder;

  private readonly manager = new TierListEventManager();
  private readonly tierJudge = new OllamaTierJudge();
  private imageHeadCache:
    | { eventId: string; cache: TierListHeadCache }
    | undefined;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("start")
          .setDescription("Start a fresh tier list event")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("Limit players for a shorter event")
              .setMinValue(1)
              .setMaxValue(200)
          )
          .addIntegerOption((option) =>
            option
              .setName("played_recently")
              .setDescription(
                "Only include players active in the last N months"
              )
              .setMinValue(1)
              .setMaxValue(60)
          )
          .addBooleanOption((option) =>
            option
              .setName("fast_mode")
              .setDescription(
                "Place all players and run final review immediately"
              )
          )
          .addBooleanOption((option) =>
            option
              .setName("no_community_input")
              .setDescription(
                "Skip anchor polls, community questions, and rerates"
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("next")
          .setDescription("Place the next player")
          .addIntegerOption((option) =>
            option
              .setName("count")
              .setDescription("Number of players to place now")
              .setMinValue(1)
              .setMaxValue(10)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("show")
          .setDescription("Show current tier list state")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("undo")
          .setDescription("Undo the most recent placement")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("skip")
          .setDescription("Move the next player to the end of the queue")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("rereview")
          .setDescription("Re-review an already placed player")
          .addStringOption((option) =>
            option
              .setName("player")
              .setDescription("Placed player to re-review")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("reason")
              .setDescription("Optional organiser context for the re-review")
              .setMaxLength(500)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("final")
          .setDescription("Review all remaining final tiers")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reset").setDescription("Reset the current event")
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    if (group === "note") {
      await this.note(interaction, subcommand);
      return;
    }

    switch (subcommand) {
      case "start":
        await this.start(interaction);
        return;
      case "next":
        await this.next(interaction);
        return;
      case "show":
        await this.show(interaction);
        return;
      case "dossier":
        await this.dossier(interaction);
        return;
      case "prompt":
        await this.prompt(interaction);
        return;
      case "consistency":
        await this.consistency(interaction);
        return;
      case "undo":
        await this.undo(interaction);
        return;
      case "skip":
        await this.skip(interaction);
        return;
      case "rereview":
        await this.rereview(interaction);
        return;
      case "final":
        await this.final(interaction);
        return;
      case "llm-status":
        await this.llmStatus(interaction);
        return;
      case "reset":
        this.manager.reset();
        await interaction.reply("Tier list event reset.");
        return;
      default:
        await interaction.reply("Unknown tier list subcommand.");
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === BUTTON_REQUEST_RERATE) {
      await this.requestRerate(interaction);
      return;
    }

    if (interaction.customId === BUTTON_OLD_NAMES) {
      await this.postOldNames(interaction);
      return;
    }

    if (interaction.customId === BUTTON_EXTEND_TIME) {
      await this.extendQuestionTime(interaction);
      return;
    }

    if (!this.isOrganiserButton(interaction)) {
      await interaction.reply({
        content: "Only organisers can control tier-list questions.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === BUTTON_NEXT_PLAYER) {
      await this.placeNextFromButton(interaction);
      return;
    }

    if (interaction.customId === BUTTON_PAUSE) {
      this.manager.pauseAutoAdvance();
      await this.disableActivePlacementControls(interaction);
      await interaction.reply({
        content: "Tier-list auto-advance paused.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === BUTTON_REROLL) {
      const question = this.manager.rerollQuestion();
      if (!question) {
        await interaction.reply({
          content: "No active tier-list question is running.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.update({
        content: this.questionContent(
          question,
          this.manager.getActiveQuestion()?.paused
        ),
        components: this.questionComponents(),
      });
      return;
    }

    if (interaction.customId === BUTTON_QUESTION_PAUSE) {
      const anchorSession = this.manager.pauseAnchorPoll();
      if (anchorSession) {
        const state = this.manager.getState();
        const dossier = this.manager.currentAnchorDossier();
        await interaction.update({
          content: dossier
            ? this.anchorPollContent(
                dossier,
                (state?.activeAnchorIndex ?? 0) + 1,
                state?.anchorPlayerIds.length ?? 0,
                true
              )
            : "Anchor poll paused.",
          components: this.anchorPollComponents(),
        });
        return;
      }

      const session = this.manager.pauseQuestion();
      if (!session) {
        await interaction.reply({
          content: "No active tier-list question is running.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.update({
        content: this.questionContent(session.question, true),
        components: this.questionComponents(),
      });
      return;
    }

    if (interaction.customId === BUTTON_APPLY_CONSISTENCY) {
      const applied = this.manager.applyPendingConsistencyMoves();
      await interaction.update({
        content: applied.length
          ? `Applied ${applied.length} consistency move(s): ${applied
              .map(
                (move) =>
                  `${move.player} -> ${move.targetPosition} ${move.targetTier}`
              )
              .join(", ")}.`
          : "No pending consistency moves to apply.",
        components: [],
      });
      if (applied.length) {
        await this.safePostTierListImageSnapshot(interaction);
      }
      return;
    }

    const activeAnchor = this.manager.getActiveAnchor();
    if (activeAnchor) {
      this.manager.finishAnchorPoll();
      await interaction.deferUpdate();
      return;
    }

    const action =
      interaction.customId === BUTTON_DISCARD
        ? "discard"
        : interaction.customId === BUTTON_SKIP
          ? "skip"
          : "continue";
    this.manager.finishQuestion(action, this.tierConfig().maxCommunityAnswers);
    await interaction.deferUpdate();
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith(MODAL_RERATE)) return;
    const config = this.tierConfig();
    const accepted = this.manager.addRerateJustification(
      interaction.fields.getTextInputValue("justification"),
      config.rerateJustificationMaxLength
    );
    const review = this.manager.getState()?.activePlacementReview;
    await interaction.reply({
      content: accepted
        ? `Rerate note recorded (${review?.voters.length ?? 0}/${config.rerateVoteThreshold}).`
        : "Rerate vote recorded. The note was too short or too directive, so it will not be passed to the judge.",
      flags: MessageFlags.Ephemeral,
    });

    if (review?.thresholdReached) {
      await this.rerateActivePlacement(interaction);
    }
  }

  handleMessage(message: Message) {
    return this.manager.handleMessage(message);
  }

  private async start(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const limit = interaction.options.getInteger("limit");
    const fastMode = interaction.options.getBoolean("fast_mode") ?? false;
    const noCommunityInput =
      fastMode ||
      (interaction.options.getBoolean("no_community_input") ?? false);
    const playedRecentlyMonths =
      interaction.options.getInteger("played_recently");
    const cutoff = playedRecentlyMonths
      ? monthsAgo(playedRecentlyMonths)
      : null;
    const dossiers = await this.loadDossiers();
    const eligible = cutoff
      ? dossiers.filter((dossier) => dossier.lastPlayedAt >= cutoff)
      : dossiers;
    const randomized = shuffledCopy(eligible);
    const selected = limit ? randomized.slice(0, limit) : randomized;
    this.manager.start(selected, { fastMode, noCommunityInput });
    this.imageHeadCache = undefined;
    this.logDebug("event started", {
      randomized: true,
      original: dossiers.length,
      filtered: eligible.length,
      shuffled: randomized.length,
      selected: selected.length,
      limit: limit ?? "none",
      playedRecentlyMonths: playedRecentlyMonths ?? "omitted",
      cutoff: cutoff?.toISOString() ?? "none",
      fastMode,
      noCommunityInput,
    });

    if (fastMode) {
      await this.runFastMode(
        interaction,
        selected.length,
        playedRecentlyMonths
      );
      return;
    }

    await interaction.editReply({
      embeds: [this.startEmbed(selected.length, playedRecentlyMonths)],
    });
    await this.runAnchorPhase(interaction);
  }

  private async next(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    await interaction.deferReply();
    const state = this.manager.getState();
    if (state?.phase === "anchor") {
      await interaction.editReply(
        "Anchor community voting is still active. Wait for the anchor pre-phase to finish before using `/tierlist next`."
      );
      return;
    }
    const count = interaction.options.getInteger("count") ?? 1;
    this.logDebug("next command started", {
      requestedCount: count,
      ...this.stateDebugSummary(),
    });
    let sent = false;
    for (let i = 0; i < count; i++) {
      const dossier = this.manager.nextDossier();
      if (!dossier) {
        this.logDebug(
          "next command found no dossier",
          this.stateDebugSummary()
        );
        break;
      }
      this.logDebug("placing next dossier", {
        index: i + 1,
        requestedCount: count,
        player: dossier.displayName,
        remainingBefore: this.manager.getState()?.unplacedPlayerIds.length ?? 0,
      });
      if (sent) {
        this.manager.clearAutoAdvanceTimer();
        await this.disableActivePlacementControls(interaction);
      }
      const processingMessage = await this.sendProcessingEmbed(
        interaction,
        dossier.displayName,
        !sent
      );
      const result = await this.placeNextWithJudge(interaction);
      if (!result) break;
      if ("placement" in result) {
        await this.sendPlacementResult(
          interaction,
          result,
          !sent,
          processingMessage
        );
        await this.safePostTierListImageSnapshotOnCadence(interaction);
        await this.notifyProvisionalComplete(interaction);
        this.scheduleAutoAdvance(interaction);
      } else {
        await this.sendSkippedResult(
          interaction,
          result.skipped,
          !sent,
          processingMessage
        );
      }
      sent = true;
    }

    if (!sent) {
      await interaction.editReply("No unplaced players remain.");
      await this.notifyProvisionalComplete(interaction);
      return;
    }
    this.logDebug("next command completed", this.stateDebugSummary());
  }

  private async show(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;
    await interaction.reply({ content: this.currentStateText() });
  }

  private async dossier(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    const dossier = this.manager.dossierByQuery(
      interaction.options.getString("player", true)
    );
    if (!dossier) {
      await interaction.reply({
        content: "No dossier matched that player.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: this.formatDossier(dossier),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async prompt(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    const dossier = this.manager.nextDossier();
    const state = this.manager.getState();
    if (!dossier || !state) {
      await interaction.reply({
        content: "No unplaced players remain.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const payload = buildPlacementPromptPayload(
      dossier,
      this.manager.getDossiers(),
      state,
      { manualNotes: this.manager.manualNotesFor(dossier.playerId) }
    );
    await interaction.reply({
      content: this.truncateCodeBlock(JSON.stringify(payload, null, 2)),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async consistency(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    const suggestions = suggestConsistencyMoves(this.manager.getState()!);
    this.manager.setPendingConsistencyMoves(suggestions);
    await interaction.reply({
      content: suggestions.length
        ? [
            "Suggested bounded moves for organiser review:",
            ...suggestions.map((item) => `- ${item.suggestion}`),
          ].join("\n")
        : "No obvious ordering contradictions found.",
      components: suggestions.length
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(BUTTON_APPLY_CONSISTENCY)
                .setLabel("Apply suggested moves")
                .setStyle(ButtonStyle.Primary)
            ),
          ]
        : [],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async undo(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;
    const placement = this.manager.undoLastPlacement();
    if (!placement) {
      await interaction.reply({
        content: "There is no placement to undo.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.updateLiveSummary(interaction);
    await this.safePostTierListImageSnapshot(interaction);
    await interaction.reply(
      `Undid ${this.displayName(placement.displayName)}; they are back at the front of the queue.`
    );
  }

  private async skip(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;
    const skipped = this.manager.skipNext();
    await interaction.reply(
      skipped
        ? `Skipped ${this.displayName(skipped.displayName)}; moved to the end of the queue.`
        : "No unplaced players remain."
    );
  }

  private async rereview(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    const player = interaction.options.getString("player", true);
    const target = this.manager.placedDossierByQuery(player);
    if (!target) {
      await interaction.reply({
        content: "That player is not currently placed in the tier list.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const processingMessage = await this.sendProcessingEmbed(
      interaction,
      target.dossier.displayName,
      true,
      true
    );
    const result = await this.reviewPlacedPlayer(
      target.dossier,
      target.placement,
      interaction.options.getString("reason")?.trim() || undefined
    );

    await this.editOrSendPlacementMessage(
      interaction,
      {
        embeds: [this.placementEmbed(result.placement, "Ollama review")],
        components: this.placementComponents(),
      },
      true,
      processingMessage
    );
    await this.safePostTierListImageSnapshot(interaction);
  }

  private async final(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    const state = this.manager.getState();
    if (!state) return;
    this.logDebug("final command invoked", this.stateDebugSummary());
    if (state.unplacedPlayerIds.length > 0) {
      this.logDebug("final command refused; provisional players remain", {
        unplaced: state.unplacedPlayerIds.length,
      });
      await interaction.reply({
        content: `Final review can only start after provisional placement is complete. ${state.unplacedPlayerIds.length} player(s) remain unplaced.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const phaseSwitch = state.phase === "provisional";
    const tier = this.manager.startOrAdvanceFinalReview();
    if (!tier) {
      this.logDebug(
        "final command found review already complete",
        this.stateDebugSummary()
      );
      await interaction.reply("Final review is complete for every tier.");
      return;
    }
    this.logDebug("final review started", {
      phaseSwitch,
      startingTier: tier,
      ...this.stateDebugSummary(),
    });

    await interaction.deferReply();
    const phaseSwitchContent = phaseSwitch
      ? "**Phase change:** Provisional ranking is complete. Switching to final review for within-tier re-ordering and evidence-based adjacent moves."
      : undefined;
    let processingMessage = await this.sendInteractionPayload(
      interaction,
      {
        content: phaseSwitchContent,
        embeds: [this.finalReviewProcessingEmbed(tier, phaseSwitch)],
      },
      true
    );

    let currentTier: TierListTier | null = tier;
    let firstTier = true;
    while (currentTier) {
      this.logDebug("final tier processing started", {
        tier: currentTier,
        ...this.tierDebugSummary(currentTier),
      });
      if (!firstTier) {
        processingMessage = await this.sendInteractionPayload(
          interaction,
          {
            embeds: [this.finalReviewProcessingEmbed(currentTier)],
          },
          false
        );
      }

      const result = await this.reviewFinalTierSegments(currentTier);
      this.logDebug("final tier processing completed", {
        tier: currentTier,
        reviewed: result.reviewedCount,
        changed: result.applied.length,
        tierMoves: result.applied.filter(
          (placement) => placement.tier !== currentTier
        ).length,
        completedSegments: result.segments.join("/") || "none",
        failedSegments:
          result.failedSegments
            .map((failure) => `${failure.segment}:${failure.reason}`)
            .join("; ") || "none",
      });
      const response = {
        content: firstTier ? phaseSwitchContent : undefined,
        embeds: [
          this.finalReviewEmbed(currentTier, result, firstTier && phaseSwitch),
        ],
      };
      if (processingMessage?.edit) {
        await processingMessage.edit(response);
      } else if (firstTier) {
        await interaction.editReply(response);
      } else {
        await this.sendInteractionPayload(interaction, response, false);
      }

      currentTier = this.manager.nextFinalReviewTier();
      this.logDebug("final review next tier resolved", {
        nextTier: currentTier ?? "complete",
        ...this.stateDebugSummary(),
      });
      await this.safePostTierListImageSnapshot(
        interaction,
        currentTier ? undefined : FINAL_TIER_LIST_IMAGE_MESSAGE
      );
      firstTier = false;
    }
    await this.postFinalVerdict(interaction);
  }

  private async llmStatus(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await this.tierJudge.status();
    await interaction.editReply(
      [
        `Enabled: ${status.enabled ? "yes" : "no"}`,
        `Base URL: ${status.baseUrl ?? "-"}`,
        `Model: ${status.model ?? "-"}`,
        `Reachable: ${status.reachable ? "yes" : "no"}`,
        `Model listed: ${status.modelAvailable ? "yes" : "no"}`,
        status.message,
      ].join("\n")
    );
  }

  private async note(
    interaction: ChatInputCommandInteraction,
    subcommand: string
  ) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;
    const dossier = this.manager.dossierByQuery(
      interaction.options.getString("player", true)
    );
    if (!dossier) {
      await interaction.reply({
        content: "No dossier matched that player.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "add") {
      const note = interaction.options.getString("note", true).trim();
      this.manager.addManualNote(dossier.playerId, note);
      await interaction.reply({
        content: `Added subjective organiser note for ${this.displayName(dossier.displayName)}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.manager.clearManualNotes(dossier.playerId);
    await interaction.reply({
      content: `Cleared subjective organiser notes for ${this.displayName(dossier.displayName)}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async placeNextWithJudge(
    interaction: ChatInputCommandInteraction
  ): Promise<PlacementResult | null> {
    const dossier = this.manager.nextDossier();
    const state = this.manager.getState();
    if (!dossier || !state) return null;

    const questionResult = await this.collectCommunityNotes(
      interaction,
      dossier
    );
    if (questionResult?.action === "skip") {
      const skipped = this.manager.skipNext();
      return skipped ? { skipped: skipped.displayName } : null;
    }

    const manualNotes = this.manager.manualNotesFor(dossier.playerId);
    const hasLimitedSampleContext = hasAcceptedLimitedSampleContext({
      communityNotesAccepted: questionResult?.notes.accepted.length,
      manualNotes,
    });
    const payload = buildPlacementPromptPayload(
      dossier,
      this.manager.getDossiers(),
      state,
      {
        communityNotesSummary: questionResult?.notes.summary,
        manualNotes,
      }
    );
    const judged = await this.tierJudge.judge(payload);
    if (judged.source === "ollama") {
      const placement = applyLimitedSampleGuardrail(
        dossier,
        {
          playerId: dossier.playerId,
          displayName: dossier.displayName,
          score: dossier.score,
          ...judged.placement,
        },
        hasLimitedSampleContext
      );
      this.manager.commitPlacement(placement);
      this.logDebug("placement committed from judge", {
        player: dossier.displayName,
        tier: placement.tier,
        position: placement.position,
        remaining: this.manager.getState()?.unplacedPlayerIds.length ?? 0,
      });
      return { placement, source: "Ollama" };
    }

    const placement = applyLimitedSampleGuardrail(
      dossier,
      buildFallbackPlacement(dossier),
      hasLimitedSampleContext
    );
    this.manager.commitPlacement(placement);
    this.logDebug("placement committed from fallback", {
      player: dossier.displayName,
      tier: placement.tier,
      position: placement.position,
      reason: judged.reason,
      remaining: this.manager.getState()?.unplacedPlayerIds.length ?? 0,
    });
    return { placement, source: `fallback: ${judged.reason}` };
  }

  private async runAnchorPhase(interaction: ChatInputCommandInteraction) {
    let state = this.manager.getState();
    if (!state || state.phase !== "anchor") return;

    const total = state.anchorPlayerIds.length;
    const channelId = this.resolveQuestionChannelId();
    await this.sendChannelPayload(interaction, {
      content: `Anchor pre-phase started. Polling ${total} statistically significant player(s) before provisional placement. Reply with A, B, C, D, or E only.`,
    });

    while (true) {
      const anchorState = this.manager.getState();
      if (!anchorState || anchorState.phase !== "anchor") break;
      const dossier = this.manager.currentAnchorDossier();
      if (!dossier) {
        anchorState.phase = "provisional";
        break;
      }
      const anchorNumber = anchorState.activeAnchorIndex + 1;
      const pollPromise = this.manager.beginAnchorPoll(
        dossier,
        channelId,
        this.tierConfig().questionWindowSeconds * 1000
      );
      await this.sendAnchorPoll(interaction, dossier, anchorNumber, total);
      await pollPromise;
    }

    await this.sendChannelPayload(interaction, {
      content:
        "Anchor pre-phase is complete. Organisers can now use `/tierlist next` to begin provisional placement.",
    });
  }

  private async sendAnchorPoll(
    interaction: ChatInputCommandInteraction,
    dossier: PlayerTierDossier,
    anchorNumber: number,
    total: number
  ) {
    const channelId = this.resolveQuestionChannelId();
    const channel = await interaction.guild?.channels
      .fetch(channelId)
      .catch(() => null);
    const target = channel?.isTextBased()
      ? channel
      : interaction.channel?.isTextBased()
        ? interaction.channel
        : null;
    if (!target || !("send" in target)) {
      this.manager.finishAnchorPoll();
      return;
    }
    const sendable = target as { send: (options: unknown) => Promise<unknown> };
    await sendable.send({
      content: this.anchorPollContent(dossier, anchorNumber, total),
      components: this.anchorPollComponents(),
    });
  }

  private anchorPollContent(
    dossier: PlayerTierDossier,
    anchorNumber: number,
    total: number,
    paused = false
  ) {
    const windowLine = paused
      ? "Window: paused. Organisers should press Continue when voting is done."
      : `Window: ${this.tierConfig().questionWindowSeconds}s. One A-E vote per person.`;
    return [
      `**Tier-list anchor vote ${anchorNumber}/${total}**`,
      `Rough community tier for **${this.displayName(dossier.displayName)}**? Reply with A, B, C, D, or E only.`,
      this.displayText(dossier.objectiveSummary),
      windowLine,
    ].join("\n");
  }

  private anchorPollComponents() {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(BUTTON_CONTINUE)
          .setLabel("Continue")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(BUTTON_QUESTION_PAUSE)
          .setLabel("Pause timer")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  private async placeNextFromButton(interaction: ButtonInteraction) {
    this.manager.resumeAutoAdvance();
    this.manager.clearAutoAdvanceTimer();
    await this.disableActivePlacementControls(interaction);
    await interaction.deferUpdate();
    const dossier = this.manager.nextDossier();
    const processingMessage = dossier
      ? await this.sendProcessingEmbed(interaction, dossier.displayName, false)
      : undefined;
    const result = await this.placeNextWithJudgeFromAnyInteraction(interaction);
    if (!result) {
      await interaction.followUp({
        content: "No unplaced players remain.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if ("placement" in result) {
      await this.sendPlacementResult(
        interaction,
        result,
        false,
        processingMessage
      );
      await this.safePostTierListImageSnapshotOnCadence(interaction);
      await this.notifyProvisionalComplete(interaction);
      this.scheduleAutoAdvance(interaction);
    } else {
      await interaction.followUp(
        `Skipped ${result.skipped}; moved to the end.`
      );
    }
  }

  private async placeNextWithJudgeFromAnyInteraction(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ): Promise<PlacementResult | null> {
    const dossier = this.manager.nextDossier();
    const state = this.manager.getState();
    if (!dossier || !state) return null;

    const questionResult = await this.collectCommunityNotes(
      interaction,
      dossier
    );
    if (questionResult?.action === "skip") {
      const skipped = this.manager.skipNext();
      return skipped ? { skipped: skipped.displayName } : null;
    }

    const manualNotes = this.manager.manualNotesFor(dossier.playerId);
    const hasLimitedSampleContext = hasAcceptedLimitedSampleContext({
      communityNotesAccepted: questionResult?.notes.accepted.length,
      manualNotes,
    });
    const payload = buildPlacementPromptPayload(
      dossier,
      this.manager.getDossiers(),
      state,
      {
        communityNotesSummary: questionResult?.notes.summary,
        manualNotes,
      }
    );
    const judged = await this.tierJudge.judge(payload);
    if (judged.source === "ollama") {
      const placement = applyLimitedSampleGuardrail(
        dossier,
        {
          playerId: dossier.playerId,
          displayName: dossier.displayName,
          score: dossier.score,
          ...judged.placement,
        },
        hasLimitedSampleContext
      );
      this.manager.commitPlacement(placement);
      this.logDebug("placement committed from judge", {
        player: dossier.displayName,
        tier: placement.tier,
        position: placement.position,
        remaining: this.manager.getState()?.unplacedPlayerIds.length ?? 0,
      });
      return { placement, source: "Ollama" };
    }

    const placement = applyLimitedSampleGuardrail(
      dossier,
      buildFallbackPlacement(dossier),
      hasLimitedSampleContext
    );
    this.manager.commitPlacement(placement);
    this.logDebug("placement committed from fallback", {
      player: dossier.displayName,
      tier: placement.tier,
      position: placement.position,
      reason: judged.reason,
      remaining: this.manager.getState()?.unplacedPlayerIds.length ?? 0,
    });
    return { placement, source: `fallback: ${judged.reason}` };
  }

  private async sendPlacementResult(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    result: { placement: TierPlacement; source: string },
    editInitial: boolean,
    message?: EditablePlacementMessage
  ) {
    const hasMorePlayers =
      (this.manager.getState()?.unplacedPlayerIds.length ?? 0) > 0;
    const payload = {
      embeds: [this.placementEmbed(result.placement, result.source)],
      components: hasMorePlayers ? this.placementComponents() : [],
    };
    const sent = await this.editOrSendPlacementMessage(
      interaction,
      payload,
      editInitial,
      message
    );
    this.manager.setActivePlacementMessage(sent?.id);
  }

  private async runFastMode(
    interaction: ChatInputCommandInteraction,
    selectedCount: number,
    playedRecentlyMonths: number | null
  ) {
    await interaction.editReply({
      embeds: [
        this.fastModeProcessingEmbed(selectedCount, playedRecentlyMonths),
      ],
      components: [],
    });

    const placements: PlacementResult[] = [];
    while (this.manager.nextDossier()) {
      const result = await this.placeNextWithJudgeFast();
      if (!result) break;
      placements.push(result);
      if ("placement" in result) {
        await this.sendChannelPayload(interaction, {
          embeds: [this.placementEmbed(result.placement, result.source)],
          components: [],
        });
      }
    }

    const reviewed = await this.runFinalReviewToCompletion();
    const state = this.manager.getState();
    await this.safePostTierListImageSnapshot(
      interaction,
      FINAL_TIER_LIST_IMAGE_MESSAGE
    );
    await this.postFinalVerdict(interaction);
    await this.sendChannelPayload(interaction, {
      embeds: [this.fastModeCompleteEmbed(placements, reviewed)],
      components: [],
    });
    this.logDebug("fast mode completed", {
      selected: selectedCount,
      placed: state?.placementCount ?? 0,
      unplaced: state?.unplacedPlayerIds.length ?? 0,
      finalReviewedTiers: state?.finalReviewedTiers.join(",") ?? "none",
    });
  }

  private async placeNextWithJudgeFast(): Promise<PlacementResult | null> {
    const dossier = this.manager.nextDossier();
    const state = this.manager.getState();
    if (!dossier || !state) return null;

    const manualNotes = this.manager.manualNotesFor(dossier.playerId);
    const payload = buildPlacementPromptPayload(
      dossier,
      this.manager.getDossiers(),
      state,
      { manualNotes }
    );
    const judged = await this.tierJudge.judge(payload);
    if (judged.source === "ollama") {
      const placement = applyLimitedSampleGuardrail(
        dossier,
        {
          playerId: dossier.playerId,
          displayName: dossier.displayName,
          score: dossier.score,
          ...judged.placement,
        },
        hasAcceptedLimitedSampleContext({ manualNotes })
      );
      this.manager.commitPlacement(placement);
      return { placement, source: "Ollama" };
    }

    const placement = applyLimitedSampleGuardrail(
      dossier,
      buildFallbackPlacement(dossier),
      hasAcceptedLimitedSampleContext({ manualNotes })
    );
    this.manager.commitPlacement(placement);
    return { placement, source: `fallback: ${judged.reason}` };
  }

  private async runFinalReviewToCompletion() {
    const firstTier = this.manager.startOrAdvanceFinalReview();
    const results: Array<{
      tier: TierListTier;
      result: FinalReviewTierResult;
    }> = [];
    let currentTier = firstTier;
    while (currentTier) {
      const result = await this.reviewFinalTierSegments(currentTier);
      results.push({ tier: currentTier, result });
      currentTier = this.manager.nextFinalReviewTier();
    }
    return results;
  }

  private async sendSkippedResult(
    interaction: ChatInputCommandInteraction,
    skipped: string,
    editInitial: boolean,
    message?: EditablePlacementMessage
  ) {
    await this.editOrSendPlacementMessage(
      interaction,
      {
        embeds: [
          new EmbedBuilder()
            .setTitle("All-Season Tier List: Player Deferred")
            .setDescription(
              `Skipped **${this.displayName(skipped)}** and moved them to the end of the queue.`
            )
            .setColor(0xf59e0b),
        ],
      },
      editInitial,
      message
    );
  }

  private async sendProcessingEmbed(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    player: string,
    editInitial: boolean,
    rereview = false
  ) {
    return this.sendInteractionPayload(
      interaction,
      {
        embeds: [this.processingEmbed(player, rereview)],
        components: [],
      },
      editInitial
    );
  }

  private async editOrSendPlacementMessage(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    payload: {
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
    },
    editInitial: boolean,
    message?: EditablePlacementMessage
  ) {
    if (message?.edit) {
      await message.edit(payload);
      return message;
    }
    return this.sendInteractionPayload(interaction, payload, editInitial);
  }

  private async sendInteractionPayload(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    payload: {
      content?: string;
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
      files?: AttachmentBuilder[];
    },
    editInitial: boolean
  ): Promise<EditablePlacementMessage | undefined> {
    try {
      if ("editReply" in interaction && editInitial) {
        return (await interaction.editReply(
          payload
        )) as EditablePlacementMessage;
      }
      if ("followUp" in interaction) {
        return (await interaction.followUp(
          payload
        )) as EditablePlacementMessage;
      }
    } catch (error) {
      this.logDebug("interaction webhook send failed; using channel fallback", {
        error: this.errorSummary(error),
      });
    }

    return this.sendChannelPayload(interaction, payload);
  }

  private async sendChannelPayload(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    payload: {
      content?: string;
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
      files?: AttachmentBuilder[];
    }
  ): Promise<EditablePlacementMessage | undefined> {
    const target = interaction.channel?.isTextBased()
      ? interaction.channel
      : null;
    if (!target || !("send" in target)) return undefined;
    const sendable = target as {
      send: (options: unknown) => Promise<EditablePlacementMessage>;
    };
    try {
      return await sendable.send(payload);
    } catch (error) {
      this.logDebug("channel fallback send failed", {
        error: this.errorSummary(error),
      });
      return undefined;
    }
  }

  private processingEmbed(player: string, rereview = false) {
    return new EmbedBuilder()
      .setTitle(
        rereview
          ? `🤖 Re-reviewing ${this.displayName(player)}...`
          : `🤖 Reviewing ${this.displayName(player)}...`
      )
      .setDescription(
        "Comparing and analysing the player against the current tier list."
      )
      .setColor(0x2563eb);
  }

  private placementEmbed(placement: TierPlacement, _source: string) {
    const state = this.manager.getState();
    const review = state?.placementReviewsByPlayerId[placement.playerId];
    const statusLines = state?.noCommunityInput
      ? []
      : [
          review?.statusNote,
          review
            ? `Rerate votes: ${review.voters.length}/${this.tierConfig().rerateVoteThreshold}`
            : null,
        ].filter(Boolean);
    return new EmbedBuilder()
      .setTitle(`🤖 AI Verdict: ${this.displayName(placement.displayName)}`)
      .setDescription(`> ${this.displayText(placement.reasoning)}`)
      .setColor(this.tierColor(placement.tier))
      .addFields(
        {
          name: "Placement",
          value: `${placement.position} ${placement.tier}`,
          inline: true,
        },
        { name: "Confidence", value: placement.confidence, inline: true },
        ...(statusLines.length
          ? [{ name: "Review", value: statusLines.join("\n") }]
          : [])
      );
  }

  private finalReviewProcessingEmbed(tier: TierListTier, phaseSwitch = false) {
    return new EmbedBuilder()
      .setTitle(
        phaseSwitch
          ? `Switching to Final Review: ${tier} tier`
          : `🤖 Final reviewing ${tier} tier...`
      )
      .setDescription(
        phaseSwitch
          ? "Provisional placement is finished. The bot is now comparing players inside each tier and against adjacent boundaries."
          : "Comparing players inside the tier and against adjacent boundaries."
      )
      .setColor(this.tierColor(tier));
  }

  private finalReviewEmbed(
    tier: TierListTier,
    result: FinalReviewTierResult,
    phaseSwitch = false
  ) {
    const commentary = this.finalReviewTierCommentary(tier, result);
    return new EmbedBuilder()
      .setTitle(`🤖 AI Verdict: ${tier} tier`)
      .setColor(this.tierColor(tier))
      .setDescription(`> ${this.displayText(commentary)}`)
      .addFields(
        ...(phaseSwitch
          ? [
              {
                name: "Phase",
                value: "Final review started",
                inline: true,
              },
            ]
          : []),
        { name: "Source", value: this.displayText(result.source), inline: true }
      );
  }

  private finalReviewTierCommentary(
    tier: TierListTier,
    result: FinalReviewTierResult
  ) {
    const state = this.manager.getState();
    const placements = state?.placed[tier] ?? [];
    if (!placements.length) {
      return `${tier} tier ended empty after review, which means the evidence did not support a distinct group at this level.`;
    }

    const dossiersByPlayerId = new Map(
      this.manager.getDossiers().map((dossier) => [dossier.playerId, dossier])
    );
    const confidence = this.confidenceSummary(
      placements.map((placement) => placement.confidence)
    );
    const limited = placements.filter(
      (placement) => dossiersByPlayerId.get(placement.playerId)?.limitedSample
    ).length;
    const topNames = placements
      .slice(0, 5)
      .map((placement) => placement.displayName);
    const profile = this.tierCapabilityProfile(tier);
    const moves = result.applied.filter(
      (placement) => placement.tier !== tier
    ).length;
    const caveat = limited
      ? ` ${limited} placement(s) still carry limited-sample caution.`
      : "";
    const movement = moves
      ? ` Review moved ${moves} player(s) around the boundary.`
      : " Review kept the tier shape stable.";
    return `${tier} tier is defined by ${profile}. The clearest examples are ${topNames.join(", ")}. Confidence mix: ${confidence || "no explicit confidence spread"}.${caveat}${movement}`;
  }

  private tierCapabilityProfile(tier: TierListTier) {
    switch (tier) {
      case "S":
        return "rare players who can bend games independently, stay valuable across team contexts, and show multiple elite signals rather than one hot statistic";
      case "A":
        return "high-impact players who usually create winning pressure on their own, but may be slightly less universal or less proven than the S-tier outliers";
      case "B":
        return "above-average players with real carry or specialist value, usually needing either cleaner team context, more consistency, or a larger sample before moving higher";
      case "C":
        return "the broad dependable middle: players who can contribute in normal conditions but do not yet show enough independent pressure to separate upward";
      case "D":
        return "players with narrower impact, inconsistent evidence, or support-dependent value where the current record does not justify average-tier confidence";
      case "E":
        return "the weakest evidence profiles, typically very limited, volatile, or repeatedly low-impact compared with the rest of the pool";
    }
  }

  private placementComponents(disabled = false) {
    const buttons = [
      new ButtonBuilder()
        .setCustomId(BUTTON_NEXT_PLAYER)
        .setLabel("Next player")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(BUTTON_PAUSE)
        .setLabel("Pause")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ];
    if (!this.manager.getState()?.noCommunityInput) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(BUTTON_REQUEST_RERATE)
          .setLabel("Request rerate")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      );
    }
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
  }

  private async requestRerate(interaction: ButtonInteraction) {
    const state = this.manager.getState();
    if (state?.noCommunityInput) {
      await interaction.reply({
        content: "Rerate requests are not available for this tier-list event.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!state?.activePlacementReview || interaction.user.bot) {
      await interaction.reply({
        content: "There is no active placement to review.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = this.manager.recordRerateVote(
      interaction.user.id,
      interaction.user.bot,
      this.tierConfig().rerateVoteThreshold
    );
    if (!result.accepted) {
      await interaction.reply({
        content: "That rerate vote could not be recorded.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`${MODAL_RERATE}:${state.activePlacementReview.placementId}`)
      .setTitle("Request rerate")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("justification")
            .setLabel("Concise reason")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(this.tierConfig().rerateJustificationMaxLength)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
  }

  private async rerateActivePlacement(interaction: ModalSubmitInteraction) {
    const state = this.manager.getState();
    const placement = this.manager.currentPlacement();
    if (!state?.activePlacementReview || !placement) return;

    const dossier = this.manager
      .getDossiers()
      .find((candidate) => candidate.playerId === placement.playerId);
    if (!dossier) return;

    const result = await this.reviewPlacedPlayer(dossier, placement);
    await this.refreshActivePlacementMessage(
      interaction,
      result.placement,
      "Ollama review"
    );
    await this.safePostTierListImageSnapshot(interaction);
    this.manager.completeActivePlacementReview();
    this.scheduleAutoAdvanceFromModal(interaction);
  }

  private async reviewPlacedPlayer(
    dossier: PlayerTierDossier,
    placement: TierPlacement,
    reason?: string
  ) {
    const state = this.manager.getState();
    if (!state) return { placement, changed: false };

    const manualNotes = [
      ...this.manager.manualNotesFor(dossier.playerId),
      ...(reason ? [`Rereview reason: ${reason}`] : []),
    ];
    const judged = await this.tierJudge.judge(
      buildPlacementPromptPayload(dossier, this.manager.getDossiers(), state, {
        manualNotes,
        rerateJustifications: this.manager.rerateJustificationsFor(
          dossier.playerId
        ),
      })
    );

    if (judged.source !== "ollama") {
      this.manager.setPlacementStatusNoteFor(
        dossier.playerId,
        "Review failed; keeping the existing placement."
      );
      return { placement, changed: false };
    }

    const reviewed = applyLimitedSampleGuardrail(
      dossier,
      {
        playerId: dossier.playerId,
        displayName: dossier.displayName,
        score: dossier.score,
        ...judged.placement,
        limitedSampleEvidence: placement.limitedSampleEvidence,
      },
      hasAcceptedLimitedSampleContext({
        manualNotes,
        rerateJustifications: this.manager.rerateJustificationsFor(
          dossier.playerId
        ),
      })
    );
    const changed =
      reviewed.tier !== placement.tier ||
      reviewed.position !== placement.position ||
      reviewed.confidence !== placement.confidence ||
      reviewed.reasoning !== placement.reasoning;

    if (changed) {
      this.manager.replacePlacement(reviewed);
      this.manager.setPlacementStatusNoteFor(
        dossier.playerId,
        reason
          ? "Reviewed after organiser re-review."
          : "Reviewed after community rerate."
      );
      return { placement: reviewed, changed };
    }

    this.manager.setPlacementStatusNoteFor(
      dossier.playerId,
      "Reviewed; no placement change."
    );
    return { placement, changed };
  }

  private async reviewFinalTierSegments(
    tier: TierListTier
  ): Promise<FinalReviewTierResult> {
    const state = this.manager.getState();
    if (!state) {
      return {
        applied: [],
        reviewedCount: 0,
        segments: [],
        failedSegments: [{ segment: "mid", reason: "no state" }],
        source: "fallback: no state",
      };
    }

    const segmentPlayerIds = Object.fromEntries(
      FINAL_REVIEW_SEGMENTS.map((segment) => [
        segment,
        state.placed[tier]
          .filter((placement) => placement.position === segment)
          .map((placement) => placement.playerId),
      ])
    ) as Record<TierPosition, string[]>;
    const reviewedCount = FINAL_REVIEW_SEGMENTS.reduce(
      (total, segment) => total + segmentPlayerIds[segment].length,
      0
    );
    const segmentPlayers = FINAL_REVIEW_SEGMENTS.flatMap((segment) =>
      segmentPlayerIds[segment].map((playerId) => ({ playerId, segment }))
    );
    const revisionsByPlayerId: Record<string, TierPosition> =
      Object.fromEntries(
        segmentPlayers.map((player) => [player.playerId, player.segment])
      );
    const completedSegments: TierPosition[] = [];
    const failedSegments: { segment: TierPosition; reason: string }[] = [];
    const collectedRevisions: TierListFinalReviewRevision[] = [];
    this.logDebug("final tier segment snapshot captured", {
      tier,
      high: segmentPlayerIds.high.length,
      mid: segmentPlayerIds.mid.length,
      low: segmentPlayerIds.low.length,
      reviewedCount,
    });

    for (const segment of FINAL_REVIEW_SEGMENTS) {
      const playerIds = segmentPlayerIds[segment];
      if (!playerIds.length) {
        this.logDebug("final segment skipped empty", { tier, segment });
        continue;
      }

      const payload = this.manager.buildFinalReviewSegmentPayload(
        tier,
        segment,
        playerIds
      );
      if (!payload) {
        this.logDebug("final segment failed before judge", {
          tier,
          segment,
          reason: "no payload",
        });
        failedSegments.push({ segment, reason: "no payload" });
        continue;
      }

      const startedAt = Date.now();
      this.logDebug("final segment judge call started", {
        tier,
        segment,
        players: payload.players.length,
        higherRefs: payload.adjacentReferences.higherTier?.length ?? 0,
        lowerRefs: payload.adjacentReferences.lowerTier?.length ?? 0,
        sameHigherRefs: payload.sameTierReferences?.higherSegment?.length ?? 0,
        sameLowerRefs: payload.sameTierReferences?.lowerSegment?.length ?? 0,
      });
      const judged = await this.tierJudge.reviewFinalTier(payload);
      if (judged.source !== "ollama") {
        this.logDebug("final segment judge call failed", {
          tier,
          segment,
          durationMs: Date.now() - startedAt,
          reason: judged.reason,
        });
        failedSegments.push({ segment, reason: judged.reason });
        continue;
      }

      completedSegments.push(segment);
      this.logDebug("final segment judge call completed", {
        tier,
        segment,
        durationMs: Date.now() - startedAt,
        revisions: judged.revisions.length,
      });
      for (const revision of judged.revisions) {
        const revisionSegment = revisionsByPlayerId[revision.playerId];
        if (revisionSegment === segment) {
          collectedRevisions.push(revision);
        } else {
          this.logDebug("final segment ignored out-of-segment revision", {
            tier,
            segment,
            playerId: revision.playerId,
          });
        }
      }
    }

    const applied: TierPlacement[] = [];
    for (const segment of FINAL_REVIEW_SEGMENTS) {
      const revisionsForSegment = collectedRevisions.filter(
        (revision) => revisionsByPlayerId[revision.playerId] === segment
      );
      if (!revisionsForSegment.length) continue;
      const segmentApplied = this.manager.applyFinalReviewSegmentRevisions(
        tier,
        segmentPlayerIds[segment],
        revisionsForSegment
      );
      applied.push(...segmentApplied);
    }

    this.manager.completeFinalReviewTier(tier);
    const source = failedSegments.length
      ? `Ollama final review; ${failedSegments.length} segment(s) failed`
      : completedSegments.length
        ? "Ollama final review"
        : "empty tier";
    return {
      applied,
      reviewedCount,
      segments: completedSegments,
      failedSegments,
      source,
    };
  }

  private async refreshActivePlacementMessage(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    placement: TierPlacement,
    source: string
  ) {
    const messageId = this.manager.getState()?.activePlacementReview?.messageId;
    if (!messageId || !interaction.channel?.isTextBased()) return;
    const channel = interaction.channel;
    if (!("messages" in channel)) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;
    await message.edit({
      embeds: [this.placementEmbed(placement, source)],
      components: this.placementComponents(),
    });
  }

  private scheduleAutoAdvance(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ) {
    const state = this.manager.getState();
    const config = this.tierConfig();
    if (
      !state ||
      state.paused ||
      !state.unplacedPlayerIds.length ||
      state.activePlacementReview?.thresholdReached ||
      config.autoAdvanceSeconds <= 0
    ) {
      this.logDebug("auto-advance not scheduled", {
        hasState: Boolean(state),
        paused: state?.paused ?? false,
        remaining: state?.unplacedPlayerIds.length ?? 0,
        thresholdReached:
          state?.activePlacementReview?.thresholdReached ?? false,
        autoAdvanceSeconds: config.autoAdvanceSeconds,
      });
      return;
    }

    this.logDebug("auto-advance scheduled", {
      autoAdvanceSeconds: config.autoAdvanceSeconds,
      remaining: state.unplacedPlayerIds.length,
    });
    const timer = setTimeout(async () => {
      const latest = this.manager.getState();
      if (
        !latest ||
        latest.paused ||
        !latest.unplacedPlayerIds.length ||
        latest.activePlacementReview?.thresholdReached
      ) {
        this.logDebug("auto-advance skipped at timer", {
          hasState: Boolean(latest),
          paused: latest?.paused ?? false,
          remaining: latest?.unplacedPlayerIds.length ?? 0,
          thresholdReached:
            latest?.activePlacementReview?.thresholdReached ?? false,
        });
        return;
      }
      this.logDebug("auto-advance timer fired", {
        remaining: latest.unplacedPlayerIds.length,
      });
      await this.disableActivePlacementControls(interaction);
      const dossier = this.manager.nextDossier();
      const processingMessage = dossier
        ? await this.sendProcessingEmbed(
            interaction,
            dossier.displayName,
            false
          )
        : undefined;
      const result =
        await this.placeNextWithJudgeFromAnyInteraction(interaction);
      if (!result || !("placement" in result)) return;
      await this.sendPlacementResult(
        interaction,
        result,
        false,
        processingMessage
      );
      await this.safePostTierListImageSnapshotOnCadence(interaction);
      await this.notifyProvisionalComplete(interaction);
      this.scheduleAutoAdvance(interaction);
    }, config.autoAdvanceSeconds * 1000);
    this.manager.setAutoAdvanceTimer(timer);
  }

  private scheduleAutoAdvanceFromModal(interaction: ModalSubmitInteraction) {
    const state = this.manager.getState();
    const config = this.tierConfig();
    if (
      !state ||
      state.paused ||
      !state.unplacedPlayerIds.length ||
      config.autoAdvanceSeconds <= 0
    ) {
      this.logDebug("modal auto-advance not scheduled", {
        hasState: Boolean(state),
        paused: state?.paused ?? false,
        remaining: state?.unplacedPlayerIds.length ?? 0,
        autoAdvanceSeconds: config.autoAdvanceSeconds,
      });
      return;
    }

    this.logDebug("modal auto-advance scheduled", {
      autoAdvanceSeconds: config.autoAdvanceSeconds,
      remaining: state.unplacedPlayerIds.length,
    });
    const timer = setTimeout(async () => {
      const latest = this.manager.getState();
      if (!latest || latest.paused || !latest.unplacedPlayerIds.length) {
        this.logDebug("modal auto-advance skipped at timer", {
          hasState: Boolean(latest),
          paused: latest?.paused ?? false,
          remaining: latest?.unplacedPlayerIds.length ?? 0,
        });
        return;
      }
      this.logDebug("modal auto-advance timer fired", {
        remaining: latest.unplacedPlayerIds.length,
      });
      const dossier = this.manager.nextDossier();
      const processingMessage = dossier
        ? await this.sendProcessingEmbed(
            interaction,
            dossier.displayName,
            false
          )
        : undefined;
      const result =
        await this.placeNextWithJudgeFromAnyInteraction(interaction);
      if (!result || !("placement" in result)) return;
      await this.sendPlacementResult(
        interaction,
        result,
        false,
        processingMessage
      );
      await this.safePostTierListImageSnapshotOnCadence(interaction);
      await this.notifyProvisionalComplete(interaction);
      this.scheduleAutoAdvanceFromModal(interaction);
    }, config.autoAdvanceSeconds * 1000);
    this.manager.setAutoAdvanceTimer(timer);
  }

  private async disableActivePlacementControls(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ) {
    const messageId = this.manager.getState()?.activePlacementReview?.messageId;
    if (!messageId || !interaction.channel?.isTextBased()) return;
    const channel = interaction.channel;
    if (!("messages" in channel)) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;
    await message.edit({ components: this.placementComponents(true) });
  }

  private buildTierListImageRows(
    options: { excludeLimitedSample?: boolean } = {}
  ) {
    const state = this.manager.getState();
    const rows = emptyTierListImageRows();
    if (!state) return rows;

    const dossiersByPlayerId = new Map(
      this.manager.getDossiers().map((dossier) => [dossier.playerId, dossier])
    );
    for (const tier of TIER_ORDER) {
      rows[tier] = state.placed[tier]
        .filter((placement) => {
          if (!options.excludeLimitedSample) return true;
          return !dossiersByPlayerId.get(placement.playerId)?.limitedSample;
        })
        .map((placement) => ({
          displayName: placement.displayName,
          headIdentifier: placement.displayName,
        }));
    }
    return rows;
  }

  private async renderTierListAttachments() {
    const state = this.manager.getState();
    const imageConfig = this.tierImageConfig();
    if (!state || !imageConfig.enabled) return [];

    const cache = this.headCacheForCurrentEvent();
    const rows = this.buildTierListImageRows();
    const pages = await renderTierListSnapshot(
      rows,
      imageConfig,
      cache.load.bind(cache)
    );
    return pages.slice(0, 10).map(
      (page, index) =>
        new AttachmentBuilder(page, {
          name:
            pages.length === 1
              ? `${state.eventId}-tier-list.png`
              : `${state.eventId}-tier-list-${index + 1}.png`,
        })
    );
  }

  private async safeRenderTierListAttachments() {
    try {
      return await this.renderTierListAttachments();
    } catch (error) {
      console.error("Failed to render tier-list attachment:", error);
      return [];
    }
  }

  private async collectCommunityNotes(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    dossier: PlayerTierDossier
  ) {
    const config = this.tierConfig();
    const state = this.manager.getState();
    if (state?.noCommunityInput) return null;
    if (!state || !config.enabledCommunityQuestions) return null;
    const forceLowSampleQuestion =
      dossier.limitedSample &&
      config.limitedSampleCommunityQuestionRequiredForB;
    if (!forceLowSampleQuestion && state.placementCount === 0) return null;
    if (
      !forceLowSampleQuestion &&
      state.placementCount % config.askEveryNPlayers !== 0
    ) {
      return null;
    }

    const channelId = this.resolveQuestionChannelId();
    const questionPromise = this.manager.beginQuestion(
      dossier,
      channelId,
      config.questionWindowSeconds * 1000,
      config.maxCommunityAnswers
    );
    const session = this.manager.getActiveQuestion();
    if (!session) return null;
    await this.sendQuestion(interaction, session.question, channelId);
    return questionPromise;
  }

  private async sendQuestion(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    question: string,
    channelId: string
  ) {
    const channel = await interaction.guild?.channels
      .fetch(channelId)
      .catch(() => null);
    const target = channel?.isTextBased()
      ? channel
      : interaction.channel?.isTextBased()
        ? interaction.channel
        : null;
    if (!target || !("send" in target)) {
      this.manager.finishQuestion(
        "discard",
        this.tierConfig().maxCommunityAnswers
      );
      return;
    }
    const sendable = target as { send: (options: unknown) => Promise<unknown> };
    await sendable.send({
      content: this.questionContent(question),
      components: this.questionComponents(),
    });
  }

  private questionContent(question: string, paused = false) {
    const windowLine = paused
      ? "Window: paused. Organisers should press Continue when discussion is done."
      : `Window: ${this.tierConfig().questionWindowSeconds}s. One useful answer per person.`;
    return ["**Tier-list community question**", question, windowLine].join(
      "\n"
    );
  }

  private questionComponents() {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(BUTTON_CONTINUE)
          .setLabel("Continue")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(BUTTON_DISCARD)
          .setLabel("Discard notes")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(BUTTON_REROLL)
          .setLabel("Reroll question")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(BUTTON_QUESTION_PAUSE)
          .setLabel("Pause timer")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(BUTTON_SKIP)
          .setLabel("Come back later")
          .setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(BUTTON_OLD_NAMES)
          .setLabel("Old names")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(BUTTON_EXTEND_TIME)
          .setLabel("Extend time")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  private async postOldNames(interaction: ButtonInteraction) {
    const session = this.manager.getActiveQuestion();
    if (!session || session.closed) {
      await interaction.reply({
        content: "No active tier-list question is running.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dossier =
      this.manager
        .getDossiers()
        .find((candidate) => candidate.playerId === session.playerId) ?? null;
    const fallbackName = dossier?.displayName ?? "this player";
    let player: {
      latestIGN?: string | null;
      minecraftAccounts?: string[];
    } | null = null;

    try {
      player = await prismaClient.player.findUnique({
        where: { id: session.playerId },
        select: { latestIGN: true, minecraftAccounts: true },
      });
    } catch (error) {
      void error;
    }

    const names = this.knownMinecraftNames(
      player?.latestIGN ?? null,
      player?.minecraftAccounts ?? [],
      fallbackName
    );
    await interaction.reply({
      embeds: [this.oldNamesEmbed(fallbackName, names)],
    });
  }

  private async extendQuestionTime(interaction: ButtonInteraction) {
    const result = this.manager.requestQuestionExtension(
      interaction.user.id,
      30_000,
      2,
      this.tierConfig().maxCommunityAnswers
    );

    if (result.status === "inactive") {
      await interaction.reply({
        content: "No active tier-list question is running.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.status === "already-extended") {
      await interaction.reply({
        content: "This question has already been extended.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.status === "recorded") {
      await interaction.reply({
        content: `Extension vote recorded (${result.votes}/${result.requiredVoters}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply("Question extended by 30s.");
  }

  private async updateLiveSummary(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ) {
    const state = this.manager.getState();
    if (!state || !interaction.channel?.isTextBased()) return;
    const content = ["**Live tier list**", this.currentStateText()].join("\n");
    try {
      if (state.liveSummaryMessageId && "messages" in interaction.channel) {
        const existing = await interaction.channel.messages
          .fetch(state.liveSummaryMessageId)
          .catch(() => null);
        if (existing) {
          await existing.edit(content.slice(0, 1900));
          return;
        }
      }
      const sendable = interaction.channel as {
        send: (content: string) => Promise<{ id: string }>;
      };
      const message = await sendable.send(content.slice(0, 1900));
      state.liveSummaryMessageId = message.id;
    } catch (error) {
      console.error("Failed to update live tier-list message:", error);
    }
  }

  private async postTierListImageSnapshot(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    completionContent?: string
  ) {
    const state = this.manager.getState();
    const imageConfig = this.tierImageConfig();
    if (!state || !imageConfig.enabled) return;

    try {
      const channelId = this.resolveTierImageChannelId();
      const channel = await interaction.guild?.channels
        .fetch(channelId)
        .catch(() => null);
      const target = channel?.isTextBased()
        ? channel
        : interaction.channel?.isTextBased()
          ? interaction.channel
          : null;
      if (!target || !("send" in target)) return;

      const cache = this.headCacheForCurrentEvent();
      const sendable = target as {
        send: (options: unknown) => Promise<{ id: string }>;
      };
      const postRows = async (
        rows: TierListImageRows,
        content: string | undefined,
        fileSuffix = "tier-list"
      ) => {
        const pages = await renderTierListSnapshot(
          rows,
          imageConfig,
          cache.load.bind(cache)
        );
        for (let i = 0; i < pages.length; i++) {
          const attachment = new AttachmentBuilder(pages[i], {
            name:
              pages.length === 1
                ? `${state.eventId}-${fileSuffix}.png`
                : `${state.eventId}-${fileSuffix}-${i + 1}.png`,
          });
          const message = await sendable.send({
            ...(i === 0 && content ? { content } : {}),
            files: [attachment],
          });
          state.postedImageMessageIds.push(message.id);
        }
      };

      const rows = this.buildTierListImageRows();
      await postRows(rows, completionContent);

      if (completionContent === FINAL_TIER_LIST_IMAGE_MESSAGE) {
        const filteredRows = this.buildTierListImageRows({
          excludeLimitedSample: true,
        });
        if (this.tierListRowsEqual(rows, filteredRows)) {
          const message = await sendable.send({
            content: UNCHANGED_FILTERED_FINAL_TIER_LIST_IMAGE_MESSAGE,
          });
          state.postedImageMessageIds.push(message.id);
          return;
        }
        await postRows(
          filteredRows,
          FILTERED_FINAL_TIER_LIST_IMAGE_MESSAGE,
          "tier-list-confidence-filtered"
        );
      }
    } catch (error) {
      console.error("Failed to post tier-list image snapshot:", error);
    }
  }

  private tierListRowsEqual(
    first: TierListImageRows,
    second: TierListImageRows
  ) {
    return TIER_ORDER.every((tier) => {
      const firstPlayers = first[tier];
      const secondPlayers = second[tier];
      return (
        firstPlayers.length === secondPlayers.length &&
        firstPlayers.every(
          (player, index) =>
            player.displayName === secondPlayers[index]?.displayName &&
            player.headIdentifier === secondPlayers[index]?.headIdentifier
        )
      );
    });
  }

  private async safePostTierListImageSnapshot(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction,
    completionContent?: string
  ) {
    try {
      await this.postTierListImageSnapshot(interaction, completionContent);
    } catch (error) {
      console.error("Failed to post tier-list image snapshot:", error);
    }
  }

  private async safePostTierListImageSnapshotOnCadence(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ) {
    const state = this.manager.getState();
    if (!state || state.fastMode) return;
    if (
      state.placementCount === 0 ||
      state.placementCount % PROVISIONAL_SNAPSHOT_CADENCE !== 0
    ) {
      return;
    }
    await this.safePostTierListImageSnapshot(interaction);
  }

  private async requireEvent(interaction: ChatInputCommandInteraction) {
    if (this.manager.getState()) return true;
    await interaction.reply({
      content: "No tier list event is running. Use `/tierlist start` first.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  private async notifyProvisionalComplete(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ) {
    const state = this.manager.getState();
    if (!state || state.phase !== "provisional") return;
    if (state.unplacedPlayerIds.length > 0) return;

    if (state.noCommunityInput) {
      await this.runVerdictOnlyFinalReview(interaction);
      return;
    }

    this.logDebug("provisional phase completed; waiting for final command", {
      placed: state.placementCount,
      tiers: this.tierCountDebugSummary(),
    });
    await this.sendInteractionPayload(
      interaction,
      {
        content:
          "Provisional placement is complete. Run `/tierlist final` to start the final segment review.",
      },
      false
    );
  }

  private async runVerdictOnlyFinalReview(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ) {
    const state = this.manager.getState();
    if (!state || state.phase !== "provisional") return;

    this.logDebug("verdict-only final review started", {
      placed: state.placementCount,
      tiers: this.tierCountDebugSummary(),
    });

    let currentTier = this.manager.startOrAdvanceFinalReview();
    while (currentTier) {
      const result = await this.reviewFinalTierSegments(currentTier);
      await this.sendInteractionPayload(
        interaction,
        {
          embeds: [this.finalReviewEmbed(currentTier, result)],
          components: [],
        },
        false
      );
      currentTier = this.manager.nextFinalReviewTier();
    }

    await this.safePostTierListImageSnapshot(
      interaction,
      FINAL_TIER_LIST_IMAGE_MESSAGE
    );
    await this.postFinalVerdict(interaction);
    this.logDebug("verdict-only final review completed", {
      placed: state.placementCount,
      finalReviewedTiers: state.finalReviewedTiers.join(",") || "none",
    });
  }

  private logDebug(message: string, data?: Record<string, unknown>) {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    console.info(`[TierList] ${message}${suffix}`);
  }

  private errorSummary(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error) {
      return String((error as { message?: unknown }).message);
    }
    return String(error);
  }

  private stateDebugSummary() {
    const state = this.manager.getState();
    if (!state) {
      return {
        hasState: false,
      };
    }
    return {
      hasState: true,
      eventId: state.eventId,
      phase: state.phase,
      unplaced: state.unplacedPlayerIds.length,
      placed: state.placementCount,
      nextFinalTier: this.manager.nextFinalReviewTier() ?? "complete",
      finalReviewTierIndex: state.finalReviewTierIndex,
      finalReviewedTiers: state.finalReviewedTiers.join(",") || "none",
      tiers: this.tierCountDebugSummary(),
    };
  }

  private tierDebugSummary(tier: TierListTier) {
    const state = this.manager.getState();
    if (!state) return { total: 0, high: 0, mid: 0, low: 0 };
    const placements = state.placed[tier];
    return {
      total: placements.length,
      high: placements.filter((placement) => placement.position === "high")
        .length,
      mid: placements.filter((placement) => placement.position === "mid")
        .length,
      low: placements.filter((placement) => placement.position === "low")
        .length,
    };
  }

  private tierCountDebugSummary() {
    const state = this.manager.getState();
    if (!state) return {};
    return Object.fromEntries(
      TIER_ORDER.map((tier) => [tier, state.placed[tier].length])
    );
  }

  private currentStateText() {
    const state = this.manager.getState();
    if (!state) return "No active event.";
    const lines = TIER_ORDER.map((tier) => {
      const names = state.placed[tier].map(
        (placement) =>
          `${this.displayName(placement.displayName)} (${placement.confidence})`
      );
      return `**${tier}**: ${names.length ? names.join(", ") : "-"}`;
    });
    lines.unshift(
      `Phase: ${state.phase}${
        state.phase === "final"
          ? ` (${this.manager.nextFinalReviewTier() ?? "complete"})`
          : ""
      }`
    );
    lines.push(`Unplaced: ${state.unplacedPlayerIds.length}`);
    lines.push(`Skipped: ${state.skippedPlayerIds.length}`);
    return lines.join("\n").slice(0, 1900);
  }

  private previewQueue() {
    const names = this.manager
      .getDossiers()
      .slice(0, 8)
      .map((dossier) => this.displayName(dossier.displayName));
    return names.length
      ? `Coming up: ${names.join(", ")}`
      : "No players found.";
  }

  private startEmbed(playerCount: number, playedRecentlyMonths: number | null) {
    const config = this.tierConfig();
    const state = this.manager.getState();
    const anchorCount = state?.anchorPlayerIds.length ?? 0;
    const embed = new EmbedBuilder()
      .setTitle("All-Season Tier List: Queue Locked")
      .setColor(0x2563eb)
      .setDescription(
        state?.phase === "anchor"
          ? "Anchor community voting will run first. Use `/tierlist next` after the anchor pre-phase completes."
          : "Use `/tierlist next` to begin live placements."
      )
      .addFields(
        { name: "Players", value: String(playerCount), inline: true },
        ...(anchorCount
          ? [
              {
                name: "Anchor polls",
                value: `${anchorCount} player(s), ${ANCHOR_MIN_GAMES}+ games, max ${ANCHOR_COUNT}`,
                inline: true,
              },
            ]
          : []),
        {
          name: "Auto-flow",
          value: config.autoAdvanceSeconds
            ? `${config.autoAdvanceSeconds}s after each placement`
            : "manual",
          inline: true,
        },
        {
          name: "Rerate threshold",
          value: `${config.rerateVoteThreshold} votes`,
          inline: true,
        },
        { name: "Queue preview", value: this.previewQueue() }
      );
    if (playedRecentlyMonths) {
      embed.addFields({
        name: "Recent filter",
        value: `last ${playedRecentlyMonths} months`,
        inline: true,
      });
    }
    return embed;
  }

  private fastModeProcessingEmbed(
    playerCount: number,
    playedRecentlyMonths: number | null
  ) {
    const embed = new EmbedBuilder()
      .setTitle("All-Season Tier List: Fast Mode")
      .setColor(0x2563eb)
      .setDescription(
        "Placing the selected queue and running final review immediately."
      )
      .addFields(
        { name: "Players", value: String(playerCount), inline: true },
        { name: "Community questions", value: "skipped", inline: true },
        { name: "Interim snapshots", value: "skipped", inline: true }
      );
    if (playedRecentlyMonths) {
      embed.addFields({
        name: "Recent filter",
        value: `last ${playedRecentlyMonths} months`,
        inline: true,
      });
    }
    return embed;
  }

  private fastModeCompleteEmbed(
    placements: PlacementResult[],
    reviewed: Array<{ tier: TierListTier; result: FinalReviewTierResult }>
  ) {
    const placed = placements.filter(
      (result): result is { placement: TierPlacement; source: string } =>
        "placement" in result
    );
    const skipped = placements.filter((result) => "skipped" in result).length;
    const reviewedCount = reviewed.reduce(
      (total, item) => total + item.result.reviewedCount,
      0
    );
    const changed = reviewed.reduce(
      (total, item) => total + item.result.applied.length,
      0
    );
    return new EmbedBuilder()
      .setTitle("All-Season Tier List: Fast Mode Complete")
      .setColor(0x16a34a)
      .setDescription("Final tier list review is complete.")
      .addFields(
        { name: "Placed", value: String(placed.length), inline: true },
        { name: "Skipped", value: String(skipped), inline: true },
        {
          name: "Final review",
          value: `${reviewedCount} placements reviewed, ${changed} revision(s) applied`,
          inline: false,
        },
        { name: "Snapshot", value: "Final PNG output posted.", inline: false }
      );
  }

  private async postFinalVerdict(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
  ) {
    const payload = this.manager.buildFinalVerdictPayload();
    if (!payload) return;

    const judged =
      typeof this.tierJudge.finalVerdict === "function"
        ? await this.tierJudge.finalVerdict(payload)
        : {
            source: "fallback" as const,
            reason: "Ollama final verdict is unavailable.",
          };
    const verdict =
      judged.source === "ollama"
        ? judged.verdict
        : this.fallbackFinalVerdict(judged.reason);
    await this.sendChannelPayload(interaction, {
      embeds: [
        this.finalVerdictEmbed(
          verdict,
          judged.source === "ollama" ? "Ollama final verdict" : judged.reason
        ),
      ],
      components: [],
    });
  }

  private fallbackFinalVerdict(reason: string): TierListFinalVerdict {
    const state = this.manager.getState();
    const dossiersByPlayerId = new Map(
      this.manager.getDossiers().map((dossier) => [dossier.playerId, dossier])
    );
    const verdict = {} as TierListFinalVerdict;

    for (const tier of TIER_ORDER) {
      const placements = state?.placed[tier] ?? [];
      const limited = placements.filter(
        (placement) => dossiersByPlayerId.get(placement.playerId)?.limitedSample
      ).length;
      const confidence = this.confidenceSummary(
        placements.map((placement) => placement.confidence)
      );
      const topEvidence = placements.slice(0, 3).map((placement) => {
        const dossier = dossiersByPlayerId.get(placement.playerId);
        const band = dossier?.statisticalBand ?? placement.tier;
        return `${placement.displayName} (${placement.position}, band ${band}, ${dossier?.gamesPlayed ?? 0} games)`;
      });
      verdict[tier] = [
        `${placements.length} player(s) landed in ${tier}.`,
        confidence ? `Confidence: ${confidence}.` : "Confidence: none.",
        limited
          ? `${limited} limited-sample player(s) need extra caution.`
          : "No limited-sample concentration.",
        topEvidence.length
          ? `Strongest evidence band/context: ${topEvidence.join("; ")}.`
          : "No placements in this tier.",
      ].join(" ");
    }

    const counts = TIER_ORDER.map(
      (tier) => `${tier}:${state?.placed[tier].length ?? 0}`
    ).join(" ");
    const limitedTotal = this.manager
      .getDossiers()
      .filter(
        (dossier) =>
          dossier.limitedSample &&
          TIER_ORDER.some((tier) =>
            state?.placed[tier].some(
              (placement) => placement.playerId === dossier.playerId
            )
          )
      ).length;
    verdict.overall = `Deterministic fallback used because ${reason}. Final shape is ${counts}. Limited-sample placements: ${limitedTotal}. The list should be read as strongest where confidence is high/medium and statistical bands agree with reviewed placements.`;
    return verdict;
  }

  private confidenceSummary(confidences: TierConfidence[]) {
    const counts = confidences.reduce(
      (summary, confidence) => {
        summary[confidence] += 1;
        return summary;
      },
      { high: 0, medium: 0, low: 0, provisional: 0 }
    );
    return (Object.keys(counts) as TierConfidence[])
      .filter((confidence) => counts[confidence] > 0)
      .map((confidence) => `${confidence} ${counts[confidence]}`)
      .join(", ");
  }

  private finalVerdictEmbed(verdict: TierListFinalVerdict, source: string) {
    return new EmbedBuilder()
      .setTitle("Final AI Verdict")
      .setColor(0x16a34a)
      .setDescription(this.displayText(verdict.overall).slice(0, 900))
      .addFields(
        ...TIER_ORDER.map((tier) => ({
          name: `${tier} tier`,
          value: this.displayText(verdict[tier]).slice(0, 900),
          inline: false,
        })),
        {
          name: "Source",
          value: this.displayText(source).slice(0, 900),
          inline: false,
        }
      );
  }

  private compactTierSnapshot() {
    const state = this.manager.getState();
    if (!state) return "-";
    return TIER_ORDER.map((tier) => {
      const names = state.placed[tier]
        .slice(0, 5)
        .map((placement) => this.displayName(placement.displayName));
      const suffix =
        state.placed[tier].length > names.length
          ? ` +${state.placed[tier].length - names.length}`
          : "";
      return `**${tier}**: ${names.length ? `${names.join(", ")}${suffix}` : "-"}`;
    }).join("\n");
  }

  private tierColor(tier: string) {
    switch (tier) {
      case "S":
        return 0xef4444;
      case "A":
        return 0xf97316;
      case "B":
        return 0xeab308;
      case "C":
        return 0x22c55e;
      case "D":
        return 0x06b6d4;
      default:
        return 0x64748b;
    }
  }

  private displayName(name: string) {
    return escapeText(this.stripExistingDiscordEscapes(name));
  }

  private displayText(text: string) {
    return escapeText(this.stripExistingDiscordEscapes(text));
  }

  private stripExistingDiscordEscapes(text: string) {
    return text.replace(/\\+([_*|~`>])/g, "$1").replace(/\\\\+/g, "\\");
  }

  private knownMinecraftNames(
    latestIGN: string | null,
    minecraftAccounts: string[],
    fallbackName: string
  ) {
    const currentName = latestIGN?.trim() || fallbackName;
    const primaryName = minecraftAccounts.find((name) => !!name.trim()) ?? null;
    const ordered = [
      currentName,
      primaryName && primaryName.toLowerCase() !== currentName.toLowerCase()
        ? primaryName
        : null,
      ...minecraftAccounts,
    ].filter((name): name is string => !!name?.trim());
    const unique: KnownNameEntry[] = [];
    const seen = new Set<string>();
    for (const name of ordered) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({
        name,
        current: key === currentName.toLowerCase(),
        primary:
          !!primaryName &&
          key === primaryName.toLowerCase() &&
          key !== currentName.toLowerCase(),
      });
    }
    return unique.length
      ? unique
      : [{ name: fallbackName, current: true, primary: false }];
  }

  private oldNamesEmbed(fallbackName: string, names: KnownNameEntry[]) {
    const lines = names.map((name, index) => {
      const labels: string[] = [];
      if (name.current) labels.push("current");
      if (name.primary) labels.push("primary");
      const suffix = labels.length ? ` (${labels.join(", ")})` : "";
      return `${index + 1}. ${this.displayName(name.name)}${suffix}`;
    });

    return new EmbedBuilder()
      .setTitle(`Known names for ${this.displayName(fallbackName)}`)
      .setDescription(lines.join("\n"))
      .setThumbnail(this.tierListHeadUrl(names[0]?.name ?? fallbackName, 64))
      .setColor(0x64748b);
  }

  private tierListHeadUrl(identifier: string, size: number) {
    return this.tierImageConfig()
      .headUrlTemplate.replace("{identifier}", encodeURIComponent(identifier))
      .replace("{size}", String(size));
  }

  private formatDossier(dossier: PlayerTierDossier) {
    const profile =
      dossier.profile &&
      [
        ...dossier.profile.preferredRoles,
        ...dossier.profile.proficientAtRoles,
        ...dossier.profile.playstyles,
      ].length
        ? `\nProfile context: ${[
            ...dossier.profile.preferredRoles,
            ...dossier.profile.proficientAtRoles,
            ...dossier.profile.playstyles,
          ].join(", ")}`
        : "";
    const notes = this.manager.manualNotesFor(dossier.playerId);
    const noteText = notes.length
      ? `\nSubjective organiser notes: ${notes.join(" | ")}`
      : "";

    return [
      `**${this.displayName(dossier.displayName)}** - statistical band **${dossier.statisticalBand}** (${dossier.provisional ? "provisional" : `${dossier.gamesPlayed} games`})`,
      dossier.limitedSample
        ? `Limited sample: fewer than ${this.tierConfig().limitedSampleGamesThreshold} all-season games; automatic placement is C/D unless accepted context supports B.`
        : "",
      this.displayText(dossier.objectiveSummary),
      `Strengths: ${this.displayText(dossier.notableStrengths.join(" "))}`,
      `Risks: ${this.displayText(dossier.riskNotes.join(" "))}`,
      `Confidence: ${this.displayText(dossier.confidenceNotes.join(" "))}`,
      profile,
      noteText,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1900);
  }

  private formatPlacementResults(results: PlacementResult[]) {
    return results
      .map((result) => {
        if ("skipped" in result) {
          return `Skipped **${this.displayName(result.skipped)}** and moved them to the end of the queue.`;
        }
        const { placement, source } = result;
        return [
          `**${this.displayName(placement.displayName)}** -> **${placement.position} ${placement.tier}** (${placement.confidence}, ${source})`,
          this.displayText(placement.reasoning),
        ].join("\n");
      })
      .join("\n\n");
  }

  private async sendDeferredBlocks(
    interaction: ChatInputCommandInteraction,
    blocks: string[]
  ) {
    const chunks = splitDiscordText(blocks.join("\n\n"));
    await interaction.editReply(chunks.shift() ?? "Done.");
    for (const chunk of chunks) {
      await interaction.followUp(chunk);
    }
  }

  private truncateCodeBlock(content: string) {
    const max = 1850;
    const truncated =
      content.length > max ? `${content.slice(0, max - 3)}...` : content;
    return ["```json", truncated, "```"].join("\n");
  }

  private tierConfig() {
    const config = {
      ...DEFAULT_TIER_LIST_CONFIG,
      ...ConfigManager.getConfig().tierList,
      image: {
        ...DEFAULT_TIER_LIST_CONFIG.image,
        ...ConfigManager.getConfig().tierList?.image,
      },
    };
    return {
      questionChannel: config.questionChannel,
      questionWindowSeconds: config.questionWindowSeconds,
      maxCommunityAnswers: config.maxCommunityAnswersPerPlayer,
      askEveryNPlayers: Math.max(1, config.askCommunityEveryNPlayers),
      consistencyEveryNPlacements: config.consistencyEveryNPlacements,
      enabledCommunityQuestions: config.enabledCommunityQuestions,
      autoAdvanceSeconds: config.autoAdvanceSeconds,
      rerateVoteThreshold: config.rerateVoteThreshold,
      rerateJustificationMaxLength: config.rerateJustificationMaxLength,
      playedRecentlyDefault: config.playedRecentlyDefault,
      playedRecentlyMonths: config.playedRecentlyMonths,
      limitedSampleGamesThreshold: config.limitedSampleGamesThreshold,
      limitedSampleCommunityQuestionRequiredForB:
        config.limitedSampleCommunityQuestionRequiredForB,
    };
  }

  private tierImageConfig() {
    return {
      ...DEFAULT_TIER_LIST_CONFIG.image,
      ...ConfigManager.getConfig().tierList?.image,
    };
  }

  private resolveQuestionChannelId() {
    const config = ConfigManager.getConfig();
    const keyOrId = this.tierConfig().questionChannel;
    return config.channels[keyOrId as keyof typeof config.channels] ?? keyOrId;
  }

  private resolveTierImageChannelId() {
    const config = ConfigManager.getConfig();
    const keyOrId = this.tierImageConfig().postChannel;
    return config.channels[keyOrId as keyof typeof config.channels] ?? keyOrId;
  }

  private headCacheForCurrentEvent() {
    const state = this.manager.getState();
    const eventId = state?.eventId ?? "no-event";
    if (this.imageHeadCache?.eventId === eventId) {
      return this.imageHeadCache.cache;
    }
    const cache = new TierListHeadCache(this.tierImageConfig().headUrlTemplate);
    this.imageHeadCache = { eventId, cache };
    return cache;
  }

  private isOrganiserButton(interaction: ButtonInteraction) {
    if (!interaction.guild) return false;
    const member = interaction.member as GuildMember | null;
    return PermissionsUtil.hasRole(member ?? undefined, "organiserRole");
  }

  private async loadDossiers() {
    return loadAllSeasonTierDossiers();
  }
}

function splitDiscordText(content: string) {
  const max = 1900;
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > max) {
    const breakAt = Math.max(
      remaining.lastIndexOf("\n\n", max),
      remaining.lastIndexOf("\n", max)
    );
    const index = breakAt > 100 ? breakAt : max;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function monthsAgo(months: number) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Math.max(0, months));
  return cutoff;
}

function shuffledCopy<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}
