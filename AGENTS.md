**Purpose**

- Provide AI agents with full, actionable context to read, modify, extend, and test this Discord teams bot safely without risking data loss or side effects.

**Quick Facts**

- **Runtime**: Node.js 18+, TypeScript, Discord.js v14, esbuild bundling.
- **DB**: Prisma with MongoDB provider (see `prisma/schema.prisma`).
- **Entry**: `src/main.ts` -> `src/TeamsBot.ts`.
- **Commands**: Slash/context commands in `src/commands` managed by `CommandHandler`.
- **Tests**: Lightweight custom runner in `tests` (no real DB required; Prisma is stubbed).
- **Config**: `.env` + `config.json` (sample files provided).
- **ABSOLUTE RULE**: Never execute anything in `scripts/` (see Guardrails).

**Repo Layout**

- `src/main.ts`: Boots `TeamsBot`.
- `src/TeamsBot.ts`: Discord client init, handlers, command registration, maintenance tasks.
- `src/commands/`: All slash/context commands and `CommandHandler.ts`.
- `src/interactions/`: Message, reaction, and voice handlers.
- `src/logic/`: Game logic (Elo, voting, feeds, team picking, current game manager).
- `src/database/`: `GameInstance` (in‑memory game state) and `prismaClient` (Prisma extensions).
- `src/util/`: Utilities (Discord helpers, permissions, logging, scheduling, Prisma helpers).
- `src/Channels.ts`: Resolves configured channel IDs to usable Discord channel references.
- `prisma/schema.prisma`: MongoDB schema (Season, Player, Game, EloHistory, etc.).
- `tests/`: Unit/integration-style tests with an in-repo runner and stubs.
- `README.md` / `WIKI.md`: User and system documentation overview.
- `scripts/`: Deployment/maintenance helpers (dangerous; do not run).

**Runtime & Config**

- `.env` (see `env.sample`): `APP_ID`, `BOT_TOKEN`, `PUBLIC_KEY`, `DATABASE_URL`, `DATABASE_BACKUP_URL`.
- `config.json` (see `config.sample.json`):
  - **season** and Elo bonuses/multipliers.
  - **roles**: `blueTeamRole`, `redTeamRole`, `captainRole`, `organiserRole`.
  - **channels**: `registration`, `announcements`, `gameFeed`, `botCommands`, `teamPickingVC`, `teamPickingChat`, `redTeamVC`, `blueTeamVC`, `redTeamChat`, `blueTeamChat`.
  - **dev**: `{ enabled, guildId }` — dev mode registers commands to a single guild and bypasses some checks.

**Core Architecture**

- `TeamsBot`:
  - Creates Discord client with intents, logs lifecycle, and starts handlers.
  - On `ready`: loads and registers commands, starts maintenance logging, updates punishments via `PrismaUtils`, sets presence to current season.
  - Routes `interactionCreate` to `CommandHandler` and forwards messages to team-picking sessions when active.
- `CommandHandler`:
  - Constructs command instances and aggregates them into `this.commands`.
  - `loadCommands()` gathers all commands; `registerCommands()` deploys them (guild‑scoped if `dev.enabled`, otherwise global).
  - `handleInteraction()` dispatches slash, context-menu, and button interactions to the appropriate command.
- `CurrentGameManager` + `GameInstance`:
  - `GameInstance` is a singleton in‑memory wrapper for a game: settings, teams (RED/BLUE/UNDECIDED), captain nominations/bans, votes, MVPs, timestamps, etc.
  - `CurrentGameManager` provides lifecycle utilities: scheduling poll close, class ban timers, cancelling/resetting games, and enforcing deadlines.
- `prismaClient` (extended):
  - Adds helpers (e.g., `player.byDiscordSnowflake`, `player.byMinecraftAccount`, `player.addMcAccount`, `player.getPlayerStatsForCurrentSeason`).
  - `game.saveGameFromInstance(gameInstance)`: Persists a finished game, participants, and Elo history, updating seasonal player stats.
- `DiscordUtil` and `Channels`:
  - Safe wrappers for replies/edits, role assignment/removal, voice moves, channel message cleanup, and targeted channel messaging using configured IDs.
- Other logic:
  - Voting managers (maps/minerush), Elo rules (`logic/Elo.ts`, `util/EloUtil.ts`), modifier selection, and game feed messages.

**Commands**

- Location: `src/commands`. Each command implements `Command` (see `CommandInterface.ts`).
- Shape: `data` (Slash/Context builder), `name`, `description`, `buttonIds`, `execute()`, optional `handleButtonPress()`.
- Registration: Instantiated and added in `CommandHandler.loadCommands()`.
- Permissions/Context:
  - Channel/role checks via `PermissionsUtil` (e.g., `isChannel`, `hasRole`, `isUserAuthorised`).
  - Dev mode gating: `PermissionsUtil.isDebugEnabled()` with `config.dev.guildId`.
- Examples: `RegisterCommand`, `TeamCommand`, `AnnouncementCommand`, `WinnerCommand`, etc.

**Game Lifecycle (Typical)**

- Announce: Organiser uses `/announcement` to set map/time/options. Map poll may start.
- Registration: Players `/register` (IGN validated via `MojangAPI` when possible). Players are placed into `UNDECIDED`.
- Team Picking: Random or draft teams (team sessions via `TeamCommand` and `logic/teams/*`). Captains, bans, and modifiers configured as needed.
- Start: Voting windows close automatically; class bans enforced/summarised. Roles and VCs updated. Game runs.
- End: Organiser reports `/winner`, MVP votes counted, Elo updated and saved via `prismaClient.game.saveGameFromInstance()`.
- Cleanup: Messages/roles/VCs cleaned; feeds updated; game state reset (`GameEndCleanUp` and `CurrentGameManager.resetCurrentGame()`).

**Database Model (Prisma/MongoDB)**

- `Season`: Seasons with `number`, active flag, relations to games, stats, and history.
- `Player`: Discord link, Minecraft accounts (UUIDs) + `latestIGN`.
- `PlayerStats`: Per‑season Elo/wins/losses/streaks; unique per (player, season).
- `Game`: Finished flag, times, settings (map/minerush/modifiers/banned classes), winner, organiser/host, participants.
- `GameParticipation`: Per‑game player record (team, IGN used, MVP, captain).
- `EloHistory`: Elo checkpoints per game per player per season.
- Enums: `Team`, `gameType`, `AnniClass`, `AnniMap`.

**Testing**

- Runner: `npm run tests` executes `tests/run-tests.js`, bundling `tests/run.ts` with esbuild.
- Framework: Minimal test harness in `tests/framework` (register with `test()`, run with `runAll()`).
- Isolation: Tests stub Prisma and Mojang API calls in-memory; no real DB or network required.
- Scope: Critical flows (`tests/critical/*`) and scenario cases (`tests/cases/*`).

**Development Tips**

- Build: `npm run build` (runs `prisma generate` and bundles to `dist/main.js`).
- Dev: `npm run dev` (tsx watch). Prod: `npm run prod`.
- Command Deployment: With `config.dev.enabled=true`, commands register to `config.dev.guildId` immediately; otherwise registered globally (slower to propagate).
- Channels: Call `Channels.initChannels(client)` after login (main bot does this) to resolve configured channel IDs.

**Extension Points**

- Add a command:
  - Create `src/commands/MyCommand.ts` implementing `Command`.
  - Add to `CommandHandler`: instantiate and include in `loadCommands()` and expose via a stable `name`.
  - Use `PermissionsUtil` to enforce organiser/channel constraints.
  - If using buttons, push IDs into `buttonIds` and implement `handleButtonPress()`.
- Persist new game data:
  - Prefer extending `prismaClient` with model helpers and build from `game.saveGameFromInstance()` conventions.
- Game flow:
  - Modify `CurrentGameManager`/`GameInstance` for lifecycle and state; keep `reset()` idempotent and side‑effect aware.

**Operational Guardrails**

- Do not execute anything in `scripts/`. These scripts manage prod processes, logs, DB backups and rewrites, apply backups, recalculate Elo, or mutate live game data. Examples: `scripts/db-backups.js`, `scripts/apply-backup.ts`, `scripts/recalculate-seasons-elo.ts`, `scripts/revert-last-game.ts`, `scripts/manage-season.js`, `scripts/save-to-season.js`, `scripts/change-user-account.ts`, `scripts/dev-runner.js`, `scripts/tail-logs.js`.
- Never post or log secrets (tokens, DB URLs). Avoid network calls in tests.
- When registering commands globally, be aware of Discord propagation delays (minutes). Prefer dev mode for iterative work.
- Avoid destructive data changes; prefer extending `prismaClient` helpers for transactional safety.

**Safe Commands For Agents**

- Read/Inspect: View source files under `src`, `tests`, `prisma`, `README.md`, `WIKI.md`.
- Build Lint Format: `npm run build`, `npm run lint`, `npm run format`.
- Tests: `npm run tests` (offline, self-contained).
- Do not run: Anything in `scripts/` or any command that mutates remote data or production processes.

**Troubleshooting Notes**

- If tests fail due to imports, ensure TypeScript paths and Node target (`node18`) align with `tsconfig.json` and esbuild settings in `tests/run-tests.js`.
- If Discord interactions don’t route, verify `CommandHandler.loadCommands()` includes the new command and `name` matches the slash command name.
- If Prisma errors appear in local dev, confirm `DATABASE_URL` is set or that tests properly stub `prismaClient` methods.

**Package Scripts**

- `npm run build`: Generates Prisma client and bundles TS → `dist`. Run after significant changes to ensure the codebase compiles.
- `npm run dev`: Starts the bot via `tsx` in watch mode for rapid iteration (local/dev use).
- `npm run prod`: Builds and then starts the compiled bot from `dist`.
- `npm run lint`: Runs Prettier first and then ESLint with project rules. Fix with small, focused edits.
- `npm run format`: Applies Prettier formatting across the repo (also covered by `npm run lint`).
- `npm run tests`: Bundles and runs the test suite offline. Use to validate flows before/after changes.
- PM2 helpers: `npm run prod:pm2`, `npm run dev:pm2`, and `stop:*` scripts; for deployment contexts only.
- Scripts in `scripts/`: backup/log/rebuild tasks — do not run without explicit instruction.

**Package Scripts**

- `npm run build`: Generates Prisma client and bundles TS → `dist`. Run after significant changes to ensure the codebase compiles.
- `npm run dev`: Starts the bot via `tsx` in watch mode for rapid iteration (local/dev use).
- `npm run prod`: Builds and then starts the compiled bot from `dist`.
- `npm run format`: Applies Prettier formatting across the repo; pair with lint to keep style consistent.
- `npm run lint`: Runs ESLint with project rules (Prettier enforced). Fix with small, focused edits.
- `npm run tests`: Bundles and runs the test suite offline. Use to validate flows before/after changes.
- PM2 helpers: `npm run prod:pm2`, `npm run dev:pm2`, and `stop:*` scripts; for deployment contexts only.
- Scripts in `scripts/`: backup/log/rebuild tasks — do not run without explicit instruction.

**References**

- Entry and bootstrap: `src/main.ts`, `src/TeamsBot.ts`
- Commands: `src/commands/*`, `src/commands/CommandInterface.ts`, `src/commands/CommandHandler.ts`
- Game runtime: `src/database/GameInstance.ts`, `src/logic/CurrentGameManager.ts`
- DB schema: `prisma/schema.prisma`, extensions in `src/database/prismaClient.ts`
- Utilities: `src/util/*`, channels in `src/Channels.ts`
- Docs: `README.md`, `WIKI.md`

**Utilities Cheat Sheet**

- `src/util/Utils.ts`:
  - `escapeText(text)`: Escapes Discord markdown (`_ * | ~ ` >`) for safe username display.
  - `formatTimestamp(date)`: Returns a Discord `<t:...>` timestamp string.
  - `formatTeamIGNs(game, team)`: Joins team player IGNs into a newline list.
  - `checkMissingPlayersInVC(guild, team, reply)`: Reports members not present in the team VC via a provided `reply` callback.
  - `randomEnum(enum)`, `getRandomAnniClass()`: Random helpers for enums/classes.
  - `withTimeout(promise, ms)`: Races a promise with a timeout.
  - `parseArgs`, `sanitizeInput`, `truncateString`, `getUserIdFromMention`, `getEnvVariable`: Misc parsing and helpers.
- `src/util/PrismaUtils.ts`:
  - `findPlayer(identifier)`: Resolves a player by Discord snowflake, mention, or case-insensitive `latestIGN`.
  - `getPlayerData(identifier, fields[])`: Convenience select wrapper after `findPlayer`.
  - `updatePunishmentsForExpiry()`: Clears `punishmentExpiry` for entries expiring today; returns count updated.
- `src/util/PermissionsUtil.ts`:
  - `isChannel(source, channelKeyOrId)`: Validates channel context (supports config keys or raw IDs).
  - `hasRole(member, roleKeyOrId)`: Checks guild member roles by config key or raw ID.
  - `isSameUser(interaction, targetUserId)`: Compares invoking user to a target ID.
  - `isDebugEnabled()`: Returns `config.dev.enabled` flag.
  - `isUserAuthorised(interaction)`: Ensures organiser role and guild context; replies with errors and returns boolean.
- `src/util/DiscordUtil.ts`:
  - `reply(interaction, content, ephemeral)`, `editReply(interaction, content)`: Safe interaction responses.
  - `assignRole(member, roleId)`, `removeRole(member, roleId)`: Role management with logging and error handling.
  - `moveToVC(guild, vcId, roleId, snowflake)`: Moves a single member to a VC if they have the specified role.
  - `sendMessage(channelKey, content)`: Sends to a configured text channel (via `Channels`).
  - `getChannelKeyById(id)`: Maps a channel ID back to a `Channels` key when available.
  - `removeRoleFromMembers`/`batchRemoveRoleFromMembers`: Remove a role from members (optionally batched with delays).
  - `moveMembersToChannel`/`batchMoveMembersToChannel`: Move members between VCs (optionally batched with delays).
  - `cleanUpAllChannelMessages(guild, channelIds, messageAgeDays)`: Clears recent (bulk delete) and older messages safely.

**Code Style**

- TypeScript and Linting

  - `tsconfig.json`: strict TypeScript (`strict: true`), CommonJS modules, `esModuleInterop: true`, JSON module resolution enabled. Keep code portable (no absolute paths) and case-consistent.
  - `eslint.config.mjs`: Prettier enforced as an error; base JS + TypeScript rules; import rules require proper resolution and forbid absolute paths. In tests, some rules are relaxed (no-explicit-any, unused-vars, import resolution) for pragmatism.
  - Prefer explicit types and interfaces; avoid `any`. If an `any` is necessary (e.g., third‑party types), constrain its scope and add a follow‑up TODO. Tests may use `any` freely per config.
  - Imports: do not include extensions for TS/JS files; no absolute paths; rely on the configured resolver.
  - Empty catch/blocks: avoid silent no-ops. If intentionally ignoring, add a no-op like `void e;` or a short comment to satisfy `no-empty` without noise.
  - Unused vars: remove them or prefix with `_` to satisfy lint rules.
  - Formatting: run Prettier; do not fight the formatter. Keep single-responsibility functions and small modules.

- Error Handling and Logging

  - Fail fast with helpful messages; keep logs consistent via the existing logger where possible.
  - When a failure is acceptable (cleanup/teardown), swallow safely with `void e` and a comment. Otherwise, log at the proper level.

- Reusability and Composition

  - Put reusable helpers in `src/util/*`; do not duplicate logic. Examples: `escapeText`, channel and role checks, timestamp formatters.
  - Use `PrismaUtils` for player lookups and small DB helpers; centralise common selectors and updates.
  - Keep commands thin: parse, validate, authorise, then delegate to logic/utilities.
  - Prefer pure functions for formatting (embeds, strings) and unit-test them where possible.

- Command and Interaction Patterns

  - Implement `Command` interface; keep `data` definition close to the command logic.
  - Use `PermissionsUtil` for channel and role enforcement, `DiscordUtil` for replies/edits/role moves, and `Channels` for pre-fetched channel references.
  - Escape all user-visible identifiers with `escapeText` (usernames, IGNs) to avoid Markdown mishaps. Do not escape internally used values.

- Testing
  - Use the in-repo runner (`npm run tests`). Tests stub Prisma and external APIs; no network.
  - Prefer targeted tests that exercise just-changed logic; then broader e2e as confidence grows.
  - For Discord interactions, use the mocks under `tests/framework` (e.g., `FakeGuild`, `createChatInputInteraction`).
  - Don’t assume a real guild or network; tests should run offline and deterministically.
