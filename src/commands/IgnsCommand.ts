import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { prismaClient } from "../database/prismaClient.js";
import { MojangAPI } from "../api/MojangAPI.js";

export default class IgnsCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "ign";
  public description = "View or modify your in-game names";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) => {
        return subcommand
          .setName("list")
          .setDescription("List your registered IGNs.");
      }) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "list":
        {
          const player = await prismaClient.player.findUnique({
            where: {
              discordSnowflake: interaction.user.id,
            },
          });

          if (!player) {
            await interaction.editReply(
              "You are unregistered. First play a game!"
            );
            return;
          }

          if (!player.primaryMinecraftAccount) {
            await interaction.editReply(
              "You are unregistered. First play a game!"
            );
            return;
          }

          const primaryMinecraftAccount = await MojangAPI.uuidToUsername(
            player.primaryMinecraftAccount
          );

          if (!primaryMinecraftAccount) {
            //technically this should never happen, because how can you have a uuid saved that doesn't point to a valid minecraft account..
            await interaction.editReply(
              "You are unregistered. First play a game!"
            );
            return;
          }

          //same here.
          const others = await Promise.all(
            player.minecraftAccounts.filter(
              (v) => v !== player.primaryMinecraftAccount
            )
          );

          //just be sure that they're all valid mc accounts
          for (const element of others) {
            if (element === undefined) {
              await interaction.editReply(
                "One or more of your accounts failed to fetch properly. Please contact devs."
              );
              return;
            }
          }

          const msg = this.createIGNListEmbed(
            interaction.user.displayName,
            primaryMinecraftAccount,
            others as string[]
          );

          await interaction.editReply(msg);
        }
        break;
    }
  }

  createIGNListEmbed(
    discordDisplayName: string,
    primaryAccount: string,
    otherAccounts: string[]
  ) {
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(`IGNs for ${discordDisplayName}`)
      .addFields({
        name: `1. ${primaryAccount}`,
        value: ` ${otherAccounts
          .filter((v) => v !== primaryAccount)
          .map((v, i) => {
            return `${i + 2}. ${v}`;
          })
          .join("\n")}`,
        inline: false,
      });
    return { embeds: [embed] };
  }
}
