import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";

function formatPlayerList(
  players: { ignUsed?: string | null }[],
  limit: number
): string {
  const list = players.map((p) => p.ignUsed ?? "Unknown Player").join("\n");
  // The fenced code block uses eight characters of the Discord limit.
  const max = limit - 8;
  const truncated = list.length > max ? list.slice(0, max - 3) + "..." : list;
  return `\`\`\`\n${truncated}\n\`\`\``;
}

const createRegisteredPlayersFeed = async (): Promise<EmbedBuilder> => {
  const game = CurrentGameManager.getCurrentGame();
  const teams: ("UNDECIDED" | "RED" | "BLUE")[] = ["UNDECIDED", "RED", "BLUE"];
  const lateSignups = game.lateSignups;

  const allPlayers = teams.map((team) => game.getPlayersOfTeam(team)).flat();
  const regularPlayers = allPlayers.filter(
    (p) => !lateSignups.has(p.discordSnowflake)
  );
  const latePlayers = allPlayers.filter((p) =>
    lateSignups.has(p.discordSnowflake)
  );

  const embed = new EmbedBuilder()
    .setTitle(`Registered Players (${regularPlayers.length})`)
    .setColor(0x00ae86);

  if (allPlayers.length > 0) {
    embed.setDescription(formatPlayerList(regularPlayers, 4096));
  } else {
    embed.setDescription("No players have registered yet.");
  }

  if (latePlayers.length > 0) {
    embed.addFields({
      name: `Late Signups (${latePlayers.length})`,
      value: formatPlayerList(latePlayers, 1024),
    });
  }

  return embed;
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
