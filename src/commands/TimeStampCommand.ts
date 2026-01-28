import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { DiscordUtil } from "../util/DiscordUtil";

const TZ_MAP: Record<string, string> = {
  GMT: "Etc/GMT",
  BST: "Europe/London",
  CET: "Europe/Paris",
  EST: "America/New_York",
  CST: "America/Chicago",
  PST: "America/Los_Angeles",
  JST: "Asia/Tokyo",
};

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
          { name: "GMT", value: "GMT" },
          { name: "BST", value: "BST" },
          { name: "CET", value: "CET" },
          { name: "EST", value: "EST" },
          { name: "CST", value: "CST" },
          { name: "PST", value: "PST" },
          { name: "JST", value: "JST" }
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

    const tz = tzInput ? TZ_MAP[tzInput.toUpperCase()] : undefined;
    const parsed = chrono.parseDate(input, new Date(), { forwardDate: true });

    if (!parsed) {
      await interaction.reply({
        content: "❌ Could not parse the date/time input.",
      });
      return;
    }

    const base = DateTime.fromJSDate(parsed);
    let dt = base;
    if (tz) {
      const wall = {
        year: base.year,
        month: base.month,
        day: base.day,
        hour: base.hour,
        minute: base.minute,
        second: base.second,
        millisecond: 0,
      };
      dt = DateTime.fromObject(wall, { zone: tz });
    }

    if (!dt.isValid) {
      await interaction.reply({
        content: `❌ Invalid timezone: ${tz}`,
      });
      return;
    }

    const unix = Math.floor(dt.toSeconds());
    const discordTimestamp = `<t:${unix}:${format}>`;

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
