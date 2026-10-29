import { ChatInputCommandInteraction, Guild, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { prismaClient } from "../database/prismaClient.js";
import { MojangAPI } from "../api/MojangAPI.js";
import { fetchGuildMember } from "../util/DiscordFailures";
import { escapeText } from "../util/Utils";

export default class VerifyCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify Minecraft IGNs against the database")
    .addSubcommand((sub) =>
      sub
        .setName("igns")
        .setDescription("Validate usernames")
        .addStringOption((opt) =>
          opt
            .setName("names")
            .setDescription("Space separated list of usernames to verify")
            .setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("pingplayers")
            .setDescription("Whether to ping verified players")
            .setRequired(false)
        )
    );

  public name = this.data.name;
  public description = this.data.description;
  public buttonIds: string[] = [];

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const member = DiscordUtil.getGuildMember(interaction);
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await DiscordUtil.reply(
        interaction,
        "🚫 You do not have permission to use this command. Only organisers may use it."
      );
      return;
    }

    await interaction.deferReply();
    const namesInput = interaction.options.getString("names", true);
    const ping = interaction.options.getBoolean("pingplayers") ?? false;
    const allNames = namesInput.split(/\s+/).filter((n) => n.length > 0);
    const names = [...new Map(allNames.map((name) => [name.toLowerCase(), name])).values()];
    if (names.length > 25) {
      await interaction.editReply("Please verify no more than 25 distinct names per request.");
      return;
    }
    if (names.some((name) => name.length > 16)) {
      await interaction.editReply("Minecraft usernames must be no longer than 16 characters.");
      return;
    }

    const results: string[] = [];
    const mentionableUserIds: string[] = [];

    for (const name of names) {
      const escapedName = escapeText(name);

      const lookup = await MojangAPI.lookupUsername(name);
      if (lookup.status === "invalid") {
        results.push(`❌ **${escapedName}** – Invalid Minecraft username format`);
        continue;
      }
      if (lookup.status === "unavailable") {
        results.push(`⚠️ **${escapedName}** – Verification service unavailable; account status is unknown`);
        continue;
      }
      if (lookup.status === "notFound") {
        const possible = await prismaClient.player.findMany({
          where: { minecraftAccounts: { has: name } },
        });
        const matches = possible.filter((p) =>
          p.minecraftAccounts.some(
            (acc) => acc.toLowerCase() === name.toLowerCase()
          )
        );

        if (matches.length > 0) {
          for (const match of matches) {
            const currentName =
              (await MojangAPI.uuidToUsername(
                match.primaryMinecraftAccount!
              )) ??
              match.latestIGN ??
              "Unknown IGN";
            const safeCurrentName = escapeText(currentName);

            const authorTag = await this.memberLabel(
              interaction.guild, match.discordSnowflake, ping, mentionableUserIds
            );
            results.push(
              `❓ **${escapedName}** – Username not found on Mojang; historical match: ${authorTag}, latest IGN: **${safeCurrentName}**`
            );
          }
        } else {
          results.push(`❓ **${escapedName}** – Username not found on Mojang`);
        }
        continue;
      }

      const player = await prismaClient.player.findFirst({
        where: { primaryMinecraftAccount: lookup.uuid },
      });

      if (!player) {
        results.push(
          `⛔ **${escapedName}** – Valid username but not registered in database`
        );
        continue;
      }

      const authorTag = await this.memberLabel(
        interaction.guild, player.discordSnowflake, ping, mentionableUserIds
      );

      const latest = player.latestIGN;
      const escapedLatest = latest ? escapeText(latest) : latest;
      if (latest && name.toLowerCase() !== latest.toLowerCase()) {
        results.push(
          `✅ **${escapedName}** – ${authorTag} - Name changed since they last registered from "${escapedLatest}"`
        );
      } else {
        results.push(`✅ **${escapedName}** – ${authorTag}`);
      }
    }

    const header = "**Verification Results**:\n\n";
    const lines: string[] = [];
    let length = header.length;
    for (const result of results) {
      if (length + result.length + 1 > 1800) {
        lines.push("… Additional results omitted to stay within Discord's message limit.");
        break;
      }
      lines.push(result);
      length += result.length + 1;
    }
    await interaction.editReply({
      content: header + lines.join("\n"),
      allowedMentions: { users: [...new Set(mentionableUserIds)] },
    });
  }

  private async memberLabel(
    guild: Guild | null,
    id: string,
    ping: boolean,
    mentions: string[]
  ): Promise<string> {
    if (!guild) return escapeText(`@${id} (guild membership unknown)`);
    try {
      const member = await fetchGuildMember(guild, id);
      if (!member) return escapeText(`@${id} (no longer in server)`);
      if (ping) {
        mentions.push(id);
        return `<@${id}>`;
      }
      return escapeText(`@${member.user.tag}`);
    } catch (error) {
      console.warn(`Verify could not confirm guild membership member=${id}`, error);
      return escapeText(`@${id} (membership unverified)`);
    }
  }
}
