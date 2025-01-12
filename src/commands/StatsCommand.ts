import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { EloUtil } from "../util/EloUtil.js";
import { PrismaUtils } from "../util/PrismaUtils";

export default class StatsCommand implements Command {
  public name = "stats";
  public description = "Get the stats of yourself or another player";
  public data: SlashCommandBuilder;
  public buttonIds: string[] = [];

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
    await interaction.deferReply({});

    let input =
      interaction.options.getString("player", false) ?? interaction.user.id;

    // strip the <@...> from the string if they used a ping.
    input = input.replace(/<@([^>]+)>/g, "$1");

    const player = await PrismaUtils.findPlayer(input);
    if (!player) {
      await interaction.editReply({
        content: "Player not found.",
      });
      return;
    }

    const winLossRatio =
      player.losses === 0 ? player.wins : player.wins / player.losses;
    const winStreak = player.winStreak;
    let fetchedPlayer =
      interaction.guild?.members.resolve(player.discordSnowflake) ||
      (await interaction.guild?.members.fetch(player.discordSnowflake));

    if (!fetchedPlayer) {
      await interaction.editReply({
        content: "Player not found.",
      });
      return;
    }

    let winLossDisplay = winLossRatio.toFixed(2);
    if (player.wins > 0 && player.losses === 0) {
      winLossDisplay += " 🔥";
    }

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("📊 Friendly Wars Stats")
      .setDescription("Overall performance:")
      .setThumbnail(fetchedPlayer.displayAvatarURL())
      .addFields(
        {
          name: "Player",
          value: `${player.minecraftAccounts.join(", ")}`,
          inline: true,
        },
        {
          name: "ELO",
          value: `${player.elo} ${EloUtil.getEloEmoji(player.elo)}`,
          inline: true,
        },
        {
          name: "Current Win Streak",
          value: `${winStreak}`,
          inline: true,
        },
        {
          name: "Wins",
          value: `${player.wins}`,
          inline: true,
        },
        {
          name: "Losses",
          value: `${player.losses}`,
          inline: true,
        },
        {
          name: "Win/Loss Ratio",
          value: `${winLossDisplay}`,
          inline: true,
        }
      )
      .setFooter({
        text: `Requested by ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    const msg = await interaction.editReply({
      embeds: [embed],
    });

    setTimeout(
      async () => {
        await msg.delete();
      },
      2 * 60 * 1000
    );
  }
}
