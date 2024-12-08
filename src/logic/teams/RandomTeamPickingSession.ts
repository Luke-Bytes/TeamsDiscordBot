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

  constructor() {
    super();
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    game.createTeams("random");
    const embed = this.createTeamGenerateEmbed(game);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    this.embedMessage = await interaction.editReply(embed);
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    switch (interaction.customId) {
      case "random-team-accept": {
        const simulatedTeams = game.simulateShuffledTeams();
        game.teams.BLUE = simulatedTeams.BLUE;
        game.teams.RED = simulatedTeams.RED;
        game.teams.UNDECIDED = [];

        const { embeds, components } = this.createTeamGenerateEmbed(game);
        await this.embedMessage?.edit({
          embeds,
          components,
        });

        await interaction.update({});
        this.state = "finalized";
        break;
      }

      case "random-team-generate-reroll": {
        const simulatedTeams = game.simulateShuffledTeams();
        const { embeds, components } = this.createTeamGenerateEmbed(
          game,
          simulatedTeams
        );
        await this.embedMessage?.edit({
          embeds,
          components,
        });

        await interaction.update({});
        break;
      }

      case "random-team-generate-cancel":
        await this.embedMessage?.delete();
        this.state = "cancelled";
        break;
    }
  }

  createTeamGenerateEmbed(
    game: GameInstance,
    simulatedTeams?: Record<Team, PlayerInstance[]>
  ) {
    const teams = simulatedTeams || game.teams;

    const formatTeamString = (players: PlayerInstance[]) =>
      players.length
        ? players
          .map((player, index) =>
            index === 0
              ? `**${player.ignUsed ?? "Unknown Player"}**`
              : `${player.ignUsed ?? "Unknown Player"}`
          )
          .join("\n")
        : "No players";

    const bluePlayersString = formatTeamString(teams.BLUE);
    const redPlayersString = formatTeamString(teams.RED);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Randomised Teams")
      .addFields(
        { name: "🔵 Blue Team 🔵", value: bluePlayersString, inline: true },
        { name: "🔴 Red Team 🔴", value: redPlayersString, inline: true }
      )
      .setFooter({ text: "This is a preview. Confirm to lock teams." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("random-team-accept")
        .setLabel("Confirm Teams")
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


  public getState() {
    return this.state;
  }
}
