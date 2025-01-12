import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";

let cachedPlayerList = "";
let cachedPlayerCount = 0;

const createRegisteredPlayersFeed = async (): Promise<EmbedBuilder> => {
  const game = CurrentGameManager.getCurrentGame();
  const teams: ("UNDECIDED" | "RED" | "BLUE")[] = ["UNDECIDED", "RED", "BLUE"];
  const allPlayers = teams.map((team) => game.getPlayersOfTeam(team)).flat();

  if (allPlayers.length !== cachedPlayerCount || cachedPlayerList === "") {
    cachedPlayerList = allPlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    if (cachedPlayerList.length > 4096) {
      cachedPlayerList = cachedPlayerList.slice(0, 4093) + "...";
    }

    cachedPlayerCount = allPlayers.length;
  }

  return new EmbedBuilder()
    .setTitle(`Registered Players (${allPlayers.length})`)
    .setDescription(
      allPlayers.length > 0
        ? `\`\`\`\n${cachedPlayerList}\n\`\`\``
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
