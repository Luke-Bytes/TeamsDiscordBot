import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { prismaClient } from "../database/prismaClient.js";
import { MojangAPI } from "../api/MojangAPI.js";
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

    const namesInput = interaction.options.getString("names", true);
    const ping = interaction.options.getBoolean("pingplayers") ?? false;
    const names = namesInput.split(/\s+/).filter((n) => n.length > 0);

    const results: string[] = [];
    const mentionableUserIds: string[] = [];

    for (const name of names) {
      const escapedName = escapeText(name);

      const uuid = await MojangAPI.usernameToUUID(name);
      if (!uuid) {
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

            let authorTag: string;
            if (ping) {
              authorTag = `<@${match.discordSnowflake}>`;
              mentionableUserIds.push(match.discordSnowflake);
            } else {
              try {
                const fetched = await interaction.guild?.members.fetch(
                  match.discordSnowflake
                );
                authorTag = fetched
                  ? `@${fetched.user.tag}`
                  : `@${match.discordSnowflake}`;
              } catch {
                authorTag = `@${match.discordSnowflake}`;
              }
              authorTag = escapeText(authorTag);
            }

            results.push(
              `❓ **${escapedName}** – Invalid username; Did you mean ${authorTag} - latest IGN: **${safeCurrentName}** ?`
            );
          }
        } else {
          results.push(`❌ **${escapedName}** – Invalid username`);
        }
        continue;
      }

      const player = await prismaClient.player.findFirst({
        where: { primaryMinecraftAccount: uuid },
      });

      if (!player) {
        results.push(
          `⛔ **${escapedName}** – Valid username but not registered in database`
        );
        continue;
      }

      let authorTag: string;
      if (ping) {
        authorTag = `<@${player.discordSnowflake}>`;
        mentionableUserIds.push(player.discordSnowflake);
      } else {
        try {
          const fetched = await interaction.guild?.members.fetch(
            player.discordSnowflake
          );
          authorTag = fetched
            ? `@${fetched.user.tag}`
            : `@${player.discordSnowflake}`;
        } catch {
          authorTag = `@${player.discordSnowflake}`;
        }
        authorTag = escapeText(authorTag);
      }

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

    const content = `**Verification Results**:\n\n${results.join("\n")}`;
    await interaction.reply({
      content,
      ephemeral: false,
      allowedMentions: { users: mentionableUserIds },
    });
  }
}
