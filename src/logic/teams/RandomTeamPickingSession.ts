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

export class RandomTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  embedMessage?: Message<boolean>;

  constructor() {
    super();
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    game.shuffleTeams("random");
    const embed = this.createTeamGenerateEmbed(game);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    this.embedMessage = await interaction.editReply(embed);
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const game = CurrentGameManager.getCurrentGame();
    switch (interaction.customId) {
      case "random-team-accept":
        {
          const { embeds } = this.createTeamGenerateEmbed(game);
          await this.embedMessage?.edit({ embeds, components: [] });
          await interaction.update({});
          this.state = "finalized";
        }
        break;
      case "random-team-generate-reroll":
        {
          game.shuffleTeams("random");
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
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");

    const bluePlayersString =
      bluePlayers.length > 0
        ? `**${bluePlayers[0].ignUsed ?? "Unknown Player"}**\n` +
          bluePlayers
            .slice(1)
            .map((player) => player.ignUsed ?? "Unknown Player")
            .join("\n")
        : "No players";

    const redPlayersString =
      redPlayers.length > 0
        ? `**${redPlayers[0].ignUsed ?? "Unknown Player"}**\n` +
          redPlayers
            .slice(1)
            .map((player) => player.ignUsed ?? "Unknown Player")
            .join("\n")
        : "No players";

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Randomised Teams")
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

  public getState() {
    return this.state;
  }
}
