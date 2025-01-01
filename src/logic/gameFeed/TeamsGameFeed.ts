import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";
import { PlayerInstance } from "../../database/PlayerInstance";

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
    if (players.length === 0) return "No players";
    const sortedPlayers = captain
      ? [captain, ...players.filter((player) => player !== captain)]
      : players;
    return sortedPlayers
      .map((player) => `${player.ignUsed ?? "Unknown Player"}`)
      .join("\n");
  };

  const redPlayersList = formatPlayers(redPlayers, redCaptain);
  const bluePlayersList = formatPlayers(bluePlayers, blueCaptain);

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
    );
};

export const addTeamsGameFeed = async (channel: TextChannel): Promise<void> => {
  gameFeed.addFeedMessage(channel, "teamsGameFeed", createTeamsGameFeed);
};
