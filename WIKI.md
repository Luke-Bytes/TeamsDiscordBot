# 🛠️ Quick Start Wiki

Welcome to the official documentation for **Teams Bot**, a Discord bot built with TypeScript, Discord.js, and Prisma! Use this guide to navigate the bot's features, setup, and development process.

For organiser diagnostics, lifecycle logs, and confirmation behaviour, see the
[operations guide](docs/operations.md).

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
- Standalone event sign-ups with configurable questions, terms, and reserves.

---

## 📜 Commands List

Commands (excluding subcommands):

`/announcement` `/igns` `/leaderboards` `/register` `/role` `/stats` `/team` `/season`
`/captain` `/test` `/cleanup` `/debug-scenario` `/registered` `/unregister`
`/restart` `/player` `/winner` `/performance` `/mvp` `/game` `/missing`
`/captainNominate` `/teamless` `/plan` `/massRegister` `/name` `/modcheck` `/shotbow`

Friendly Wars: `/game scenario guide` browses scenarios, and `/game scenario open` recovers your private action.

### Shotbow server status

Use `/shotbow` to publicly check the Java server at `play.shotbow.net` and its connected player count, including populated MineZ, SMASH, Annihilation, GG, Slaughter and Ghostcraft modes. No parameters or registration are required. Results are cached for 30 seconds; unavailable status means the check failed, not necessarily that Shotbow is offline. The command uses Crafty's ping API with the optional existing `CRAFTY_API_TOKEN` and Shotbow's official server list for player counts. If the official list reports connected players but the ping fails, the command reports the network as online according to Shotbow, with a separate login-address warning. An unsuccessful status check does not prove a DNS issue or that new players cannot connect. Failed API requests are logged without credentials or raw provider responses. The Minecraft services section uses MCPing's session, Xbox and Minecraft API reports, plus credential-free direct checks of Mojang's session verification and Minecraft's public keys endpoints. These checks are cached independently for 60 seconds and do not perform an actual login; unavailable or conflicting evidence is shown separately from Shotbow's own status.

### Minecraft name history

Use `/name history username:<current IGN>` in the server for a public, read-only lookup of a Java account's recorded previous usernames from external providers and the Friendly Wars database. Registration is not required. Results can be incomplete; distinct names are not a count of renames. Organiser-only player-linked records are excluded from the public command; `/modcheck` provides an organiser-only moderation lookup whose result is visible in the invoking channel; use a staff channel. See [Minecraft name history](docs/minecraft-name-history.md) for configuration and privacy.

### Standalone event controls

Use `/event` to configure, open, close, and finish one-off events, inspect private
applications, and export a roster. Players use `/sign up`, `/sign edit`,
`/sign view`, and `/sign withdraw` in the configured event sign-up channel.
See the [standalone events guide](docs/events.md) for configuration, reserve
promotion rules, and the complete organiser workflow.

### Season controls

- `/season view [number]` shows season statistics.
- `/season status` shows the active type, completed games, limits, calendar
  deadline, next-type policy, pending rollover, and announcement retries.
- `/season configure [game-limit] [month-limit] [start] [current-type] [next-type]` is
  organiser-only. Omitted values stay unchanged; `0` clears a limit and
  `next-type:auto` restores alternating successors. The current type can only
  change before the first finished game.
  Limits always describe Ranked seasons; Relaxed uses half (30 games / 2 months
  becomes 15 games / 1 month), and the next Ranked season restores the full
  limits. Odd game limits round down, with a minimum of one game. Half a calendar
  month means halfway between the start date and the same date next month
  (clamped at month end).
  `start` schedules the first rollover, taking priority over game/month limits
  until then. Use `YYYY-MM-DD` for midnight UTC, or an ISO timestamp with an
  explicit timezone, e.g. `2026-11-13T18:00:00Z`. The date must be in the future;
  `start:off` clears it. The schedule persists across restarts; an overdue
  schedule runs on startup, waiting if a game is active. It is consumed by the
  first rollover, and successor seasons then use their game/month limits from
  their actual start time. `current-type` still changes the current season
  immediately; use `next-type` to choose the type that starts on the scheduled date.
  For example, `/season configure start:2026-11-13 game-limit:30 month-limit:2 next-type:RELAXED`
  schedules the first rollover for Friday 13 November at
  midnight UTC, followed by a Relaxed season of up to 15 games or 1 month.
- `/season end [next-type]` confirms a manual close and complete rollover.
- `/season start [type] [number]` confirms initial bootstrap and is rejected
  while a season is active.

Automatic rollover uses the first game or calendar-month limit reached. A
deadline reached during an announced game is deferred until that game is
saved. Closure and Discord delivery are recoverable after restart. The
`/scripts titles-update` command remains only as an explicit title repair; old
season activation scripts are retired.

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

Game-announcement pre-flight:

- Organisers can run `/announce check` at any time to inspect the configured game channels and team roles without changing permissions.
- Confirming an `/announce start` preview automatically checks channel permissions **before** posting or pinging. All pre-flight results are advisory: the announcement proceeds even if permissions are wrong or the check cannot finish, and the organiser receives a private warning to review/fix the setup. Actual Discord send failures can still prevent delivery.
- Red/blue chats and voice channels must be private from `@everyone` and the opposing team. Each team's role must be able to use its own channels. Additional role/member allows (other than the organiser role or the bot's own managed role) are flagged because they can bypass team isolation.
- The audit also checks the common game channels, channel types/IDs, the bot's posting/voice permissions, and duplicate destinations. If configured, event sign-ups and the temporary voice category are inspected too; bot access issues in these optional features are warnings.
- The configured **Game Notify** role is checked independently: it must not view either team chat or join either private team voice channel, even if `@everyone` is denied. The notification role must also be distinct from team and organiser roles, and must not have Administrator.
- Fix permissions manually in Discord and optionally re-run `/announce check`; the organiser does not need to fix warnings before confirming the announcement.
- Administrator permissions inherently bypass channel privacy, and members with multiple roles may have access to both teams. The audit does not override Discord administrators or auto-repair channel settings.

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
- Configures options like time, map, banned classes, and modifiers (includes minerushing).
- Offers previews and manages user interactions for confirmation, cancellation, or edits.

---

### GameInstance

**Singleton Design and Game State Management:**

- Maintains a single instance of game state, including settings (map, modifiers such as minerushing, banned classes) and progress (start/end time, announcement, reset).

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

### /recover-game (emergency, organiser-only)

Use `/recover-game` only when a match is still in progress but the bot lost
its in-memory state after an unexpected process failure. Planned `/restart`
recovery uses a separate snapshot mechanism and should take priority.

1. Set **phase** to `announced`, `teams` (teams picked, not started), or
   `started`. If needed, supply `announcement_link`, `registered_link`,
   and `teams_link` using links to the bot's original Discord messages.
2. The command searches configured channels for the latest matching announcement,
   registered-players feed, and current-teams/draft embed, then resolves IGNs
   to existing player records and active-season stats. It **never creates
   player records** as a side effect.
3. If the announcement was posted outside configured channels and cannot be
   discovered, provide `start_time` (ISO 8601 with timezone, e.g.
   `2026-11-20T22:00:00Z`), `map`, `banned_classes` (or `none`),
   `modifiers` (or `none`) and `double_elo`. `organiser_name` and
   `host_name` are strongly recommended. If there is no draft embed,
   `selection_method` must be supplied for teams that have been finalised.
   Optional `red_captain` and `blue_captain` override inferred captains.
4. Inspect the private preview including both teams, unassigned registrations,
   captain assignments, settings, and evidence links. Only the requesting
   organiser can confirm, within five minutes. Nothing is changed before confirmation.

Safety: recovery refuses to overwrite an active game, bypass an unresolved
snapshot/DB cleanup, recover an already persisted game at the same scheduled
time, or restore a period with game-end/MVP voting evidence. Confirmation
rechecks Discord evidence, player stats and DB safety before installing state.
The recovery does **not** resend announcements, alter Discord roles/VCs, restart
timers/polls/drafts/feeds or reconstruct MVP votes and historical draft slots.
Review `/team list` and `/game diagnostics` after recovery. A second
unexpected crash will still lose this manually reconstructed in-memory state.

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

### Correcting the latest saved roster

`scripts/fix-last-game-teams.ts` supports `--move Player=RED|BLUE`,
`--remove Player`, and `--add Player=RED|BLUE`. Additions must be existing
registered players absent from the saved game. Identify them by latest IGN
(case-insensitive), Discord ID, or player ID; use an ID if names are ambiguous.

For example, from the repository root:

```bash
npx tsx scripts/fix-last-game-teams.ts --add Adlys=RED --add DantePeulis=RED --add ALLDOWN=RED
```

This previews the latest finished game in the active season. Add `--apply`
and answer `yes` to commit the reviewed changes. Use `--season N` to select
a season explicitly. Legacy rated games without a stored double-Elo flag
also require `--double-elo yes|no`.

Additions receive no MVP, captain, or voting bonuses. The correction rebuilds
results and streaks from prior games, recalculates the whole corrected roster's
Elo using the current configured formula, and creates missing seasonal stats
only when there are no prior games. Unrated games count wins/losses without
awarding Elo. The saved winner and rating remain unchanged. Unsafe history,
unrelated stat changes, and changes since preview prevent application.
