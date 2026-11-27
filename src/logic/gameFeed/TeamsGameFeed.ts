import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";
import { PlayerInstance } from "../../database/PlayerInstance";
import { EloUtil } from "../../util/EloUtil";
import { escapeIgn } from "../../util/Utils";

const createTeamsGameFeed = async (): Promise<EmbedBuilder> => {
  const game = CurrentGameManager.getCurrentGame();
  const redPlayers = game.getPlayersOfTeam("RED");
  const bluePlayers = game.getPlayersOfTeam("BLUE");
  const redCaptain = game.getCaptainOfTeam("RED");
  const blueCaptain = game.getCaptainOfTeam("BLUE");

  const formatPlayers = (
    players: PlayerInstance[],
    captain: PlayerInstance | undefined
  ): string => {
    const escapeName = (name: string): string => escapeIgn(name);

    const sortedPlayers = captain
      ? [captain, ...players.filter((player) => player !== captain)]
      : players;

    const formattedList = sortedPlayers
      .map((player) => escapeName(player.ignUsed ?? "Unknown Player"))
      .join("\n");

    return formattedList.length > 1024
      ? formattedList.slice(0, 1021) + "..."
      : formattedList;
  };

  const redPlayersList = formatPlayers(redPlayers, redCaptain);
  const bluePlayersList = formatPlayers(bluePlayers, blueCaptain);
  const redEloMean = EloUtil.calculateMeanElo(redPlayers);
  const blueEloMean = EloUtil.calculateMeanElo(bluePlayers);

  return new EmbedBuilder()
    .setTitle("Current Teams")
    .setColor(0x0099ff)
    .addFields(
      {
        name: `🔴 Red Team [${redPlayers.length}]`,
        value: redPlayersList || "No players",
      },
      {
        name: `🔵 Blue Team [${bluePlayers.length}]`,
        value: bluePlayersList || "No players",
      }
    )
    .setFooter({
      text: `Red Team: ${redEloMean}    |     Blue Team: ${blueEloMean}`,
    });
};

export const addTeamsGameFeed = async (channel: TextChannel): Promise<void> => {
  gameFeed.addFeedMessage(channel, "teamsGameFeed", createTeamsGameFeed);
};
