import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  GuildMember,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { GameInstance } from "../database/GameInstance";
import { escapeText } from "../util/Utils";

type TeamPlans = {
  bunker?: string;
  gold?: string;
  farmer?: string;
};

const JOBS: { name: string; max: number }[] = [
  { name: "Scout", max: 2 },
  { name: "Defender", max: 3 },
  { name: "Attacker", max: 2 },
  { name: "Healer", max: 1 },
];

export default class PlanCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("plan")
    .setDescription("Manage team plans.")
    .addSubcommand((sub) =>
      sub
        .setName("make")
        .setDescription("Set a plan for your team.")
        .addStringOption((opt) =>
          opt.setName("bunker").setDescription("Bunker").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("gold").setDescription("Gold miner").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("farmer").setDescription("Farmer").setRequired(true)
        )
    );

  private plans: Record<"BLUE" | "RED", TeamPlans> = { BLUE: {}, RED: {} };

  public name = "plan";
  public description = "Automatically manage team plans.";
  public buttonIds = ["plan_confirm", "plan_randomise", "plan_reset"];

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const isBlueChannel = PermissionsUtil.isChannel(
        interaction,
        "blueTeamChat"
      );
      const isRedChannel = PermissionsUtil.isChannel(
        interaction,
        "redTeamChat"
      );
      const team = isBlueChannel ? "BLUE" : isRedChannel ? "RED" : null;
      const teamColor =
        team === "BLUE" ? "#3498db" : team === "RED" ? "#e74c3c" : null;

      if (!team) {
        await interaction.reply({
          content: "Use this command in team channels.",
          ephemeral: true,
        });
        return;
      }

      const member = interaction.member as GuildMember;
      if (
        !PermissionsUtil.hasRole(member, "captainRole") &&
        !PermissionsUtil.hasRole(member, "organiserRole")
      ) {
        await interaction.reply({
          content: "You need to be a captain or organiser to use this command.",
          ephemeral: true,
        });
        return;
      }

      const gameInstance = GameInstance.getInstance();
      const teamPlayers = gameInstance
        .getPlayersOfTeam(team)
        .map((p) => p.ignUsed ?? "Unknown");

      if (!teamPlayers.length) {
        console.warn(`No players found in ${team} team.`);
        await interaction.reply({
          content: `No players found in the ${team} team.`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.options.getSubcommand() === "make") {
        const bunker = interaction.options.getString("bunker", true);
        const gold = interaction.options.getString("gold", true);
        const farmer = interaction.options.getString("farmer", true);

        const selectedPlayers = [bunker, gold, farmer];

        const duplicatePlayers = selectedPlayers.filter(
          (player, index, self) =>
            self.findIndex((p) => p.toLowerCase() === player.toLowerCase()) !==
            index
        );
        if (duplicatePlayers.length) {
          const duplicateDisplay = [
            ...new Set(duplicatePlayers.map((p) => p.toLowerCase())),
          ]
            .map((p) => escapeText(p))
            .join(", ");
          await interaction.reply({
            content: `A player can't be assigned multiple roles!Reassign these players: ${duplicateDisplay}`,
            ephemeral: false,
          });
          return;
        }

        const invalidPlayers = selectedPlayers.filter(
          (p) =>
            !teamPlayers.some(
              (teamPlayer) => teamPlayer.toLowerCase() === p.toLowerCase()
            )
        );
        if (invalidPlayers.length) {
          const invalidDisplay = invalidPlayers
            .map((p) => escapeText(p))
            .join(", ");
          await interaction.reply({
            content: `The following players are not on your team: ${invalidDisplay}`,
            ephemeral: false,
          });
          return;
        }

        this.plans[team] = { bunker, gold, farmer };

        const remainingPlayers = teamPlayers.filter(
          (p) =>
            !selectedPlayers.some((sp) => sp.toLowerCase() === p.toLowerCase())
        );
        if (!remainingPlayers.length) {
          console.warn(`No remaining players to assign jobs.`);
          await interaction.reply({
            content: `Plan created, but no additional players are available for assignment in ${team}.`,
            ephemeral: false,
          });
          return;
        }

        const assignments = this.assignJobs(remainingPlayers);
        const displayBunker = escapeText(bunker);
        const displayGold = escapeText(gold);
        const displayFarmer = escapeText(farmer);

        const embed = new EmbedBuilder()
          .setColor(teamColor)
          .setTitle(
            `${team.charAt(0).toUpperCase() + team.slice(1).toLowerCase()} Team Plan`
          )
          .setDescription("Roles")
          .addFields({
            name: "\u200B",
            value: `**${displayBunker}** - Bunker\n**${displayGold}** - Gold\n**${displayFarmer}** - Farmer\n${assignments.join("\n")}`,
          });

        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("plan_confirm")
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("plan_randomise")
            .setLabel("Randomise")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("plan_reset")
            .setLabel("Reset")
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({ embeds: [embed], components: [buttons] });
      }
    } catch (error) {
      console.error(`Error executing plan command: ${error}`);
      await interaction.reply({
        content: "An error occurred while processing your command.",
        ephemeral: false,
      });
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    try {
      const customId = interaction.customId;
      if (!this.buttonIds.includes(customId)) return;

      const isBlueChannel = PermissionsUtil.isChannel(
        interaction,
        "blueTeamChat"
      );
      const isRedChannel = PermissionsUtil.isChannel(
        interaction,
        "redTeamChat"
      );
      const team = isBlueChannel ? "BLUE" : isRedChannel ? "RED" : null;
      const teamColor =
        team === "BLUE" ? "#3498db" : team === "RED" ? "#e74c3c" : null;

      if (!team) {
        await interaction.reply({
          content: "You can only use this button in team channels.",
          ephemeral: true,
        });
        return;
      }

      const gameInstance = GameInstance.getInstance();
      const teamPlayers = gameInstance
        .getPlayersOfTeam(team)
        .map((p) => p.ignUsed || "Unknown");

      if (customId === "plan_randomise") {
        const remainingPlayers = teamPlayers.filter(
          (p) => !Object.values(this.plans[team]).includes(p)
        );
        const assignments = this.assignJobs(remainingPlayers);
        const displayBunker = escapeText(this.plans[team].bunker ?? "none");
        const displayGold = escapeText(this.plans[team].gold ?? "none");
        const displayFarmer = escapeText(this.plans[team].farmer ?? "none");

        const embed = new EmbedBuilder()
          .setColor(teamColor)
          .setTitle(
            `${team.charAt(0).toUpperCase() + team.slice(1).toLowerCase()} Team Plan`
          )
          .setDescription("Roles")
          .addFields({
            name: "\u200B",
            value: `**${displayBunker}** - Bunker\n**${displayGold}** - Gold\n**${displayFarmer}** - Farmer\n${assignments.join("\n")}`,
          });

        await interaction.update({ embeds: [embed] });
      } else if (customId === "plan_reset") {
        this.plans[team] = {};
        await interaction.update({
          content: `Plan reset for ${team.charAt(0).toUpperCase() + team.slice(1).toLowerCase()} team.`,
          embeds: [],
          components: [],
        });
      } else if (customId === "plan_confirm") {
        await interaction.update({
          content: "Plan confirmed!",
          embeds: [],
          components: [],
        });
      }
    } catch (error) {
      console.error(`Error handling button interaction: ${error}`);
      await interaction.reply({
        content: "An error occurred while processing your interaction.",
        ephemeral: true,
      });
    }
  }

  private assignJobs(players: string[]): string[] {
    const assignments: string[] = [];
    const jobCounts: Record<string, number> = {};

    players.forEach((player) => {
      const availableJobs = JOBS.filter(
        (job) => (jobCounts[job.name] || 0) < job.max
      );
      const job =
        availableJobs[Math.floor(Math.random() * availableJobs.length)];
      if (job) {
        jobCounts[job.name] = (jobCounts[job.name] || 0) + 1;
        assignments.push(`**${escapeText(player)}** - ${job.name}`);
      }
    });

    return assignments;
  }
}
