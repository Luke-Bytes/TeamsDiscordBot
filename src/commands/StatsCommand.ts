import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { EloUtil } from "../util/EloUtil";
import { log } from "console";
import { TeamsPlayer } from "../database/TeamsPlayer";

export default class StatsCommand implements Command {
  name: string;
  description: string;
  data: SlashCommandBuilder;

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
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("player", false);
    const player =
      input !== null
        ? await TeamsPlayer.byMinecraftAccount(input)
        : await TeamsPlayer.byDiscordSnowflake(interaction.user.id);

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
      player.losses === 0 ? player.wins : player.wins / player.losses;

    //TODO: winstreak
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Friendly Wars Stats")
      .addFields(
        {
          name: " ",
          value:
            "**NAMES**\n**ELO**\n**WINS**\n**LOSSES**\n**W/L**\n**WINSTREAK**",
          inline: true,
        },
        {
          name: " ",
          value: `${player.minecraftAccounts.join(", ")}\n${player.elo} ${EloUtil.getEloEmoji(
            player.elo
          )}\n${player.wins}\n${player.losses}\n${winLossRatio}\n${"(winstreak)"}`,
          inline: true,
        }
      );

    await interaction.reply({
      embeds: [embed],
    });
  }
}
