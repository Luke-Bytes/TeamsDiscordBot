import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  ChatInputCommandInteraction, EmbedBuilder, Message, MessageFlags,
  StringSelectMenuBuilder, StringSelectMenuInteraction,
} from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import { GameInstance as Game } from "../../../database/GameInstance";
import { Channels } from "../../../Channels";
import { escapeIgn } from "../../../util/Utils";
import TeamCommand from "../../../commands/TeamCommand";
import { TeamPickingSession, TeamPickingSessionState } from "../../teams/TeamPickingSession";
import type { ScenarioValue } from "../ScenarioTypes";
import { maskedCards, rouletteOffer, snakeTurn, DraftTeam } from "./ScenarioDraftRules";

export type ScenarioDraftMode = "masked" | "roulette";
export interface ScenarioDraftProgress {
  mode: ScenarioDraftMode;
  first: DraftTeam;
  redCaptain: string;
  blueCaptain: string;
  red: string[];
  blue: string[];
  remaining: string[];
  cards: Record<string, string>;
  hand: string[];
  pickIndex: number;
  rerolls: Record<DraftTeam, boolean>;
  deadline: string;
  finished: boolean;
}

type Control = ButtonInteraction | StringSelectMenuInteraction;
const other = (side: DraftTeam): DraftTeam => side === "RED" ? "BLUE" : "RED";

export class ScenarioDraftSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";
  readonly game: GameInstance = Game.getInstance();
  readonly token = this.game.getLifecycleToken();
  embedMessage?: Message<boolean>;
  finalizeMessage?: Message<boolean>;
  private turnMessage?: Message<boolean>;
  private timeout?: NodeJS.Timeout;
  private page = 0;
  private progress?: ScenarioDraftProgress;

  constructor(readonly mode: ScenarioDraftMode) { super(); }
  getState() { return this.state; }
  private save(): void {
    if (!this.progress) throw new Error("Draft has not started.");
    this.game.scenarios.setData("draft", this.progress as unknown as ScenarioValue);
  }
  private requireProgress(): ScenarioDraftProgress {
    if (!this.progress) throw new Error("Draft is unavailable.");
    if (this.game.getLifecycleToken() !== this.token || this.game.scenarios.phase !== "collecting" ||
        this.game.scenarios.selectedId !== (this.mode === "masked" ? "masked-draft" : "draft-roulette") ||
        this.state !== "inProgress" || this.game.getGameStartStatus() !== "idle" ||
        this.game.teamsDecidedBy)
      throw new Error("Draft no longer belongs to this match.");
    this.game.scenarios.assertCapturedRoster("draft");
    if (this.game.getCaptainOfTeam("RED")?.discordSnowflake !== this.progress.redCaptain ||
        this.game.getCaptainOfTeam("BLUE")?.discordSnowflake !== this.progress.blueCaptain)
      throw new Error("Captain assignment changed; an organiser must review the draft.");
    return this.progress;
  }
  private name(id: string): string {
    if (this.mode === "masked") {
      if (id === this.progress?.redCaptain || id === this.progress?.blueCaptain) {
        const p = this.game.getPlayers().find((player) => player.discordSnowflake === id);
        return escapeIgn(p?.ignUsed ?? "Captain");
      }
      const card = Object.entries(this.requireProgress().cards).find(([, player]) => player === id)?.[0];
      if (!card) throw new Error("Anonymous draft mapping is missing.");
      return card;
    }
    const player = this.game.getPlayers().find((p) => p.discordSnowflake === id);
    return escapeIgn(player?.ignUsed ?? player?.latestIGN ?? "Unavailable");
  }
  private cardLabel(id: string): string {
    const card = this.name(id);
    if (this.mode === "roulette") return card;
    const player = this.game.getPlayers().find((p) => p.discordSnowflake === id);
    const band = Math.floor((player?.elo ?? 1000) / 300) * 300;
    const count = this.game.getPlayersOfTeam("UNDECIDED").filter((p) =>
      Math.floor((p.elo ?? 1000) / 300) * 300 === band).length;
    // Hide unique and two-player bands; a hint must never reveal a unique identity.
    return count >= 3 ? `${card} — Elo band ${band}-${band + 299}` : `${card} — Mystery card`;
  }
  private summaryEmbed(finished = false) {
    const progress = this.requireProgress();
    const labels = (ids: string[]) => ids.map((id) => this.name(id)).join("\n").slice(0, 1024) || "None";
    return new EmbedBuilder()
      .setTitle(this.mode === "masked" ? "🎭 The Masked Draft" : "🎲 Draft Roulette")
      .setDescription(finished ? "All selections made. Organiser confirmation required before team roles change." :
        "Snake draft. Only the active captain may select. A timed-out pick comes from the displayed offer.")
      .addFields(
        { name: `🔴 RED (${progress.red.length + 1})`, value: labels([progress.redCaptain, ...progress.red]), inline: true },
        { name: `🔵 BLUE (${progress.blue.length + 1})`, value: labels([progress.blueCaptain, ...progress.blue]), inline: true },
        { name: `Unpicked (${progress.remaining.length})`, value: labels(progress.remaining), inline: false },
        { name: "Rerolls", value: this.mode === "roulette"
          ? `RED ${progress.rerolls.RED ? "used" : "1"} · BLUE ${progress.rerolls.BLUE ? "used" : "1"}`
          : "Not available" },
      );
  }
  private turnControls() {
    const progress = this.requireProgress();
    const owner = snakeTurn(progress.pickIndex, progress.first);
    const code = `fwscdraft:${this.token}:${progress.pickIndex}`;
    const offered = this.mode === "roulette" ? progress.hand : progress.remaining;
    const start = this.page * 23;
    const page = offered.slice(start, start + 23);
    const menu = new StringSelectMenuBuilder().setCustomId(`${code}:pick`)
      .setPlaceholder(`${owner} captain: choose a ${this.mode === "masked" ? "card" : "player"}`)
      .addOptions(page.map((id) => ({
        label: this.cardLabel(id).slice(0, 100),
        value: this.mode === "masked" ? this.name(id) : id,
      })));
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    if (start > 0) buttons.addComponents(
      new ButtonBuilder().setCustomId(`${code}:prev`).setLabel("Previous cards").setStyle(ButtonStyle.Secondary));
    if (start + 23 < offered.length) buttons.addComponents(
      new ButtonBuilder().setCustomId(`${code}:next`).setLabel("More cards").setStyle(ButtonStyle.Secondary));
    if (this.mode === "roulette" && !progress.rerolls[owner] && progress.remaining.length > progress.hand.length)
      buttons.addComponents(new ButtonBuilder().setCustomId(`${code}:reroll`)
        .setLabel("Use one reroll").setStyle(ButtonStyle.Primary));
    const deadline = Math.floor(Date.parse(progress.deadline) / 1000);
    return {
      content: `**${owner} captain's turn** (${progress.pickIndex + 1}). ${this.mode === "roulette" ? "Choose from these offered players only." : "Cards conceal registered identities until confirmation."}\nPick deadline: <t:${deadline}:R>. ${progress.remaining.length} undrafted remain.`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        ...(buttons.components.length ? [buttons] : []),
      ],
    };
  }
  async initialize(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!Channels.teamPicking?.isSendable()) throw new Error("Team picking channel is unavailable.");
    const red = this.game.getCaptainOfTeam("RED")?.discordSnowflake;
    const blue = this.game.getCaptainOfTeam("BLUE")?.discordSnowflake;
    const remaining = this.game.getPlayersOfTeam("UNDECIDED").map((p) => p.discordSnowflake).sort();
    if (!red || !blue || red === blue || remaining.length < 2 || remaining.length % 2 !== 0)
      throw new Error("Two valid captains and an even nonempty undrafted pool are required.");
    if (this.game.getPlayers().length !== remaining.length + 2)
      throw new Error("Existing drafted team members are incompatible with a new scenario draft.");
    const first: DraftTeam = Math.random() < 0.5 ? "RED" : "BLUE";
    this.progress = {
      mode: this.mode, first, redCaptain: red, blueCaptain: blue,
      red: [], blue: [], remaining,
      cards: this.mode === "masked" ? maskedCards(remaining) : {},
      hand: [], pickIndex: 0, rerolls: { RED: false, BLUE: false },
      deadline: new Date(Date.now() + 120_000).toISOString(), finished: false,
    };
    this.progress.hand = this.mode === "roulette" ? rouletteOffer(remaining) : [];
    this.save();
    this.embedMessage = await Channels.teamPicking.send({ embeds: [this.summaryEmbed()] }) as Message<boolean>;
    await Channels.teamPicking.send(`**${this.mode === "masked" ? "Masked Draft" : "Draft Roulette"} starts!** ${first} has the first pick. Captains have two minutes for the first pick and one minute thereafter. Organiser confirmation and role sync occur only after all selections.`);
    await this.publishTurn();
    await interaction.editReply("Scenario draft has started in the team picking channel.");
  }
  private async publishTurn(): Promise<void> {
    if (this.state !== "inProgress" || !this.progress || this.progress.finished) return;
    this.page = 0;
    this.turnMessage = await Channels.teamPicking.send(this.turnControls()) as Message<boolean>;
    this.armTimeout();
  }
  private armTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout);
    const expected = this.progress!.pickIndex;
    const delay = Math.max(0, Date.parse(this.progress!.deadline) - Date.now());
    this.timeout = setTimeout(() => {
      void TeamCommand.instance?.runRosterOperation(async () => {
        if (this.state !== "inProgress" || this.progress?.pickIndex !== expected) return;
        try {
          const p = this.requireProgress();
          const offered = this.mode === "roulette" ? p.hand : p.remaining;
          if (!offered.length) throw new Error("No legal auto-pick candidates.");
          // Auto-pick is constrained to the same fixed hand shown to the captain.
          await this.pick(offered[0], true);
        } catch (error) {
          this.game.scenarios.needsReview(`Draft timeout could not advance: ${error instanceof Error ? error.message : String(error)}`);
          await this.cancelSession();
        }
      }).catch((error) => {
        this.game.scenarios.needsReview(`Draft timeout operation failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
  }
  private async pick(id: string, automatic: boolean): Promise<void> {
    const p = this.requireProgress();
    if (!p.remaining.includes(id) ||
        (this.mode === "roulette" && !p.hand.includes(id)))
      throw new Error("That player/card is not in the current offer.");
    const team = snakeTurn(p.pickIndex, p.first);
    p[team === "RED" ? "red" : "blue"].push(id);
    p.remaining = p.remaining.filter((value) => value !== id);
    p.pickIndex++;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.turnMessage) await this.turnMessage.edit({ components: [] });
    // Save the next offer BEFORE posting it. Never reshuffle on a repeated Discord event.
    if (p.remaining.length) {
      p.hand = this.mode === "roulette" ? rouletteOffer(p.remaining) : [];
      p.deadline = new Date(Date.now() + 60_000).toISOString();
    } else { p.finished = true; p.hand = []; }
    this.save();
    if (this.embedMessage) await this.embedMessage.edit({ embeds: [this.summaryEmbed(p.finished)] });
    await Channels.teamPicking.send(`${automatic ? "⏰ Time expired — " : ""}**${this.name(id)}** drafted to **${team}**.`);
    if (p.finished) {
      this.finalizeMessage = await Channels.teamPicking.send({
        content: "All cards selected. Organiser: confirm teams or cancel the draft.",
        embeds: [this.summaryEmbed(true)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("draft-accept").setLabel("Confirm Teams").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("draft-cancel").setLabel("Cancel Draft").setStyle(ButtonStyle.Danger),
        )],
      }) as Message<boolean>;
    } else await this.publishTurn();
  }
  async handleControl(interaction: Control): Promise<void> {
    let p: ScenarioDraftProgress;
    try { p = this.requireProgress(); }
    catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "Draft expired.", flags: MessageFlags.Ephemeral });
      return;
    }
    const [prefix, token, turnText, action] = interaction.customId.split(":");
    const team = snakeTurn(p.pickIndex, p.first);
    const captain = team === "RED" ? p.redCaptain : p.blueCaptain;
    if (prefix !== "fwscdraft" || token !== this.token || Number(turnText) !== p.pickIndex ||
        p.finished || this.turnMessage?.id !== interaction.message?.id) {
      await interaction.reply({ content: "That draft turn is over. Use the newest draft controls.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== captain) {
      await interaction.reply({ content: "Only the active captain can use this offer.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (Date.parse(p.deadline) <= Date.now()) {
      await interaction.reply({ content: "Your turn has expired; the displayed hand will be auto-picked.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "pick" && interaction.isStringSelectMenu()) {
      const selected = interaction.values[0];
      const id = this.mode === "masked" ? p.cards[selected] : selected;
      if (!id || !p.remaining.includes(id) || this.mode === "roulette" && !p.hand.includes(id)) {
        await interaction.reply({ content: "That card is no longer eligible.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      await this.pick(id, false);
    } else if (action === "reroll" && interaction.isButton() && this.mode === "roulette") {
      if (p.rerolls[team] || p.remaining.length <= p.hand.length) {
        await interaction.reply({ content: "No reroll available or no alternative hand exists.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      p.rerolls[team] = true;
      const previous = p.hand.join(",");
      for (let tries = 0; tries < 10; tries++) {
        p.hand = rouletteOffer(p.remaining);
        if (p.hand.join(",") !== previous) break;
      }
      this.save();
      await this.turnMessage!.edit(this.turnControls());
      if (this.embedMessage) await this.embedMessage.edit({ embeds: [this.summaryEmbed()] });
    } else if (["next", "prev"].includes(action) && interaction.isButton()) {
      await interaction.deferUpdate();
      const poolSize = this.mode === "roulette" ? p.hand.length : p.remaining.length;
      this.page = Math.max(0, Math.min(Math.ceil(poolSize / 23) - 1, this.page + (action === "next" ? 1 : -1)));
      await this.turnMessage!.edit(this.turnControls());
    } else {
      await interaction.reply({ content: "Invalid or expired draft control.", flags: MessageFlags.Ephemeral });
    }
  }
  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    if (this.state !== "inProgress" || !this.progress?.finished) {
      await interaction.reply({ content: "The draft has not finished.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.finalizeMessage?.id !== interaction.message?.id) {
      await interaction.reply({ content: "That confirmation belongs to an older draft.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId === "draft-cancel") {
      await interaction.update({ components: [] });
      await this.cancelSession();
      return;
    }
    if (interaction.customId !== "draft-accept") return;
    const p = this.requireProgress();
    if (p.remaining.length || new Set([p.redCaptain, p.blueCaptain, ...p.red, ...p.blue]).size !== this.game.getPlayers().length ||
        p.red.length !== p.blue.length) throw new Error("Draft teams no longer form a valid complete roster.");
    await interaction.update({ components: [] });
    const lookup = new Map(this.game.getPlayers().map((pl) => [pl.discordSnowflake, pl]));
    this.game.teams.RED = [p.redCaptain, ...p.red].map((id) => lookup.get(id)!);
    this.game.teams.BLUE = [p.blueCaptain, ...p.blue].map((id) => lookup.get(id)!);
    this.game.teams.UNDECIDED = [];
    this.game.changeHowTeamsDecided("SNAKE_DRAFT");
    this.game.scenarios.complete();
    this.state = "finalized";
    if (this.timeout) clearTimeout(this.timeout);
  }
  async handleMessage(_message: Message<boolean>): Promise<void> {
    // Picks are only accepted through owner-bound controls, never an IGN in public chat.
  }
  async registerLateSignup(): Promise<void> {
    if (this.state !== "inProgress") return;
    this.game.scenarios.needsReview("Late registration changed the frozen scenario draft. Cancel or rebuild.");
    await this.cancelSession();
  }
  async handleUnregister(): Promise<void> {
    if (this.state !== "inProgress") return;
    this.game.scenarios.needsReview("Participant withdrew during the scenario draft. Cancel or rebuild.");
    await this.cancelSession();
  }
  async cancelSession(): Promise<void> {
    const wasActive = this.state === "inProgress";
    this.state = "cancelled";
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    await Promise.all([this.turnMessage, this.finalizeMessage].filter(Boolean)
      .map((msg) => msg!.edit({ components: [] }).catch(() => {})));
    if (wasActive) {
      this.game.scenarios.needsReview("Draft cancelled; organiser must use the scenario fallback or review the roster.");
      if (Channels.teamPicking?.isSendable())
        await Channels.teamPicking.send("Scenario draft cancelled. Organiser review required.");
    }
  }
}
