import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";
import { PlayerInstance } from "../../database/PlayerInstance";

let cachedRedPlayersList = "";
let cachedBluePlayersList = "";
let cachedRedPlayersCount = 0;
let cachedBluePlayersCount = 0;

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
    const escapeUnderscores = (name: string) => name.replace(/__/g, "\\_\\_");

    const sortedPlayers = captain
      ? [captain, ...players.filter((player) => player !== captain)]
      : players;

    const formattedList = sortedPlayers
      .map((player) => escapeUnderscores(player.ignUsed ?? "Unknown Player"))
      .join("\n");

    return formattedList.length > 1024
      ? formattedList.slice(0, 1021) + "..."
      : formattedList;
  };

  if (
    redPlayers.length !== cachedRedPlayersCount ||
    bluePlayers.length !== cachedBluePlayersCount ||
    cachedRedPlayersList === "" ||
    cachedBluePlayersList === ""
  ) {
    cachedRedPlayersList = formatPlayers(redPlayers, redCaptain);
    cachedBluePlayersList = formatPlayers(bluePlayers, blueCaptain);
    cachedRedPlayersCount = redPlayers.length;
    cachedBluePlayersCount = bluePlayers.length;
  }

  return new EmbedBuilder()
    .setTitle("Current Teams")
    .setColor(0x0099ff)
    .addFields(
      {
        name: `🔴 Red Team [${redPlayers.length}]`,
        value: cachedRedPlayersList || "No players",
      },
      {
        name: `🔵 Blue Team [${bluePlayers.length}]`,
        value: cachedBluePlayersList || "No players",
      }
    );
};

export const addTeamsGameFeed = async (channel: TextChannel): Promise<void> => {
  gameFeed.addFeedMessage(channel, "teamsGameFeed", createTeamsGameFeed);
};
