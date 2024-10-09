import { PrismaClient } from "@prisma/client";
import { GameData } from "./GameData";
import { recordPlayerDataHistory } from "database/recordPlayerDataHistory";
import { PlayerData } from "./PlayerData";

const prisma = new PrismaClient();

async function recordGameDataHistory(gameData: GameData) {
  const startTime = GameData.getStartTime();

  const existingGame = await prisma.gameHistory.findFirst({
    where: { startTime },
  });

  if (existingGame) {
    console.error("This game has already been recorded.");
    return;
  }

  const winningTeam = GameData.getGameWinner();

  if (!winningTeam) {
    console.error(
      "Game winner hasn't been set yet, cannot save game history until game has ended."
    );
    return;
  }

  const mapVotes = GameData.getMapVotes();
  const map = mapVotes.length > 0 ? mapVotes[0] : "Default Map"; // Replace with real logic to get highest vote

  const bannedClasses = GameData.getBannedClassesVotes();

  const minerushingVotes = GameData.getMinerushingVotes();
  const minerushing =
    minerushingVotes.length > 0 && minerushingVotes[0] === "yes";

  const bluePlayers = GameData.getBluePlayers();
  const redPlayers = GameData.getRedPlayers();

  const winnerTeamPlayers = winningTeam === "blue" ? bluePlayers : redPlayers;
  const loserTeamPlayers = winningTeam === "blue" ? redPlayers : bluePlayers;

  //FIXME add captain fetch logic
  const teamCaptainWinner = "CaptainA";
  const teamCaptainLoser = "CaptainB";

  const mvpVotes = GameData.getMvpVotes();
  const mvpWinner = mvpVotes.length > 0 ? mvpVotes[0] : "";
  const mvpLoser = mvpVotes.length > 1 ? mvpVotes[1] : "";

  for (const playerName of [...winnerTeamPlayers, ...loserTeamPlayers]) {
    // Use the getPlayerByInGameName method with the existing playerDataList
    const playerData = PlayerData.getPlayerByInGameName(playerName);

    if (playerData) {
      const discordUserId = playerData.getDiscordUserId();
      const discordUserName = playerData.getDiscordUserName();

      const updatedPlayerData = new PlayerData(
        discordUserId,
        discordUserName,
        playerName, // Using the in-game name as playerName
        playerData.getElo(), // Carry over existing Elo
        winnerTeamPlayers.includes(playerName) ? 1 : 0, // Wins
        loserTeamPlayers.includes(playerName) ? 1 : 0, // Losses
        playerName === teamCaptainWinner, // Is Captain
        playerName === mvpWinner // Is MVP
      );

      await recordPlayerDataHistory(updatedPlayerData);
    } else {
      console.error(`PlayerData for player ${playerName} not found.`);
    }

    // Add the startTime to playerData's datesPlayed (you can manage this as needed in PlayerData class)
    await recordPlayerDataHistory(playerData);
  }

  const game = await prisma.gameHistory.create({
    data: {
      startTime: startTime,
      map: map,
      minerushing: minerushing,
      teamColorWinner: winningTeam,
      teamCaptainWinner: teamCaptainWinner,
      mvpWinner: mvpWinner,
      teamCaptainLoser: teamCaptainLoser,
      mvpLoser: mvpLoser,
      bannedClasses: {
        create: bannedClasses.map((className) => ({ className })),
      },
      winnerTeamPlayers: {
        create: winnerTeamPlayers.map((playerName) => ({ playerName })),
      },
      loserTeamPlayers: {
        create: loserTeamPlayers.map((playerName) => ({ playerName })),
      },
    },
  });

  console.log("Game stored:", game);
  console.log("Resetting in memory data...");
  PlayerData.clearPlayerDataList();
}
