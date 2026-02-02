import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { Channels } from "../../Channels";
import { CurrentGameManager } from "../CurrentGameManager";
import { PlayerInstance } from "../../database/PlayerInstance";
import { Team } from "@prisma/client";
import { ConfigManager } from "../../ConfigManager";
import { EloUtil } from "../../util/EloUtil";
import { escapeText } from "../../util/Utils";

export class DraftTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  finishedPicking = false;

  proposedTeams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  redCaptain?: PlayerInstance;
  blueCaptain?: PlayerInstance;

  turn?: Team;

  embedMessage?: Message<boolean>;
  finalizeMessage?: Message<boolean>;
  lateSignups: PlayerInstance[] = [];
  latePickingStarted = false;
  private lateDraftableWindow = 0;
  private lateDraftableBonus = 0;
  private pickCounts: Record<Team, number> = { RED: 0, BLUE: 0 };
  private pickWarningTimeout?: NodeJS.Timeout;
  private pickAutoTimeout?: NodeJS.Timeout;
  private pickDmTimeout?: NodeJS.Timeout;
  private readonly mode: "draft" | "snake";
  private totalPicksMade = 0;
  private firstPickTeam?: Team;

  constructor(mode: "draft" | "snake" = "draft") {
    super();
    this.mode = mode;
  }

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const teamPickingChannel = Channels.teamPicking;
    const game = CurrentGameManager.getCurrentGame();

    this.proposedTeams.RED = [...game.teams.RED];
    this.proposedTeams.BLUE = [...game.teams.BLUE];
    this.proposedTeams.UNDECIDED = [...game.teams.UNDECIDED];
    this.redCaptain = game.getCaptainOfTeam("RED");
    this.blueCaptain = game.getCaptainOfTeam("BLUE");

    if (!this.redCaptain && !this.blueCaptain) {
      await interaction.editReply({
        content:
          "The teams do not have captains. Please use `/captain set` to set the captains of the teams.",
      });
      this.state = "cancelled";
      return;
    } else if (!this.redCaptain) {
      await interaction.editReply({
        content:
          "Red team does not have a captain. Please use `/captain set` to set the captains of Red team.",
      });
      this.state = "cancelled";
      return;
    } else if (!this.blueCaptain) {
      await interaction.editReply({
        content:
          "Blue team does not have a captain. Please use `/captain set` to set the captains of Blue team.",
      });
      this.state = "cancelled";
      return;
    }

    if (this.proposedTeams.UNDECIDED.length % 2 !== 0) {
      await interaction.editReply({
        content:
          "Draft picking requires an even number of undecided players. Please add or remove a player before starting.",
      });
      this.state = "cancelled";
      return;
    }

    const modeLabel =
      this.mode === "snake" ? "snake draft" : "draft team picking";
    await interaction.editReply({
      content: `Started a ${modeLabel} session in <#${teamPickingChannel.id}>`,
    });

    if (teamPickingChannel.isSendable()) {
      const embed = this.createDraftEmbed(false);
      this.embedMessage = await teamPickingChannel.send(embed);
      await teamPickingChannel.send(
        `⚠️ Captains have **2 minutes** for their opening pick and **1 minute** for every pick after that. If time expires, random eligible player will be automatically picked. You'll get a DM with 1 minute remaining on your opening pick and a channel warning 15 seconds before any auto-pick.${
          this.mode === "snake" ? " Snake draft uses a 1-2-2-1 pick order." : ""
        }`
      );

      if (Math.random() < 0.5) {
        this.turn = "RED";
        await teamPickingChannel.send(
          "**Red** team has been randomly picked to select first."
        );
      } else {
        this.turn = "BLUE";
        await teamPickingChannel.send(
          "**Blue** team has been randomly picked to select first."
        );
      }
      this.firstPickTeam = this.turn;
      await this.sendTurnMessage();
    } else {
      console.error(
        "Can not send messages in the team picking channel! Maybe messed up permissions."
      );
    }
  }

  private createDraftEmbed(finalized: boolean, finalizeFooter = true) {
    const redPlayers = this.proposedTeams.RED;
    const bluePlayers = this.proposedTeams.BLUE;
    const undecidedPlayers = this.proposedTeams.UNDECIDED;
    const lateDraftablePlayers = this.getLateDraftablePlayers();

    const getString = (players: PlayerInstance[], includeElo = false) => {
      const captain = players.filter((p) => p.captain)[0];
      const otherThanCaptain = players.filter((p) => !p.captain);

      const formatPlayer = (player: PlayerInstance) => {
        const safeIgnUsed = escapeText(player.ignUsed ?? "Unknown Player");
        const baseInfo = `${EloUtil.getEloEmoji(player.elo)} ${safeIgnUsed}`;
        return includeElo
          ? `${baseInfo} ${EloUtil.getEloFormatted(player)}`
          : baseInfo;
      };

      if (captain) {
        return (
          `**\t\t${formatPlayer(captain)}**\n` +
          otherThanCaptain
            .map((player) => `\t\t${formatPlayer(player)}`)
            .join("\n")
        );
      } else {
        return otherThanCaptain.length > 0
          ? otherThanCaptain
              .map((player) => `\t\t${formatPlayer(player)}`)
              .join("\n")
          : "No players";
      }
    };

    const redEloMean = EloUtil.calculateMeanElo(redPlayers);
    const blueEloMean = EloUtil.calculateMeanElo(bluePlayers);
    const undecidedEloMean = EloUtil.calculateMeanElo(undecidedPlayers);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(
        this.mode === "snake" ? "Snake Drafting Teams" : "Drafting Teams"
      )
      .addFields(
        {
          name: "🔵  Blue Team  🔵  ",
          value: getString(bluePlayers),
          inline: true,
        },
        {
          name: " 🔴  Red Team  🔴  ",
          value: getString(redPlayers),
          inline: true,
        }
      );

    if (!finalized) {
      embed.addFields({
        name: " 🟢 Up for Grabs  🟢 ",
        value: getString(undecidedPlayers, true),
        inline: true,
      });
    }

    // Add Late Signups section (even count only) during drafting
    if (!finalized && lateDraftablePlayers.length > 0) {
      embed.addFields({
        name: ` 🕒 Late Signups  [${lateDraftablePlayers.length}]`,
        value:
          lateDraftablePlayers
            .map((p) => escapeText(p.ignUsed ?? "Unknown Player"))
            .join("\n") || "No players",
        inline: false,
      });
    }

    if (finalized && finalizeFooter) {
      embed.setFooter({
        text: "Select an action below.",
      });
    } else {
      embed.setFooter({
        text: `Blue Team: ${blueEloMean}              Red Team: ${redEloMean}                      Up for Grabs: ${undecidedEloMean}`,
      });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("draft-accept")
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("draft-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: finalized ? [row] : [] };
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const organiserRoleId = ConfigManager.getConfig().roles.organiserRole;
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const isOrganiser = member?.roles.cache.has(organiserRoleId);

    await interaction.deferUpdate().catch(console.error);

    if (
      !isOrganiser ||
      !this.finishedPicking ||
      !interaction.channel?.isSendable()
    ) {
      return;
    }

    switch (interaction.customId) {
      case "draft-accept": {
        const embed = this.createDraftEmbed(true, false);
        await this.finalizeMessage?.edit({
          embeds: embed.embeds,
          components: [],
        });

        await interaction.channel.send("Teams have been finalised!");

        const game = CurrentGameManager.getCurrentGame();
        game.teams.RED = [...this.proposedTeams.RED];
        game.teams.BLUE = [...this.proposedTeams.BLUE];

        const allPickedPlayers = new Set([
          ...this.proposedTeams.RED.map((p) => p.discordSnowflake),
          ...this.proposedTeams.BLUE.map((p) => p.discordSnowflake),
        ]);

        game.teams.UNDECIDED = [
          ...this.proposedTeams.UNDECIDED,
          ...game.teams.UNDECIDED.filter(
            (p) => !allPickedPlayers.has(p.discordSnowflake)
          ),
        ];
        game.changeHowTeamsDecided(
          this.mode === "snake" ? "SNAKE_DRAFT" : "DRAFT"
        );
        this.state = "finalized";
        this.clearTurnTimers();
        break;
      }
      case "draft-cancel":
        await this.embedMessage?.delete().catch(() => {});
        await interaction.channel.send("Draft picking cancelled.");
        this.state = "cancelled";
        this.clearTurnTimers();
        break;
    }
  }

  private getTurnCaptain() {
    switch (this.turn) {
      case "RED":
        return this.redCaptain!;
      case "BLUE":
        return this.blueCaptain!;
    }
  }

  private async sendTurnMessage() {
    const teamPickingChannel = Channels.teamPicking;

    if (!teamPickingChannel.isSendable()) {
      console.error(
        "Could not send message in team picking channel. Does the bot have perms?"
      );
      return;
    }

    const currentCaptain = this.getTurnCaptain();
    if (!currentCaptain) {
      console.error("No current captain!");
      return;
    }

    const messages = await teamPickingChannel.messages.fetch({ limit: 10 });
    const lastTurnMessage = messages.find((msg) =>
      msg.content.includes("It's your turn to choose!")
    );

    if (lastTurnMessage) {
      await lastTurnMessage.delete().catch(() => {});
    }

    await teamPickingChannel.send(
      `<@${currentCaptain.discordSnowflake}> It's your turn to choose! Please type an IGN or ping a player.`
    );
    this.startTurnTimer();
  }

  private getPickPool():
    | { type: "UNDECIDED"; pool: PlayerInstance[] }
    | { type: "LATE"; pool: PlayerInstance[] }
    | null {
    if (this.proposedTeams.UNDECIDED.length > 0) {
      return { type: "UNDECIDED", pool: this.proposedTeams.UNDECIDED };
    }
    const lateDraftable = this.getLateDraftablePlayers();
    if (lateDraftable.length > 0) {
      return {
        type: "LATE",
        pool: lateDraftable,
      };
    }
    return null;
  }

  private async processPick(
    pickingTeam: Team,
    player: PlayerInstance,
    pickingFrom: "UNDECIDED" | "LATE",
    source: "manual" | "auto"
  ): Promise<void> {
    const teamPickingChannel = Channels.teamPicking;
    this.proposedTeams[pickingTeam].push(player);
    if (pickingFrom === "LATE") {
      this.latePickingStarted = true;
      this.lateSignups = this.lateSignups.filter((p) => p !== player);
      if (this.lateDraftableBonus > 0) {
        this.lateDraftableBonus -= 1;
      } else if (this.lateDraftableWindow > 0) {
        this.lateDraftableWindow = Math.max(this.lateDraftableWindow - 1, 0);
      }
      this.syncLateDraftableWindow();
    } else {
      this.proposedTeams.UNDECIDED = this.proposedTeams.UNDECIDED.filter(
        (p) => p !== player
      );
    }

    this.pickCounts[pickingTeam] += 1;
    player.draftSlotPlacement = this.pickCounts[pickingTeam];
    await this.embedMessage?.edit(this.createDraftEmbed(false));

    const safeName = escapeText(player.ignUsed ?? "Unknown Player");
    if (teamPickingChannel.isSendable()) {
      await teamPickingChannel.send(
        source === "manual"
          ? `Player ${safeName} registered for **${pickingTeam}** team.`
          : `Time expired - Auto-picked ${safeName} for **${pickingTeam}** team.`
      );
    }

    if (
      pickingFrom === "UNDECIDED" &&
      this.proposedTeams.UNDECIDED.length === 1
    ) {
      const lastPlayer = this.proposedTeams.UNDECIDED[0];
      const otherTeam = pickingTeam === "RED" ? "BLUE" : "RED";
      this.proposedTeams[otherTeam].push(lastPlayer);
      this.proposedTeams.UNDECIDED = [];
      await this.embedMessage?.edit(this.createDraftEmbed(false));
      if (teamPickingChannel.isSendable()) {
        const safeLast = escapeText(lastPlayer.ignUsed ?? "Unknown Player");
        await teamPickingChannel.send(
          `Player ${safeLast} was automatically assigned to **${otherTeam}** team.`
        );
      }
    }

    if (
      this.proposedTeams.UNDECIDED.length === 0 &&
      this.getLateDraftablePlayers().length === 0
    ) {
      await this.handleRemainingLateSignups(teamPickingChannel);
      await this.sendFinalizationMessage(teamPickingChannel);
      this.finishedPicking = true;
      this.clearTurnTimers();
      return;
    }

    this.totalPicksMade += 1;
    this.turn = this.getNextTurn(pickingTeam);
    await this.sendTurnMessage();
  }

  private getNextTurn(pickingTeam: Team): Team {
    if (this.mode !== "snake" || !this.firstPickTeam) {
      return pickingTeam === "RED" ? "BLUE" : "RED";
    }
    const start = this.firstPickTeam;
    const other = start === "RED" ? "BLUE" : "RED";
    if (this.totalPicksMade === 1) {
      return other;
    }
    const block = Math.floor((this.totalPicksMade - 1) / 2);
    return block % 2 === 0 ? other : start;
  }

  private async sendFinalizationMessage(channel: TextChannel) {
    if (!channel.isSendable()) {
      return;
    }
    const embed = this.createDraftEmbed(true);
    this.finalizeMessage = await channel.send({
      content: "All players have been drafted! Here is the final draft.",
      ...embed,
    });
  }

  private clearTurnTimers() {
    if (this.pickWarningTimeout) {
      clearTimeout(this.pickWarningTimeout);
      this.pickWarningTimeout = undefined;
    }
    if (this.pickAutoTimeout) {
      clearTimeout(this.pickAutoTimeout);
      this.pickAutoTimeout = undefined;
    }
    if (this.pickDmTimeout) {
      clearTimeout(this.pickDmTimeout);
      this.pickDmTimeout = undefined;
    }
  }

  public async cancelSession(): Promise<void> {
    this.state = "cancelled";
    this.clearTurnTimers();
    await this.embedMessage?.delete().catch(() => {});
    const channel = Channels.teamPicking;
    if (channel.isSendable()) {
      await channel.send("Draft picking cancelled.");
    }
  }

  private startTurnTimer() {
    this.clearTurnTimers();
    if (this.state !== "inProgress") return;
    const team = this.turn;
    const captain = this.getTurnCaptain();
    const teamPickingChannel = Channels.teamPicking;
    if (!team || !captain || !teamPickingChannel.isSendable()) return;

    const isFirstPick = this.pickCounts[team] === 0;
    const duration = isFirstPick ? 2 * 60 * 1000 : 60 * 1000;

    if (duration > 15_000) {
      this.pickWarningTimeout = setTimeout(async () => {
        if (!teamPickingChannel.isSendable()) return;
        await teamPickingChannel.send(
          `<@${captain.discordSnowflake}> has 15 seconds remaining before auto-pick for **${team}**.`
        );
      }, duration - 15_000);
    }

    if (isFirstPick && duration > 60_000) {
      this.pickDmTimeout = setTimeout(async () => {
        try {
          const user = await teamPickingChannel.client.users.fetch(
            captain.discordSnowflake
          );
          await user.send(
            "⚠️ You have 1 minute remaining to make your opening pick. Please respond in the team picking channel."
          );
        } catch {
          // ignore DM failures
        }
      }, duration - 60_000);
    }

    this.pickAutoTimeout = setTimeout(() => {
      void this.executeAutoPick(team);
    }, duration);
  }

  private async executeAutoPick(expectedTeam: Team) {
    if (this.turn !== expectedTeam || this.state !== "inProgress") {
      return;
    }
    this.clearTurnTimers();
    const poolInfo = this.getPickPool();
    const channel = Channels.teamPicking;
    if (!poolInfo) {
      if (channel.isSendable()) {
        await channel.send(
          "No eligible players remain to auto-pick. Organisers may need to adjust the draft manually."
        );
      }
      return;
    }

    const randomIndex = Math.floor(Math.random() * poolInfo.pool.length);
    const autoPlayer = poolInfo.pool[randomIndex];
    await this.processPick(expectedTeam, autoPlayer, poolInfo.type, "auto");
  }

  public async handleMessage(message: Message<boolean>) {
    if (message.channel.id !== Channels.teamPicking.id) return;

    if (!message.channel.isSendable()) {
      console.error(
        "Can not send messages in the team picking channel! Does the bot have perms?"
      );
      return;
    }

    const user = message.author;
    if (user.bot) return;

    const currentCaptain = this.getTurnCaptain();
    if (!currentCaptain) return;

    if (currentCaptain.discordSnowflake !== user.id) {
      await message.delete().catch(() => {});
      return;
    }

    const currentTeam = this.turn;
    if (!currentTeam) return;

    const poolInfo = this.getPickPool();
    if (!poolInfo) {
      await message.channel.send(
        "No eligible players remain to draft. Organisers may need to adjust the draft manually."
      );
      await message.delete().catch(() => {});
      return;
    }

    const { type: pickingFrom, pool } = poolInfo;
    if (pickingFrom === "LATE") {
      this.latePickingStarted = true;
    }

    const firstMention = message.mentions.users.values().next().value;
    let player: PlayerInstance | undefined;

    if (firstMention) {
      player = pool.find((p) => p.discordSnowflake === firstMention.id);
      if (!player) {
        await message.channel.send(
          `Invalid player ping: <@${firstMention.id}> - Did that player register?`
        );
        await message.delete().catch(() => {});
        return;
      }
    } else {
      player = pool.find(
        (p) => p.ignUsed?.toLowerCase() === message.content.toLowerCase()
      );

      if (!player) {
        const safeContent = escapeText(message.content);
        await message.channel.send(
          `Invalid player pick: **${safeContent}** - Did that player register?`
        );
        await message.delete().catch(() => {});
        return;
      }
    }

    if (!player) {
      return;
    }

    const existingTeam = Object.keys(this.proposedTeams).find((team) =>
      this.proposedTeams[team as Team].some(
        (p) => p.discordSnowflake === player.discordSnowflake
      )
    );

    if (existingTeam && existingTeam !== "UNDECIDED") {
      await message.channel.send(
        `Player ${escapeText(player.ignUsed ?? "Unknown Player")} is already picked on the other team!`
      );
      return;
    }

    if (
      this.redCaptain?.discordSnowflake === player.discordSnowflake ||
      this.blueCaptain?.discordSnowflake === player.discordSnowflake
    ) {
      await message.channel.send(
        `Player ${escapeText(player.ignUsed ?? "Unknown Player")} is the captain of the other team and cannot be picked.`
      );
      return;
    }

    this.clearTurnTimers();
    await this.processPick(currentTeam, player, pickingFrom, "manual");

    await message.delete().catch(() => {});
    const messages = await message.channel.messages.fetch({ limit: 10 });
    const invalidMessages = messages.filter(
      (msg) => msg.author.bot && msg.content.includes("Invalid player pick:")
    );

    await Promise.all(
      invalidMessages.map((msg) => msg.delete().catch(() => {}))
    );
  }

  public async registerLateSignup(player: PlayerInstance) {
    if (this.latePickingStarted) return;
    this.lateSignups.push(player);
    this.syncLateDraftableWindow();
    if (this.embedMessage) {
      await this.embedMessage.edit(this.createDraftEmbed(false));
    }
  }

  private syncLateDraftableWindow() {
    const evenLateCount =
      this.lateSignups.length - (this.lateSignups.length % 2);
    if (this.latePickingStarted) {
      this.lateDraftableWindow = Math.min(
        this.lateSignups.length,
        this.lateDraftableWindow
      );
      return;
    }
    this.lateDraftableWindow = evenLateCount;
  }

  private getLateDraftablePlayers(): PlayerInstance[] {
    const window = Math.min(
      this.lateSignups.length,
      this.lateDraftableWindow + this.lateDraftableBonus
    );
    if (window <= 0) {
      return [];
    }
    return this.lateSignups.slice(0, window);
  }

  private async handleRemainingLateSignups(channel: TextChannel) {
    if (this.lateSignups.length === 0) {
      return;
    }
    const leftovers = [...this.lateSignups];
    const uniqueLeftovers = leftovers.filter(
      (p, idx, arr) =>
        arr.findIndex((o) => o.discordSnowflake === p.discordSnowflake) ===
          idx &&
        !this.proposedTeams.UNDECIDED.some(
          (u) => u.discordSnowflake === p.discordSnowflake
        )
    );
    this.proposedTeams.UNDECIDED.push(...uniqueLeftovers);
    this.lateSignups = [];
    this.lateDraftableWindow = 0;
    this.lateDraftableBonus = 0;
    await this.embedMessage?.edit(this.createDraftEmbed(false));
    if (channel.isSendable()) {
      const names = uniqueLeftovers
        .map((p) => escapeText(p.ignUsed ?? "Unknown Player"))
        .join(", ");
      await channel.send(
        `Late signup${uniqueLeftovers.length > 1 ? "s" : ""} ${names} remain undecided and may not participate.`
      );
    }
  }

  public async handleUnregister(discordSnowflake: string): Promise<void> {
    let removedFromTeams = false;
    const teams: Array<Team | "UNDECIDED"> = ["RED", "BLUE", "UNDECIDED"];

    for (const team of teams) {
      const before = this.proposedTeams[team].length;
      this.proposedTeams[team] = this.proposedTeams[team].filter(
        (player) => player.discordSnowflake !== discordSnowflake
      );
      if (this.proposedTeams[team].length !== before) {
        removedFromTeams = true;
      }
    }

    this.lateSignups = this.lateSignups.filter(
      (player) => player.discordSnowflake !== discordSnowflake
    );

    if (removedFromTeams) {
      this.lateDraftableBonus += 1;
    }

    this.syncLateDraftableWindow();
    if (this.embedMessage) {
      await this.embedMessage.edit(this.createDraftEmbed(false));
    }
  }
}
