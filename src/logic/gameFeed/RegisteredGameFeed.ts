import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";

const createRegisteredPlayersFeed = async (): Promise<EmbedBuilder> => {
  const game = CurrentGameManager.getCurrentGame();
  const teams: ("UNDECIDED" | "RED" | "BLUE")[] = ["UNDECIDED", "RED", "BLUE"];
  const allPlayers = teams.map((team) => game.getPlayersOfTeam(team)).flat();

  const playerList = allPlayers
    .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle(`Registered Players (${allPlayers.length})`)
    .setDescription(
      allPlayers.length > 0
        ? `\`\`\`\n${playerList}\n\`\`\``
        : "No players have registered yet."
    )
    .setColor(0x00ae86);
};

export const addRegisteredPlayersFeed = async (
  channel: TextChannel
): Promise<void> => {
  gameFeed.addFeedMessage(
    channel,
    "registeredPlayers",
    createRegisteredPlayersFeed
  );
};
