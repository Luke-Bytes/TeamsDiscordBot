import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PlayerData } from "../database/PlayerData";
import { EloUtil } from "../util/EloUtil";
import { log } from "console";

export default class StatsCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;

  constructor() {
    this.name = "stats";
    this.description = "Get the stats of yourself or another player.";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("player")
          .setDescription(
            "the player to fetch stats for, or blank for yourself"
          )
          .setRequired(false)
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("player", false);
    const player =
      input !== null
        ? PlayerData.playerDataList.find(
            (playerData) => playerData.getInGameName() === input
          )
        : PlayerData.playerDataList.find(
            (playerData) =>
              playerData.getDiscordUserId() === interaction.user.id
          );

    if (player === undefined) {
      await interaction.reply({
        //TODO: better error messages?
        content:
          input === null ? "You are not registered." : "Player not found",
        ephemeral: true,
      });
      return;
    } else {
      log(player);
    }

    const winLossRatio =
      player.getLosses() === 0
        ? player.getWins()
        : player.getWins() / player.getLosses();
    //TODO: winstreak
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Friendly Wars Stats")
      .addFields(
        {
          name: " ",
          value:
            "**NAME**\n**ELO**\n**WINS**\n**LOSSES**\n**W/L**\n**WINSTREAK**",
          inline: true,
        },
        {
          name: " ",
          value: `${player.getInGameName()}\n${player.getElo()} ${EloUtil.getEloEmoji(
            player.getElo()
          )}\n${player.getWins()}\n${player.getLosses()}\n${winLossRatio}\n${"(winstreak)"}`,
          inline: true,
        }
      );

    await interaction.reply({
      embeds: [embed],
    });
  }
}
