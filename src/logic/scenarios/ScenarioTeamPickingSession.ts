import { Team } from "@prisma/client";
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  ChatInputCommandInteraction, EmbedBuilder, Message, MessageFlags,
} from "discord.js";
import { GameInstance } from "../../database/GameInstance";
import { PlayerInstance } from "../../database/PlayerInstance";
import { Channels } from "../../Channels";
import { escapeIgn } from "../../util/Utils";
import { EloUtil } from "../../util/EloUtil";
import { withObsoleteMessageGuard } from "../../util/DiscordFailures";
import { TeamPickingSession, TeamPickingSessionState } from "../teams/TeamPickingSession";
import { ScenarioTeamProposal } from "./ScenarioTypes";

/** A scenario proposal is a preview; only TeamCommand's roster lock may commit it. */
export class ScenarioTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";
  private readonly game = GameInstance.getInstance();
  private readonly token = this.game.getLifecycleToken();
  private readonly id = this.game.scenarios.selectedId;
  private readonly ids: Record<Team | "UNDECIDED", string[]>;
  private readonly captains: { red?: string; blue?: string };
  private readonly method: ScenarioTeamProposal["method"];
  embedMessage?: Message<boolean>;

  constructor(proposal: ScenarioTeamProposal) {
    super();
    if (!this.id || this.game.scenarios.phase !== "ready")
      throw new Error("Scenario must have a ready, reviewed result before proposing teams.");
    this.ids = { RED: [...proposal.red], BLUE: [...proposal.blue], UNDECIDED: [...proposal.undecided] };
    this.captains = { ...proposal.captains };
    this.method = proposal.method;
    this.validate();
  }

  private validate(): Record<Team | "UNDECIDED", PlayerInstance[]> {
    if (this.token !== this.game.getLifecycleToken() ||
        this.game.scenarios.selectedId !== this.id ||
        this.game.scenarios.phase !== "ready" ||
        !this.game.announced || this.game.isFinished ||
        this.game.getGameStartStatus() !== "idle" || this.game.teamsDecidedBy)
      throw new Error("Scenario or match changed; teams cannot be finalised.");

    this.game.scenarios.assertCapturedRosters();
    const roster = new Map(this.game.getPlayers().map((p) => [p.discordSnowflake, p]));
    const combined = [...this.ids.RED, ...this.ids.BLUE, ...this.ids.UNDECIDED];
    if (combined.length !== roster.size || new Set(combined).size !== combined.length ||
        combined.some((id) => !roster.has(id)) || !this.ids.RED.length || !this.ids.BLUE.length ||
        Math.abs(this.ids.RED.length - this.ids.BLUE.length) > 1)
      throw new Error("Proposed teams must cover each current registered participant once, with balanced RED/BLUE counts.");

    const currentCaptains = {
      red: this.game.getCaptainOfTeam("RED")?.discordSnowflake,
      blue: this.game.getCaptainOfTeam("BLUE")?.discordSnowflake,
    };
    const redCaptain = this.captains.red ?? currentCaptains.red;
    const blueCaptain = this.captains.blue ?? currentCaptains.blue;
    if (redCaptain && !this.ids.RED.includes(redCaptain) ||
        blueCaptain && !this.ids.BLUE.includes(blueCaptain) ||
        redCaptain && blueCaptain && redCaptain === blueCaptain)
      throw new Error("Each existing or proposed captain must be on their own side.");

    return {
      RED: this.ids.RED.map((id) => roster.get(id)!),
      BLUE: this.ids.BLUE.map((id) => roster.get(id)!),
      UNDECIDED: this.ids.UNDECIDED.map((id) => roster.get(id)!),
    };
  }

  private embed(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const teams = this.validate();
    const text = (players: PlayerInstance[]) =>
      players.map((p) => escapeIgn(p.ignUsed ?? p.discordSnowflake)).join("\n").slice(0, 1024) || "None";
    const embed = new EmbedBuilder()
      .setTitle(`Scenario team preview - ${this.game.scenarios.definition?.name ?? "Scenario"}`)
      .setDescription("Organiser confirmation required. No game teams or roles change until accepted.")
      .addFields(
        { name: `🔴 RED (${teams.RED.length})`, value: text(teams.RED), inline: true },
        { name: `🔵 BLUE (${teams.BLUE.length})`, value: text(teams.BLUE), inline: true },
        { name: "Unassigned", value: text(teams.UNDECIDED) },
        { name: "Mean Elo", value: `RED ${EloUtil.calculateMeanElo(teams.RED).toFixed(1)} · BLUE ${EloUtil.calculateMeanElo(teams.BLUE).toFixed(1)}` }
      );
    const detail = this.game.scenarios.definition?.implementation?.organiserSummary?.(this.game);
    if (detail) embed.addFields({ name: "Scenario analysis", value: detail.slice(0, 1024) });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("scenario-team-accept").setLabel("Confirm Teams").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("scenario-team-cancel").setLabel("Cancel Preview").setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [row] };
  }

  async publishPreview(): Promise<void> {
    const channel = Channels.teamPicking;
    if (!channel?.isSendable()) throw new Error("Team-picking channel is unavailable.");
    this.embedMessage = await channel.send(this.embed()) as Message<boolean>;
  }

  async initialize(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.publishPreview();
    await interaction.editReply("Scenario team proposal posted for organiser confirmation.");
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    if (this.state !== "inProgress") return;
    if (interaction.customId === "scenario-team-cancel") {
      await interaction.update({ components: [] });
      await this.cancelSession();
      return;
    }
    if (interaction.customId !== "scenario-team-accept") return;
    let teams: ReturnType<typeof this.validate>;
    try { teams = this.validate(); }
    catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : "The preview is stale.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Discord must accept the confirmation before authoritative mutation.
    await interaction.update({ components: [] });
    const redCaptainId = this.captains.red ?? this.game.getCaptainOfTeam("RED")?.discordSnowflake;
    const blueCaptainId = this.captains.blue ?? this.game.getCaptainOfTeam("BLUE")?.discordSnowflake;
    this.game.teams = teams;
    for (const p of this.game.getPlayers())
      p.captain = p.discordSnowflake === redCaptainId || p.discordSnowflake === blueCaptainId;
    this.game.changeHowTeamsDecided(this.method);
    this.game.scenarios.complete();
    this.state = "finalized";
  }

  async handleMessage(_message: Message<boolean>): Promise<void> {}
  getState(): TeamPickingSessionState { return this.state; }
  async handleUnregister(_id: string): Promise<void> {
    if (this.state !== "inProgress") return;
    this.game.scenarios.needsReview("Registration changed after team preview. Rebuild the scenario result.");
    await this.cancelSession();
  }
  async cancelSession(): Promise<void> {
    if (this.state === "finalized") return;
    this.state = "cancelled";
    if (this.game.getLifecycleToken() === this.token && this.game.scenarios.selectedId === this.id)
      this.game.scenarios.needsReview("Scenario team preview cancelled; organiser must review or rebuild the result.");
    if (this.embedMessage) {
      await withObsoleteMessageGuard("edit", this.embedMessage, () =>
        this.embedMessage!.edit({ components: [] })
      );
    }
  }
}
