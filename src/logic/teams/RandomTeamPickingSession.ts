import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { TeamPickingSession } from "./TeamPickingSession";
import { GameInstance } from "database/GameInstance";
import { PlayerInstance } from "database/PlayerInstance";
import { CurrentGameManager } from "logic/CurrentGameManager";

//TODO: elo-based random picking
export type RandomTeamPickingMethod = "random";

export class RandomTeamPickingSession extends TeamPickingSession {
  method: RandomTeamPickingMethod;

  constructor(method: RandomTeamPickingMethod) {
    super();
    this.method = method;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    game.shuffleTeams("random");
    const embed = this.createTeamGenerateEmbed(game);

    await interaction.reply(embed);
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const game = CurrentGameManager.getCurrentGame();
    switch (interaction.customId) {
      case "random-team-accept":
        break;
      case "random-team-generate-reroll":
        game.shuffleTeams("random");
        const embed = this.createTeamGenerateEmbed(game);

        interaction.message.edit(embed);

        interaction.update({});

        break;
      case "random-team-generate-cancel":
        break;
    }
  }

  createTeamGenerateEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");

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
}
