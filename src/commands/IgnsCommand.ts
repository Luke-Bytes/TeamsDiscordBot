import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface";
import { prismaClient } from "../database/prismaClient";
import { createIGNListEmbed } from "../util/EmbedUtil";
import { MojangAPI } from "../api/MojangAPI";

export default class TestCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;

  constructor() {
    this.name = "ign";
    this.description = "View or modify your in-game names.";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) => {
        return subcommand
          .setName("add")
          .setDescription("Add an ign")
          .addStringOption((option) => {
            return option
              .setName("ign")
              .setDescription("The ign to add")
              .setRequired(true);
          });
      })
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
      case "add":
        const ign = interaction.options.getString("ign", true);
        const uuid = await MojangAPI.usernameToUUID(ign);
        const result = await prismaClient.player.addMcAccount(
          interaction.user.id,
          uuid
        );
        if (result.error) {
          await interaction.editReply(result.error);
        } else {
          await interaction.editReply("IGN added successfully.");
        }
        break;
      case "list":
        const player = await prismaClient.player.findUnique({
          where: {
            discordSnowflake: interaction.user.id,
          },
        });

        if (!player) {
          await interaction.editReply(
            "You are unregistered. Use /ign to add an IGN."
          );
          return;
        }

        const primaryMinecraftAccount = player.primaryMinecraftAccount
          ? await MojangAPI.uuidToUsername(player.primaryMinecraftAccount)
          : "N/A";

        const others = await Promise.all(
          player.minecraftAccounts
            .filter((v) => v !== player.primaryMinecraftAccount)
            .map(async (v) => {
              return await MojangAPI.uuidToUsername(v);
            })
        );

        const msg = createIGNListEmbed(
          interaction.user.displayName,
          primaryMinecraftAccount,
          others
        );

        await interaction.editReply(msg);
    }
  }
}
