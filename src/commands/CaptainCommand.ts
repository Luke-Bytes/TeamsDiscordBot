import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PlayerData } from "../database/PlayerData";
import { GameData } from "../database/GameData";
import fs from "fs";

const configPath = "./config.json";
const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));

export default class CaptainCommand implements Command {

  data: SlashCommandBuilder;
  name: string;
  description: string;

  constructor() {
    this.name = "captain";
    this.description = "Set or change the captain of a team";
    this.data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set a team captain")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The player to set as captain")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("team")
            .setDescription("Team Colour")
            .setRequired(true)
            .addChoices(
              { name: "blue", value: "blue" },
              { name: "red", value: "red" }
            )
        )
    );
  }


  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member || !member.roles) {
      await interaction.reply({
        content: "Couldn't find role data - do I need more permissions?.",
        ephemeral: true,
      });
      return;
    }

    const organiserRoleId = configData.roles.organiserRole;
    const captainRoleId = configData.roles.captainRole;
    const teamColor = interaction.options.getString("team")!;
    const user = interaction.options.getUser("user")!;

    if (!member.roles.cache.has(organiserRoleId)) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    // Find the corresponding PlayerData object for the user
    const player = PlayerData.playerDataList.find(
      (p) => p.getDiscordUserId() === user.id
    );
    if (!player) {
      await interaction.reply({
        content: "This player hasn't registered!",
        ephemeral: true,
      });
      return;
    }

    const inGameName = player.getInGameName();
    if (!GameData.getPlayers().includes(inGameName)) {
      await interaction.reply({
        content: `${inGameName} is not in the current game players list. Captain cannot be set.`,
        ephemeral: true,
      });
      return;
    }

    const previousCaptain = this.getCaptainByTeam(teamColor as "blue" | "red");
    if (previousCaptain) {
      console.log(
        `Previous captain found: ${previousCaptain.getDiscordUserName()}`
      );

      const previousMember = interaction.guild.members.cache.get(
        previousCaptain.getDiscordUserId()
      );
      if (previousMember) {
        console.log(
          `Removing captain role from: ${previousMember.user.username}`
        );
        previousCaptain.setCaptain(false); // Set the isCaptain flag to false
        await previousMember.roles
          .remove(captainRoleId)
          .then(() =>
            console.log(
              `Captain role removed from: ${previousMember.user.username}`
            )
          )
          .catch((error) =>
            console.error(`Failed to remove captain role: ${error}`)
          );
      } else {
        console.log(
          `Previous captain member not found in guild: ${previousCaptain.getDiscordUserName()}`
        );
      }
    } else {
      console.log(
        `No previous captain found for ${teamColor} team, proceeding..`
      );
    }

    console.log(`Setting new captain: ${user.username}`);
    player.setCaptain(true);
    const newCaptainMember = await interaction.guild.members.fetch(user.id);
    if (newCaptainMember) {
      await newCaptainMember.roles
        .add(captainRoleId)
        .then(() =>
          console.log(
            `Captain role added to: ${newCaptainMember.user.username}`
          )
        )
        .catch((error) =>
          console.error(`Failed to add captain role: ${error}`)
        );

      if (teamColor === "blue") {
        GameData.setBluePlayers([...GameData.getBluePlayers(), inGameName]);
        console.log(`${inGameName} added to bluePlayers`);
      } else {
        GameData.setRedPlayers([...GameData.getRedPlayers(), inGameName]);
        console.log(`${inGameName} added to redPlayers`);
      }

      await interaction.reply({
        content: `${user.displayName} has been set as the ${teamColor} team captain.`,
      });
    } else {
      console.log(
        `Failed to fetch member for new captain: ${user.displayName}`
      );
      await interaction.reply({
        content: "Could not assign captain role. Is this name correct?",
        ephemeral: true,
      });
    }
  }

  private getCaptainByTeam(teamColor: "blue" | "red"): PlayerData | null {
    const captain = PlayerData.playerDataList.find(
      (player) =>
        player.getIsCaptain() && this.isPlayerOnTeam(player, teamColor)
    );

    if (captain) {
      console.log(
        `Captain for ${teamColor} team is: ${captain.getDiscordUserName()}`
      );
    } else {
      console.log(`No captain found for ${teamColor} team`);
    }

    return captain ?? null;
  }

  private isPlayerOnTeam(
    player: PlayerData,
    teamColor: "blue" | "red"
  ): boolean {
    const inGameName = player.getInGameName();
    if (teamColor === "blue") {
      return GameData.getBluePlayers().includes(inGameName);
    } else {
      return GameData.getRedPlayers().includes(inGameName);
    }
  }
}
