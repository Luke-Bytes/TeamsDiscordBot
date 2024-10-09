import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { PlayerData } from "../database/PlayerData";
import { GameData } from "../database/GameData";
import fs from "fs";
import { getCaptainByTeam } from "../Utils";

const configPath = "./config.json";
const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
const organiserRoleId = configData.roles.organiserRole;
const captainRoleId = configData.roles.captainRole;
const blueTeamRoleId = configData.roles.blueTeamRole;
const redTeamRoleId = configData.roles.redTeamRole;

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
              .addChoices({ name: "blue", value: "blue" }, { name: "red", value: "red" })
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
        content: "Couldn't find role data - do I need more permissions?",
        ephemeral: true,
      });
      return;
    }

    const teamColor = interaction.options.getString("team", true);
    const user = interaction.options.getUser("user", true);

    if (!member.roles.cache.has(organiserRoleId)) {
      await interaction.reply({
        content: "Only organisers can use this command!",
        ephemeral: true,
      });
      return;
    }

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

    console.log(`Setting captain for ${teamColor} team. Checking current captain...`);
    const currentTeamCaptain = getCaptainByTeam(teamColor as "blue" | "red");
    console.log(`Current ${teamColor} team captain: ${currentTeamCaptain?.getDiscordUserId() || "None"}`);

    if (currentTeamCaptain) {
      const currentCaptainMember = interaction.guild.members.cache.get(currentTeamCaptain.getDiscordUserId());
      if (currentCaptainMember) {
        console.log(`Removing captain and team role from current captain: ${currentCaptainMember.user.username}`);
        await currentCaptainMember.roles.remove(captainRoleId).catch((error) =>
          console.error(`Failed to remove captain role from current team captain: ${error}`)
        );

        const teamRoleId = teamColor === "blue" ? blueTeamRoleId : redTeamRoleId;
        await currentCaptainMember.roles.remove(teamRoleId).catch((error) =>
          console.error(`Failed to remove team role from current team captain: ${error}`)
        );

        currentTeamCaptain.setCaptain(false);
      }
    }

    const oppositeTeamColor = teamColor === "blue" ? "red" : "blue";
    const oppositeCaptain = getCaptainByTeam(oppositeTeamColor as "blue" | "red");
    if (oppositeCaptain && oppositeCaptain.getDiscordUserId() === user.id) {
      console.log(`User is captain of the opposite team (${oppositeTeamColor}), removing roles.`);
      const oppositeMember = await interaction.guild.members.fetch(user.id);
      if (oppositeMember) {
        const oppositeTeamRoleId = oppositeTeamColor === "blue" ? blueTeamRoleId : redTeamRoleId;
        await oppositeMember.roles.remove(captainRoleId).catch((error) =>
          console.error(`Failed to remove captain role from opposite team captain: ${error}`)
        );
        await oppositeMember.roles.remove(oppositeTeamRoleId).catch((error) =>
          console.error(`Failed to remove opposite team role: ${error}`)
        );
      }
    }

    const previousCaptain = getCaptainByTeam(teamColor as "blue" | "red");
    console.log(`Previous captain of the ${teamColor} team: ${previousCaptain?.getDiscordUserId() || "None"}`);

    const newCaptainMember = await interaction.guild.members.fetch(user.id);
    if (newCaptainMember) {
      console.log(`Setting new captain: ${newCaptainMember.user.username}`);

      player.setCaptain(true);

      if (teamColor === "blue" && newCaptainMember.roles.cache.has(redTeamRoleId)) {
        await newCaptainMember.roles.remove(redTeamRoleId).catch((error) =>
          console.error(`Failed to remove red team role: ${error}`)
        );
      } else if (teamColor === "red" && newCaptainMember.roles.cache.has(blueTeamRoleId)) {
        await newCaptainMember.roles.remove(blueTeamRoleId).catch((error) =>
          console.error(`Failed to remove blue team role: ${error}`)
        );
      }

      await newCaptainMember.roles.add(captainRoleId).catch((error) =>
        console.error(`Failed to add captain role: ${error}`)
      );

      const teamRoleId = teamColor === "blue" ? blueTeamRoleId : redTeamRoleId;
      await newCaptainMember.roles.add(teamRoleId).catch((error) =>
        console.error(`Failed to add team role: ${error}`)
      );

      if (teamColor === "blue") {
        GameData.setBluePlayers([...GameData.getBluePlayers(), inGameName]);
        GameData.setRedPlayers(GameData.getRedPlayers().filter(player => player !== inGameName));
      } else {
        GameData.setRedPlayers([...GameData.getRedPlayers(), inGameName]);
        GameData.setBluePlayers(GameData.getBluePlayers().filter(player => player !== inGameName));
      }

      await interaction.reply({
        content: `${user.username} has been set as the ${teamColor} team captain and given the correct role.`,
      });
    } else {
      console.error("Failed to fetch new captain member.");
      await interaction.reply({
        content: "Could not assign captain role to that player. Is the name correct?",
        ephemeral: true,
      });
    }
  }
}
