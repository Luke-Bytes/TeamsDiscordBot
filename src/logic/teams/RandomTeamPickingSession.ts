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
import { GameInstance } from "../../database/GameInstance";
import { PlayerInstance } from "../../database/PlayerInstance";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { Team } from "@prisma/client";

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

    this.proposedTeams = { ...game.teams };
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

    this.shuffle();
    const embed = this.createTeamGenerateEmbed(game);

    this.embedMessage = await interaction.editReply(embed);
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

    const getString = (players: PlayerInstance[]) => {
      const captain = players.filter((p) => p.captain)[0];
      return players.length > 0
        ? `**${captain.ignUsed ?? "Unknown Player"}**\n` +
            players
              .filter((p) => !p.captain)
              .map((player) => player.ignUsed ?? "Unknown Player")
              .join("\n")
        : "No players";
    };

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Randomised Teams")
      .addFields(
        {
          name: "🔵 Blue Team 🔵  ",
          value: getString(bluePlayers),
          inline: true,
        },
        {
          name: "🔴 Red Team 🔴   ",
          value: getString(redPlayers),
          inline: true,
        }
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
