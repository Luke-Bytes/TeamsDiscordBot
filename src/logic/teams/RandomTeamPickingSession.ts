import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
} from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { GameInstance } from "database/GameInstance";
import { PlayerInstance } from "database/PlayerInstance";
import { CurrentGameManager } from "logic/CurrentGameManager";
import { Team } from "@prisma/client";
import { log } from "console";

export class RandomTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";
  embedMessage?: Message<boolean>;
  proposedTeams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  redCaptain?: PlayerInstance;
  blueCaptain?: PlayerInstance;

  constructor() {
    super();
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    this.redCaptain = game.getCaptainOfTeam("RED");
    this.blueCaptain = game.getCaptainOfTeam("BLUE");

    this.proposedTeams = { ...game.teams };

    this.shuffle();
    const embed = this.createTeamGenerateEmbed(game);

    this.embedMessage = await (await interaction.reply(embed)).fetch();
  }

  private shuffle() {
    const shuffled = Object.values(this.proposedTeams)
      .flat(1)
      .filter((p) => !p.captain)
      .sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);

    const blue = shuffled.slice(0, half);
    const red = shuffled.slice(half);

    this.proposedTeams.BLUE = [this.blueCaptain!];
    this.proposedTeams.RED = [this.redCaptain!];

    this.proposedTeams.BLUE.push(...blue);
    this.proposedTeams.RED.push(...red);

    this.proposedTeams.UNDECIDED = [];

    log(this.proposedTeams);
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const game = CurrentGameManager.getCurrentGame();
    switch (interaction.customId) {
      case "random-team-accept":
        {
          const { embeds } = this.createTeamGenerateEmbed(game);
          await this.embedMessage?.edit({ embeds, components: [] });
          await interaction.update({});
          game.teams = this.proposedTeams;
          this.state = "finalized";
        }
        break;
      case "random-team-generate-reroll":
        {
          this.shuffle();
          const embed = this.createTeamGenerateEmbed(game);

          await this.embedMessage!.edit(embed);

          await interaction.update({});
        }
        break;
      case "random-team-generate-cancel":
        await this.embedMessage?.delete();
        this.state = "cancelled";
        break;
    }
  }

  createTeamGenerateEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = this.proposedTeams.RED;
    const bluePlayers: PlayerInstance[] = this.proposedTeams.BLUE;

    const bluePlayersString =
      bluePlayers.length > 0
        ? `**${bluePlayers[0].ignUsed}**\n` +
          bluePlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const redPlayersString =
      redPlayers.length > 0
        ? `**${redPlayers[0].ignUsed}**\n` +
          redPlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Randomized Teams")
      .addFields(
        { name: "🔵 Blue Team 🔵  ", value: bluePlayersString, inline: true },
        { name: "🔴 Red Team 🔴   ", value: redPlayersString, inline: true }
      )
      .setFooter({ text: "Choose an action below." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("random-team-accept")
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("random-team-generate-reroll")
        .setLabel("Reroll")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("random-team-generate-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [row] };
  }

  public async handleMessage(message: Message<boolean>) {}

  public getState() {
    return this.state;
  }
}
