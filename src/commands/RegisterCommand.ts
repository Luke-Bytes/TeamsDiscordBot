import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
  User,
} from "discord.js";
import { Command } from "./CommandInterface";
import { GameData } from "../database/GameData";
import { PlayerData } from "../database/PlayerData";
import fs from "fs";

export default class RegisterCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;
  private config: any;

  constructor() {
    this.name = "register";
    this.description = "Register for friendly war!";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("ingamename")
          .setDescription("The in-game name to register")
          .setRequired(true)
      )
      .addUserOption((option) =>
        option
          .setName("discorduser")
          .setDescription("The Discord user to register (organisers only)")
          .setRequired(false)
      ) as SlashCommandBuilder;

    this.config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const registrationChannelId = this.config.channels.registration;
    const organiserRoleId = this.config.roles.organiserRole;

    if (interaction.channelId !== registrationChannelId) {
      await interaction.reply({
        content: "You can only register in the registration channel.",
        ephemeral: false,
      });
      return;
    }

    const inGameName = interaction.options.getString("ingamename");
    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;

    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const isOrganiser = member?.roles.cache.has(organiserRoleId);

    if (!isOrganiser && targetUser.id !== interaction.user.id) {
      await interaction.reply({
        content: "You do not have permission to register other users.",
        ephemeral: false,
      });
      return;
    }

    // Check if the player is already registered globally
    const isAlreadyRegistered =
      PlayerData.getPlayerByInGameName(inGameName) ||
      PlayerData.getAllPlayers().some(
        (player) => player.getDiscordUserId() === discordUserId
      );

    if (isAlreadyRegistered) {
      await interaction.reply({
        content:
          "This user is already registered or the in-game name is taken.",
        ephemeral: false,
      });
      return;
    }

    GameData.addPlayer(inGameName);
    const newPlayer = new PlayerData(
      discordUserId,
      discordUserName,
      inGameName
    );
    PlayerData.playerDataList.push(newPlayer);

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({
        content: `You have successfully registered as ${inGameName}!`,
        ephemeral: false,
      });
    } else {
      await interaction.reply({
        content: `${discordUserName} has been successfully registered as ${inGameName}!`,
        ephemeral: false,
      });
    }
  }
}
