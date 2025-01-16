import { gameFeed } from "../../logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { EmbedBuilder, TextChannel } from "discord.js";

let cachedPlayerList = "";
let cachedLatePlayerList = "";
let cachedPlayerCount = 0;
let cachedLatePlayerCount = 0;

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

  if (
    regularPlayers.length !== cachedPlayerCount ||
    cachedPlayerList === "" ||
    latePlayers.length !== cachedLatePlayerCount ||
    cachedLatePlayerList === ""
  ) {
    cachedPlayerList = regularPlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    cachedLatePlayerList = latePlayers
      .map((p) => `${p.ignUsed ?? "Unknown Player"}`)
      .join("\n");

    if (cachedPlayerList.length > 4096) {
      cachedPlayerList = cachedPlayerList.slice(0, 4093) + "...";
    }

    if (cachedLatePlayerList.length > 4096) {
      cachedLatePlayerList = cachedLatePlayerList.slice(0, 4093) + "...";
    }

    cachedPlayerCount = regularPlayers.length;
    cachedLatePlayerCount = latePlayers.length;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Registered Players (${regularPlayers.length})`)
    .setColor(0x00ae86);

  if (allPlayers.length > 0) {
    embed.setDescription(`\`\`\`\n${cachedPlayerList}\n\`\`\``);
  } else {
    embed.setDescription("No players have registered yet.");
  }

  if (latePlayers.length > 0) {
    embed.addFields({
      name: `Late Signups (${latePlayers.length})`,
      value: `\`\`\`\n${cachedLatePlayerList}\n\`\`\``,
    });
  }

  if (allPlayers.length === 0) {
    embed.setDescription("No players have registered yet.");
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
