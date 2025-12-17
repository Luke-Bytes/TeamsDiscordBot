import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { escapeText } from "../util/Utils";
import { PermissionsUtil } from "../util/PermissionsUtil";

export default class MVPCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("mvp")
    .setDescription("Manage MVP-related actions.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("vote")
        .setDescription("Vote for the MVP of your team.")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription(
              "The username or Discord ID of the player to vote for"
            )
            .setRequired(true)
        )
    );

  name = "mvp";
  description = "Manage MVP-related actions.";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "vote") {
      const targetIdentifier = interaction.options.getString("player", true);
      const currentGame = CurrentGameManager.getCurrentGame();

      if (!currentGame.isFinished) {
        await interaction.reply({
          content: "The game is not finished yet.",
          ephemeral: true,
        });
        return;
      }

      const voterPlayer = currentGame
        .getPlayers()
        .find((p) => p.discordSnowflake === interaction.user.id);

      if (!voterPlayer) {
        await interaction.reply({
          content: "You are not part of the game and cannot vote.",
          ephemeral: true,
        });
        return;
      }

      const userTeam = this.getPlayerTeam(currentGame, voterPlayer);
      if (!userTeam) {
        await interaction.reply({
          content: "Are you on a team?",
          ephemeral: true,
        });
        return;
      }

      const requiredChannel = this.getTeamChannel(userTeam);
      if (!PermissionsUtil.isChannel(interaction, requiredChannel)) {
        await interaction.reply({
          content: `You must use this command in your team's respective channel!`,
          ephemeral: true,
        });
        return;
      }
      const strippedID = targetIdentifier.replace(/<@([^>]+)>/g, "$1");
      const targetPlayer =
        await currentGame.findPlayerByNameOrDiscord(strippedID);
      if (!targetPlayer) {
        await interaction.reply({
          content: "Player not found.",
          ephemeral: true,
        });
        return;
      }

      const targetTeam = this.getPlayerTeam(currentGame, targetPlayer);
      if (!targetTeam || targetTeam !== userTeam) {
        await interaction.reply({
          content: "You can only vote for players on your own team!",
          ephemeral: false,
        });
        return;
      }

      if (targetPlayer.captain) {
        await interaction.reply({
          content: "You cannot vote for a team captain!",
          ephemeral: true,
        });
        return;
      }

      if (targetPlayer.discordSnowflake === voterPlayer.discordSnowflake) {
        await interaction.reply({
          content: "You cannot vote for yourself!",
          ephemeral: false,
        });
        return;
      }

      const result = currentGame.voteMvp(
        interaction.user.id,
        targetPlayer.discordSnowflake
      );

      if (result.error) {
        await interaction.reply({
          content: result.error,
          ephemeral: false,
        });
      } else {
        await interaction.reply({
          content: `Your MVP vote for ${escapeText(
            targetPlayer.ignUsed ?? "Unknown Player"
          )} has been recorded! Enjoy +1 elo as a thank you for voting 🙂)`,
          ephemeral: false,
        });
      }
    }
  }

  private getPlayerTeam(
    game: { teams: Record<"RED" | "BLUE" | "UNDECIDED", unknown[]> },
    player: unknown
  ): "RED" | "BLUE" | "UNDECIDED" | null {
    for (const team of ["RED", "BLUE", "UNDECIDED"] as const) {
      if (game.teams[team].includes(player)) {
        return team;
      }
    }
    return null;
  }

  private getTeamChannel(team: "RED" | "BLUE" | "UNDECIDED"): string {
    const config = PermissionsUtil.config;
    if (team === "RED") return config.channels.redTeamChat;
    if (team === "BLUE") return config.channels.blueTeamChat;
    return "";
  }
}
