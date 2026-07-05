import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil";
import {
  parseDiscordTimestampInput,
  TIMESTAMP_TIMEZONES,
} from "../util/TimestampUtil";

export default class TimestampCommand implements Command {
  name = "timestamp";
  description = "Convert a date/time to a Discord timestamp";
  buttonIds: string[] = [];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((option) =>
      option
        .setName("time")
        .setDescription("Date/time (e.g 'tomorrow 7pm')")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("timezone")
        .setDescription("Timezone")
        .addChoices(
          ...TIMESTAMP_TIMEZONES.map((timezone) => ({
            name: timezone,
            value: timezone,
          }))
        )
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription("Display format")
        .addChoices(
          { name: "Date & Time", value: "F" },
          { name: "Countdown", value: "R" },
          { name: "Time Only", value: "t" },
          { name: "Date Only", value: "D" }
        )
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("echo")
        .setDescription("Echo the timestamp in a plain message")
        .setRequired(false)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("time", true);
    const tzInput = interaction.options.getString("timezone");
    const format = interaction.options.getString("format") ?? "F";
    const echo = interaction.options.getBoolean("echo") ?? true;

    const parsed = parseDiscordTimestampInput(input, tzInput);
    if ("error" in parsed) {
      await interaction.reply({
        content: `❌ ${parsed.error}`,
      });
      return;
    }

    const discordTimestamp = `<t:${parsed.unix}:${format}>`;

    await interaction.reply({
      content: `${discordTimestamp}`,
    });

    if (echo) {
      if (interaction.guild) {
        const channelKey = DiscordUtil.getChannelKeyById(interaction.channelId);
        if (channelKey) {
          await DiscordUtil.sendMessage(
            channelKey,
            `\`\`\`${discordTimestamp}\`\`\``
          );
        }
      } else {
        await interaction.user.send(`\`\`\`${discordTimestamp}\`\`\``);
      }
    }
  }
}
