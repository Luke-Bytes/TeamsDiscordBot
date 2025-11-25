# 🛠️ Quick Start Wiki

Welcome to the official documentation for **Teams Bot**, a Discord bot built with TypeScript, Discord.js, and Prisma! Use this guide to navigate the bot's features, setup, and development process.

---

## 📜 Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
3. [Features](#features)
4. [Commands List](#commands-list)
5. [Installation and Setup](#installation-and-setup)
6. [Configuration](#configuration)
7. [Database Integration](#database-integration)
8. [Development Guide](#development-guide)
9. [Contributing](#contributing)
10. [Code Overview](#overview-of-how-the-code-works-internally)

---

## 🧰 Introduction

Built to simplify managing and storing 2-team game data via Discord. Effortless team generation, role assignments, and game tracking.

---

## 🚀 Getting Started

For users adding the bot to their server:

- Create a developer discord account
- Invite the bot
- Setup the bot's config

---

## 🌟 Features

- Automatic team generation with role/VC assignment.
- Elo tracking for competitive play.
- Customisable game settings.

---

## 📜 Commands List

Commands (excluding subcommands):

`/announcement` `/igns` `/leaderboards` `/register` `/role` `/stats` `/team`
`/captain` `/test` `/cleanup` `/scenario` `/registered` `/unregister`
`/restart` `/player` `/winner` `/performance` `/mvp` `/game` `/missing`
`/captainNominate` `/teamless` `/plan` `/massRegister`

---

## 🛠️ Installation and Setup

Self-hosting guide:

1. Clone the repository.
2. Install dependencies: `npm install`
3. Build project: `npm run build`
4. Configure `.env` and `config.json`.
5. Start the bot: `npm run prod` or `npm run dev`.

---

## ⚙️ Configuration

### `.env` Setup

APP_ID=<YOUR_APP_ID>
BOT_TOKEN=<YOUR_BOT_TOKEN>
PUBLIC_KEY=<YOUR_PUBLIC_KEY>
DATABASE_URL=<YOUR_MONGODB_URL>
DATABASE_BACKUP_URL=<YOUR_BACKUP_MONGODB_URL>

- `config.json` file setup.
  Elo Settings

  winEloGain - Elo points gained for a win (default: 30).
  loseEloLoss - Elo points lost for a loss (default: 15).
  mvpBonus - Additional Elo points for being voted the MVP (default: 5).
  captainBonus - Additional Elo points for being a captain (default: 5).

Roles

    blueTeamRole - Role assigned to blue team members.
    redTeamRole - Role assigned to red team members.
    captainRole - Role assigned to team captains.
    organiserRole - Role for admins.

Channels
Add the discord channel IDs from developer mode here.
registration - Players /register and /unregister
announcements - Where announcements are posted to for players to see
gameFeed - Game updates all here
teamPickingVC - Voice channel where players join and get moved from and to
teamPickingChat - Team generation embeds appear here
redTeamVC - Red team only
blueTeamVC - Blue team only
redTeamChat - Red team only
blueTeamChat - Blue team only

Developer Settings

    dev.enabled - Loads discord commands to the server set in guildID so command changes can be used instantly. Also bypasses some verification checks.
    dev.guildId: Guild ID of your test server

---

## 🗂️ Database Integration

**Data Stored:**

---

### `EloHistory`

Tracks player Elo changes:

- `id`, `playerId`, `createdAt`, `elo`, `gameId`.

---

### `Player`

Represents players:

- `id`, `elo`, `wins`, `losses`, `winStreak`, `loseStreak`.
- `biggestWinStreak`, `biggestLosingStreak`.
- `discordSnowflake`, `minecraftAccounts`, `primaryMinecraftAccount`.

---

### `Game`

Stores game details:

- `id`, `finished`, `startTime`, `endTime`, `settings`.
- `winner`, `type`, `organiser`, `host`.

---

### `GameParticipation`

Links players to games:

- `id`, `ignUsed`, `team`, `playerId`, `gameId`.

---

### `PlayerPunishment`

Records infractions (unused):

- `id`, `playerId`, `reasons`, `strikeCount`.

---

## 🖥️ Overview of How the Code Works Internally

The order of the classes discussed will roughly follow how game operation flows.

---

### TeamsBot

**Index Entry File:**

- Initializes the bot and sets up event listeners for rate limits, interactions, and messages.
- Logs into Discord, initializes channels, and loads commands.

---

### CommandHandler

**Command Management:**

- Manages a collection of bot commands.
- Registers commands globally or to a specific guild based on configuration.
- Routes commands to their respective execution logic.

**Interaction Handling:**

- Processes interaction types (slash commands, context menu commands, button presses).
- Directs interactions to appropriate handlers, logs interactions, and handles errors.

---

### AnnouncementCommand

**Announcement Creation:**

- Handles game announcements via commands.
- Configures options like time, map, banned classes, and minerushing.
- Offers previews and manages user interactions for confirmation, cancellation, or edits.

---

### GameInstance

**Singleton Design and Game State Management:**

- Maintains a single instance of game state, including settings (map, minerushing, banned classes) and progress (start/end time, announcement, reset).

**Team Management:**

- Tracks player teams (RED, BLUE, UNDECIDED).
- Manages assignments, reshuffling, and roles.
- Provides methods to add, remove, and move players between teams.

**Voting Systems:**

- Implements voting for maps, minerushing, and MVP selection.
- Handles voting events, resolves outcomes, and manages ties.

**Persistence and Integration:**

- Interfaces with the database to persist game state and player data.
- Integrates with external APIs and Discord utilities for announcements, role assignments, and channel management.

**Customization and Testing:**

- Supports test scenarios with predefined configurations and automated player setups.
- Allows dynamic configuration of teams and game settings during runtime.

---

### PlayerInstance

**Player Representation:**

- Encapsulates player data, including statistics (ELO, wins, losses), account details (Discord and Minecraft accounts), and in-game metadata (IGN, captain status).

**Database Integration:**

- Provides methods to fetch or create player records using Discord snowflakes and generate test player instances with randomised data for simulations.

**In-Memory Game Usage:**

- Maintains additional runtime attributes like the in-game name (IGN) and captain status, separate from persistent database storage.

---

### Elo

**Elo Calculation:**

- Adjusts a player's Elo based on game results, applying bonuses or penalties for wins, losses, MVP status, and captaincy using configurable values from config.json.

**Elo manipulations:**

- EloUtil class houses all methods related to elo that don't modify it like elo emojis and formatting.

---

### GameEndCleanUp

**Role and Voice Channel Cleanup:**

- Removes team roles from members and moves players back to the team-picking voice channel, ensuring server state is reset.

**Game Conclusion and Reset:**

- Announces the winning team, counts MVP votes, resets the game instance, and updates the leaderboard in the game feed channel.

**Message and Role Cleanup:**

- Clears messages in team and registration channels.
- Removes captain roles and restarts the bot to finalize the cleanup process.

---

### prismaClient

**Player Management Extensions:**

- Utility methods for managing player data, including fetching players by Discord ID or Minecraft account.
- Adds Minecraft accounts and ensures data consistency.

**Game Data Persistence:**

- Saves game state and participant data from the GameInstance to the database.
- Updates player statistics (wins, losses, streaks, etc.).
- Maintains historical records.

**Elo System Integration:**

- Updates player ELO ratings and stores Elo history for each game.
- Tracks performance and competitive ranking over time.

---

### Some quirks to note

-Internally, "teamless" players are kept in UNDECIDED array
-Player names are validated by Mojang's API, can adapt MojangAPI class to fit your user needs instead
-Logs and backups are kept for 10-14 days in their respective folders
-LatestIGN is used when presenting an account, it's updated everytime a player registers but actual internal checks done against UUID

---
