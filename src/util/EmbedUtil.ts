import { AnniClass, Player } from "@prisma/client";
import { log } from "console";
import { TeamsGame } from "database/TeamsGame";
import { TeamsPlayer } from "database/TeamsPlayer";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { prettifyName } from "Utils";

export function createGameAnnouncementPreviewEmbed(game: TeamsGame) {
  const embed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle(`FRIENDLY WAR ANNOUNCEMENT [preview]`)
    .addFields(
      {
        name: `TIME: ${game.startTime ? `<t:${game.startTime.getTime() / 1000}:f>` : "N/A"}`,
        value: " ",
        inline: false,
      },
      {
        name: `MAP: ${game.settings.map ? game.settings.map : game.mapVoteManager ? "Voting..." : "N/A"}`,
        value: " ",
        inline: false,
      },
      {
        name: `BANNED CLASSES: ${game.settings.bannedClasses?.length === 0 ? "None" : game.settings.bannedClasses?.map((v) => prettifyName(v)).join(", ")}`,
        value: " ",
        inline: false,
      }
    );
  return { embeds: [embed] };
}

export function createIGNListEmbed(
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
        .map((v, i) => {
          return `${i + 2}. ${v}`;
        })
        .join("\n")}`,
      inline: false,
    });
  return { embeds: [embed] };
}

export function createTeamViewEmbed(game: TeamsGame) {
  const redPlayers: TeamsPlayer[] = game.getPlayersOfTeam("RED");
  const bluePlayers: TeamsPlayer[] = game.getPlayersOfTeam("BLUE");
  const bluePlayersString =
    bluePlayers.length > 0
      ? `**${bluePlayers[0]}**\n` +
        bluePlayers
          .slice(1)
          .map((player) => player.ignUsed)
          .join("\n") // Only the first player bold
      : "No players";

  const redPlayersString =
    redPlayers.length > 0
      ? `**${redPlayers[0]}**\n` +
        redPlayers
          .slice(1)
          .map((player) => player.ignUsed)
          .join("\n") // Only the first player bold
      : "No players";

  const embed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle("Teams")
    .addFields(
      { name: "🔵 Blue Team 🔵  ", value: bluePlayersString, inline: true },
      { name: "🔴 Red Team 🔴   ", value: redPlayersString, inline: true }
    );

  return { embeds: [embed], ephemeral: true };
}

export function createTeamGenerateEmbed(game: TeamsGame) {
  const redPlayers: TeamsPlayer[] = game.getPlayersOfTeam("RED");
  const bluePlayers: TeamsPlayer[] = game.getPlayersOfTeam("BLUE");

  const bluePlayersString =
    bluePlayers.length > 0
      ? `**${bluePlayers[0]}**\n` +
        bluePlayers
          .slice(1)
          .map((player) => player.ignUsed)
          .join("\n") // Only the first player bold
      : "No players";

  const redPlayersString =
    redPlayers.length > 0
      ? `**${redPlayers[0]}**\n` +
        redPlayers
          .slice(1)
          .map((player) => player.ignUsed)
          .join("\n") // Only the first player bold
      : "No players";

  const embed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle("Randomized Teams")
    .addFields(
      { name: "🔵 Blue Team 🔵  ", value: bluePlayersString, inline: true },
      { name: "🔴 Red Team 🔴   ", value: redPlayersString, inline: true }
    )
    .setFooter({ text: "Choose an action below." });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("accept")
      .setLabel("Accept!")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("reroll")
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("cancel")
      .setLabel("Cancel?")
      .setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}
