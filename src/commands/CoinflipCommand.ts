import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface";

export default class CoinflipCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "coinflip";
  public description = "Flip a coin between two users";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addUserOption((opt) =>
        opt.setName("user1").setDescription("First user").setRequired(true)
      )
      .addUserOption((opt) =>
        opt.setName("user2").setDescription("Second user").setRequired(true)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const u1 = interaction.options.getUser("user1", true);
    const u2 = interaction.options.getUser("user2", true);

    if (u1.id === u2.id) {
      await interaction.reply({
        content: "Please choose two different users for a fair coin flip.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const winner = Math.random() < 0.5 ? u1 : u2;
    const loser = winner.id === u1.id ? u2 : u1;

    await interaction.reply({
      content: `🪙 Coin flip between <@${u1.id}> and <@${u2.id}> → Winner: **<@${winner.id}>**!`,
      allowedMentions: { users: [winner.id, loser.id] },
    });
  }
}
