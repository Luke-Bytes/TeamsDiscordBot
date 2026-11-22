# Player-facing /ask read-only tools

These are the player-visible tools the assistant may select; players describe a question in ordinary language rather than calling tools directly. Every result is a scoped read, not permission to query the database, inspect source files or change records.

## Choosing current, historical or in-progress evidence

The function names in this document (such as `get_player_all_time_stats`) are Navi's **internal read-only lookups**, not Discord commands. Navi can call them when answering questions; users can only run registered Discord slash commands such as `/stats`, `/registered` or `/help`. Never tell a user to execute a function name or an HTTP request.

For saved bot records, Navi uses the current-season tools (with a `season` number if supplied). For REST_API archives, it uses a historical tool only when the separate history service is enabled. For a game being prepared or played, it uses `get_current_game_state`, not saved game history.

A process snapshot cannot prove a saved result, and historical REST_API data is not automatically identical to current bot data. If a result is missing, clarify source and season before concluding anything about games or wins.

## Live slash-command catalog

`get_command_catalog` reads currently registered slash command names and short descriptions directly from Discord (up to 60). This is more accurate than a guessed list, but a command's presence does not mean a member can run it. `/help`, `/help scope:organiser` and the Discord slash picker remain the authoritative way to navigate options and role/channel requirements. An unavailable or truncated response is not exhaustive.

## Caller identity and organiser names

The initial `/ask` context includes freshly verified organiser status and a server-resolved latest Minecraft IGN when available. No Discord snowflake is given to the model. The live `list_organisers` tool returns public display names of members with the FW organiser role (up to 40), not private roles or identifiers; an unavailable or truncated list must not be claimed complete. Organiser _commands_ do not become AI write tools.

## get_my_stats — my saved seasonal record

Use for “How many wins do I have?” or “What's my current Elo?” with optional `season` number; omitted means active season. Caller identity is verified from Discord, never supplied as a user ID or IGN.

Returns the linked player's wins, losses, current win/loss streaks, and Ranked Elo/rank; Relaxed has no Elo/rank. `player_not_found`, `season_not_found` and `no_stats` mean that the corresponding link, season or record was absent, not zero. Without an explicit season, the first lookup also checks up to 10 recent saved season records to provide broader context, reporting if more exist. For MVPs or a detailed breakdown, direct players to `/stats detailed:true`.

## get_player_stats — a named player's saved record

Use for “What are PlayerName's stats in season 24?” Input is an exact Minecraft `ign` of 3–16 valid characters, plus optional `season`. The current bot matches the player's latest IGN without case sensitivity, not old aliases or partial names.

Returns the same seasonal record fields as `get_my_stats`. `ambiguous_player`, `player_not_found`, `season_not_found` or `no_stats` do not justify a guessed record. When season is omitted, up to 10 saved season records are checked alongside the active one, so a player missing **current** stats can still have older stats. These are not guaranteed complete historical REST_API records. Ask to confirm the IGN if nothing matches.

## get_leaderboard — top saved seasonal players

Use for “Who's top this season?” with optional `season` and `limit` from 1–10 (default 10). Returns ordered entries with wins, losses, current win streak and Elo only for Ranked.

Ranked order is by Elo; Relaxed order is wins then largest win streak and is explicitly unranked activity, not an Elo championship. An empty list means no returned entries, not that no one has ever played. An unknown season produces `season_not_found`.

## get_all_time_leaderboard — all saved-season wins

For "best player of all time", consult the read-only cumulative wins leaderboard, then explain that most saved wins is only **one metric**. It totals wins and losses across Ranked and Relaxed saved bot seasons, not an all-time peak Elo ranking or a complete external archive. Do not claim that current Elo or highest win count objectively proves the best player.

## get_my_all_time_stats and get_player_all_time_stats — lifetime records

Use these for "How many MVPs have I earned ever?", "What is Backmobe's career win rate?", "How many games have I played across all seasons?" and detailed comparisons of a player's **saved** FW career. Self lookups bind the verified Discord caller; named lookups accept only an exact latest IGN, not a Discord ID or partial alias. These tools share the underlying saved `PlayerStats` and finished-game participation records used by `/stats detailed:true`, `/wrapped`, `/season-recap` and lifetime title calculations; they do **not** execute those commands or load a full season recap.

Returns lifetime wins/losses, games, win percentage, number of season-stat records, MVP count, captain games and wins (and captain win percentage), double-Elo wins, largest **single-season** win and loss streaks, highest **saved Ranked season rating** with season number, and date of the latest saved finished match. A per-season streak is not a guaranteed cross-season streak, and a saved season rating is not the highest mid-season Elo. If there is no saved record, say so, not "zero career games"; the separate REST_API archive is not silently merged. A lifetime total is distinct from the active season's Elo leaderboard.

## get_season_summary — the bot's season and limits

Use for “Is this season Ranked?”, “How many finished games?” or “When is rollover scheduled?” Optional `season` selects a numbered saved season; otherwise active. Returns season type, active flag, finished game count, game/month limits and scheduled or calculated deadlines.

A scheduled first rollover is distinct from an estimated calendar deadline, neither is the next game start time. `season_not_found` means no matching current-bot season record. For old REST_API-only history, prefer `get_historical_season_summary`.

## get_recent_games — recently saved results

Use for “Who won the last three finished games?” with optional `season` and `limit` 1–5 (default 5). Returns the saved finished games' end timestamps and winning teams, most recent first.

It does not return rosters, individual participation, match-by-match Elo or unsaved games. An empty result is not proof no match happened; `season_not_found` is distinct from an empty list. For an unfinished current game, use `get_current_game_state`.

## get_current_game_state — one public game snapshot

Use for “Is a game announced?”, “When is it planned?”, “How many registered?” or “Have teams been picked?” No model inputs. Returns observation time, active/lifecycle stage, scheduled start if known, current registration count/status, red/blue/undecided team counts and allocation stage.

It also reports whether start/finish was recorded in memory, and confirmed-in-memory map or minerush setting where available. “Announced” does not independently confirm sign-ups remain open; “starting”, “started”, “finished” and cleanup stages are local lifecycle observations.

A missing map or start time is unknown, not “no map” or “never scheduled”; “not confirmed” is not false. The snapshot does not verify live Discord roles, channels, messages, polls or timers, and its `finished` flag does not confirm database persistence. For saved results use `get_recent_games`.

## Historical tools — conditional access and outcomes

All tools below are offered only when the operator separately enables an approved read-only REST_API connection. They use fixed validated requests and filtered public fields. No model-chosen URL, database filter, raw document or caller identifier is accepted.

For historical responses, `not_found` means the requested record was not established; `unavailable` covers disabled service, transport, validation or safe-limit failure; `unsupported` applies to Elo outside verified Ranked history. Never silently replace any of these with zero.

## list_historical_seasons — available archive seasons

Use for “Which old seasons can I ask about?” No inputs. Returns the last 20 numbered seasons from a bounded verified listing, their type/active status, total number seen and whether the shown list was truncated.

Truncated means the displayed list is not exhaustive. If the upstream listing is too large or invalid, the result is unavailable. It cannot prove seasons absent from the response never existed.

## get_historical_player_stats — named old-season record

Use for “How many wins did PlayerName have in season 8?” Requires exact `ign` and `season`. The REST_API lookup identifies the player by current/latest IGN, not necessarily their IGN at the time of the old season.

Returns wins, losses, current and longest win/loss streaks and reported Elo only when the season is verified Ranked. Missing player, season or stats is `not_found`; errors are `unavailable`. For “my” records use `get_my_historical_stats` rather than inventing a name.

## get_my_historical_stats — authenticated old record

Use for “My stats in season 8.” Supply only required `season`; the server looks up the Discord caller's linked latest Minecraft IGN. This is the trusted self-identity path, even if the user types a different name into the question.

Returns the same filtered season statistics as `get_historical_player_stats`. A missing link or an unmatched historical record returns `not_found`, not zero, and a renamed account can make the historical lookup incomplete.

## get_historical_elo — a named Ranked Elo timeline

Use for “How did PlayerName's Elo change in Ranked season 8?” Requires `ign`, `season`; optional `limit` is 2–20 observations (default 12). The tool validates the season type before requesting Elo history.

Returns chronologically ordered latest points, total observed point count, observed high/low, first/last observed Elo and their difference. These are observations, not guaranteed true season-opening or closing Elo or a complete sequence of rated matches. Relaxed/unknown type is `unsupported`; absent history or invalid/oversized upstream data is not a zero change. A small requested point limit does not bypass upstream history safety limits.

## get_my_historical_elo — my Ranked Elo timeline

Use for “What happened to my Elo in season 8?” Supply `season` and optional `limit` 2–20; no IGN is accepted from the model. The server resolves the caller's linked current Minecraft IGN.

Returns the same observed timeline as `get_historical_elo`. A missing linked IGN or record means `not_found`; non-Ranked seasons are `unsupported`. The observed first point is not necessarily the actual 1000 season start.

## get_historical_season_summary — archived season activity

Use for “How many matches finished in historical season 8?” Requires `season`. Returns verified season type/active flag, finished count among inspected game records, record count and available earliest/latest timestamps from returned finished games.

A safe maximum of 200 game records is inspected; above that the summary is unavailable, not a partial count. The service cannot independently prove a successful bounded result covers every game; date ranges are observed dates, not definitive season boundaries.

## get_historical_comparison — named player's two seasons

Use for “Compare PlayerName in seasons 8 and 9.” Requires exact `ign` and two different `firstSeason`/`secondSeason` numbers. Returns both saved seasonal records and second-minus-first wins/losses differences.

Elo difference is supplied only when both seasons are Ranked. It compares seasonal Elo values, not chronological Elo movement. If either read fails, comparison is unavailable; do not fill a missing side with zero. For “my” comparisons, use the authenticated tool.

## get_my_historical_comparison — my two archived seasons

Use for “Compare my season 8 with 9.” Supply two distinct `firstSeason` and `secondSeason` numbers, never an IGN. The linked caller identity is resolved server-side; the underlying comparison has a fixed four-read budget.

Returns two recorded seasonal records with wins/losses differences and a Ranked-only cross-season Elo difference. If either season or the linked account cannot be verified, no complete comparison is available. It does not describe rating changes between matches.

## What /ask cannot conclude or do

An absent player record is not zero wins; an absent Elo point is not a missed match; a local finished flag is not a durable commit; a historical summary is not proof of exhaustive archives. Quote the tool's source and scope, explain unknown values and suggest the proper ordinary command when needed.

The assistant cannot choose arbitrary database queries, read raw documents or private forms, access files/source code, execute scripts, change scores/seasons/game state or independently verify Discord message delivery.
