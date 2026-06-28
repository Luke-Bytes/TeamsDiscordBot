import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  GuildMember,
  Message,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { ConfigManager, DEFAULT_TIER_LIST_CONFIG } from "../ConfigManager";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import {
  buildFallbackPlacement,
  buildPlacementPromptPayload,
  loadAllSeasonTierDossiers,
  suggestConsistencyMoves,
} from "../logic/tierList/AllSeasonTierList";
import { OllamaTierJudge } from "../logic/tierList/OllamaTierJudge";
import { TierListEventManager } from "../logic/tierList/TierListEventManager";
import {
  emptyTierListImageRows,
  renderTierListSnapshot,
  TierListHeadCache,
} from "../logic/tierList/TierListImageRenderer";
import {
  PlayerTierDossier,
  TierPlacement,
  TIER_ORDER,
} from "../logic/tierList/types";

const BUTTON_CONTINUE = "tierlist:continue";
const BUTTON_DISCARD = "tierlist:discard";
const BUTTON_REROLL = "tierlist:reroll";
const BUTTON_SKIP = "tierlist:skip-active";
const BUTTON_APPLY_CONSISTENCY = "tierlist:apply-consistency";

type PlacementResult =
  | { placement: TierPlacement; source: string }
  | { skipped: string };

export default class TierListCommand implements Command {
  public name = "tierlist";
  public description = "Run an all-season evidence-assisted tier list event.";
  public buttonIds: string[] = [
    BUTTON_CONTINUE,
    BUTTON_DISCARD,
    BUTTON_REROLL,
    BUTTON_SKIP,
    BUTTON_APPLY_CONSISTENCY,
  ];
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
          .setDescription("Build dossiers and start a fresh tier list event")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("Limit players for a shorter event")
              .setMinValue(1)
              .setMaxValue(200)
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
          .setName("dossier")
          .setDescription("Preview a player's all-season dossier")
          .addStringOption((option) =>
            option
              .setName("player")
              .setDescription("Player IGN/name")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("prompt")
          .setDescription(
            "Preview the LLM placement payload for the next player"
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("consistency")
          .setDescription("Run a bounded consistency check")
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
          .setName("llm-status")
          .setDescription("Check configured Ollama reachability and model")
      )
      .addSubcommandGroup((group) =>
        group
          .setName("note")
          .setDescription("Manage subjective organiser notes")
          .addSubcommand((subcommand) =>
            subcommand
              .setName("add")
              .setDescription("Add a subjective organiser note")
              .addStringOption((option) =>
                option
                  .setName("player")
                  .setDescription("Player IGN/name")
                  .setRequired(true)
              )
              .addStringOption((option) =>
                option
                  .setName("note")
                  .setDescription("Subjective context for the LLM")
                  .setMaxLength(500)
                  .setRequired(true)
              )
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("clear")
              .setDescription("Clear subjective organiser notes")
              .addStringOption((option) =>
                option
                  .setName("player")
                  .setDescription("Player IGN/name")
                  .setRequired(true)
              )
          )
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
    if (!this.isOrganiserButton(interaction)) {
      await interaction.reply({
        content: "Only organisers can control tier-list questions.",
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
        content: this.questionContent(question),
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

    const action =
      interaction.customId === BUTTON_DISCARD
        ? "discard"
        : interaction.customId === BUTTON_SKIP
          ? "skip"
          : "continue";
    this.manager.finishQuestion(action, this.tierConfig().maxCommunityAnswers);
    await interaction.deferUpdate();
  }

  handleMessage(message: Message) {
    return this.manager.handleMessage(message);
  }

  private async start(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const limit = interaction.options.getInteger("limit");
    const dossiers = await loadAllSeasonTierDossiers();
    const selected = limit ? dossiers.slice(0, limit) : dossiers;
    this.manager.start(selected);
    this.imageHeadCache = undefined;

    await interaction.editReply({
      content: [
        `Started all-season tier list event with ${selected.length} player dossiers.`,
        "Use `/tierlist next` to place players gradually.",
        this.previewQueue(),
      ].join("\n\n"),
    });
  }

  private async next(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;

    await interaction.deferReply();
    const count = interaction.options.getInteger("count") ?? 1;
    const results: PlacementResult[] = [];
    for (let i = 0; i < count; i++) {
      const result = await this.placeNextWithJudge(interaction);
      if (!result) break;
      results.push(result);
      if ("placement" in result) {
        await this.safePostTierListImageSnapshot(interaction);
      }
    }

    if (!results.length) {
      await interaction.editReply("No unplaced players remain.");
      return;
    }

    await this.updateLiveSummary(interaction);
    await this.sendDeferredBlocks(interaction, [
      this.formatPlacementResults(results),
      this.currentStateText(),
    ]);
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
      `Undid ${placement.displayName}; they are back at the front of the queue.`
    );
  }

  private async skip(interaction: ChatInputCommandInteraction) {
    const ready = await this.requireEvent(interaction);
    if (!ready) return;
    const skipped = this.manager.skipNext();
    await interaction.reply(
      skipped
        ? `Skipped ${skipped.displayName}; moved to the end of the queue.`
        : "No unplaced players remain."
    );
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
        content: `Added subjective organiser note for ${dossier.displayName}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.manager.clearManualNotes(dossier.playerId);
    await interaction.reply({
      content: `Cleared subjective organiser notes for ${dossier.displayName}.`,
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
      const placement: TierPlacement = {
        playerId: dossier.playerId,
        displayName: dossier.displayName,
        score: dossier.score,
        ...judged.placement,
      };
      this.manager.commitPlacement(placement);
      return { placement, source: "Ollama" };
    }

    const placement = buildFallbackPlacement(dossier);
    this.manager.commitPlacement(placement);
    return { placement, source: `fallback: ${judged.reason}` };
  }

  private async collectCommunityNotes(
    interaction: ChatInputCommandInteraction,
    dossier: PlayerTierDossier
  ) {
    const config = this.tierConfig();
    const state = this.manager.getState();
    if (!state || !config.enabledCommunityQuestions) return null;
    if (state.placementCount % config.askEveryNPlayers !== 0) return null;

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
    interaction: ChatInputCommandInteraction,
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

  private questionContent(question: string) {
    return [
      "**Tier-list community question**",
      question,
      `Window: ${this.tierConfig().questionWindowSeconds}s. One useful answer per person.`,
    ].join("\n");
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
          .setCustomId(BUTTON_SKIP)
          .setLabel("Skip player")
          .setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  private async updateLiveSummary(interaction: ChatInputCommandInteraction) {
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
    interaction: ChatInputCommandInteraction | ButtonInteraction
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
      const rows = emptyTierListImageRows();
      for (const tier of TIER_ORDER) {
        rows[tier] = state.placed[tier].map((placement) => ({
          displayName: placement.displayName,
          headIdentifier: placement.displayName,
        }));
      }

      const pages = await renderTierListSnapshot(
        rows,
        imageConfig,
        cache.load.bind(cache)
      );
      const sendable = target as {
        send: (options: unknown) => Promise<{ id: string }>;
      };
      for (let i = 0; i < pages.length; i++) {
        const attachment = new AttachmentBuilder(pages[i], {
          name:
            pages.length === 1
              ? `${state.eventId}-tier-list.png`
              : `${state.eventId}-tier-list-${i + 1}.png`,
        });
        const message = await sendable.send({
          content:
            pages.length === 1
              ? `Tier-list snapshot after ${state.placementCount} placement(s).`
              : `Tier-list snapshot after ${state.placementCount} placement(s), page ${i + 1}/${pages.length}.`,
          files: [attachment],
        });
        state.postedImageMessageIds.push(message.id);
      }
    } catch (error) {
      console.error("Failed to post tier-list image snapshot:", error);
    }
  }

  private async safePostTierListImageSnapshot(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ) {
    try {
      await this.postTierListImageSnapshot(interaction);
    } catch (error) {
      console.error("Failed to post tier-list image snapshot:", error);
    }
  }

  private async requireEvent(interaction: ChatInputCommandInteraction) {
    if (this.manager.getState()) return true;
    await interaction.reply({
      content: "No tier list event is running. Use `/tierlist start` first.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  private currentStateText() {
    const state = this.manager.getState();
    if (!state) return "No active event.";
    const lines = TIER_ORDER.map((tier) => {
      const names = state.placed[tier].map(
        (placement) => `${placement.displayName} (${placement.confidence})`
      );
      return `**${tier}**: ${names.length ? names.join(", ") : "-"}`;
    });
    lines.push(`Unplaced: ${state.unplacedPlayerIds.length}`);
    lines.push(`Skipped: ${state.skippedPlayerIds.length}`);
    return lines.join("\n").slice(0, 1900);
  }

  private previewQueue() {
    const names = this.manager
      .getDossiers()
      .slice(0, 8)
      .map((dossier) => `${dossier.displayName} (${dossier.statisticalBand})`);
    return names.length
      ? `Queue preview: ${names.join(", ")}`
      : "No players found.";
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
      `**${dossier.displayName}** - statistical band **${dossier.statisticalBand}** (${dossier.provisional ? "provisional" : `${dossier.gamesPlayed} games`})`,
      dossier.objectiveSummary,
      `Strengths: ${dossier.notableStrengths.join(" ")}`,
      `Risks: ${dossier.riskNotes.join(" ")}`,
      `Confidence: ${dossier.confidenceNotes.join(" ")}`,
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
          return `Skipped **${result.skipped}** and moved them to the end of the queue.`;
        }
        const { placement, source } = result;
        return [
          `**${placement.displayName}** -> **${placement.position} ${placement.tier}** (${placement.confidence}, ${source})`,
          placement.reasoning,
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
