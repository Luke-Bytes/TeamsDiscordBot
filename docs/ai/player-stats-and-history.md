# Player statistics, seasons and historical evidence

Use this reference for Friendly Wars results, Elo and older seasons. State which season and data source an answer uses. Do not guess missing results or treat a game still in progress as saved.

## /stats: player record and options

Run `/stats` for yourself, or set `player` to a Minecraft IGN or Discord mention to look up someone else. Set `season` for a numbered season; otherwise it uses the active season. `detailed: true` adds more breakdowns.

The basic view shows the seasonal wins, losses, win rate, current streak, and—only for Ranked—Elo and placement. The detailed view adds longest streaks, MVP and captain counts, captain win rate, double-Elo wins, most recent participation date and a computed average Elo change. This average is the difference from a 1000 starting baseline divided by wins plus losses, not a per-game Elo audit.

## /leaderboards: Ranked rating or Relaxed activity

Run `/leaderboards` to view the active season, or supply `season` for another season. Pages hold up to ten players. Ranked sorts recorded players by Elo and displays their rating and win/loss ratio.

Relaxed is an unranked activity board: records sort by wins and then largest win streak, while displayed entries show games, wins, losses and current streak. It does not identify a Ranked Elo champion. The board is limited to recorded players, not every person who ever registered.

## /season view: seasonal participation

Run `/season view` or `/season view number:<season>` for start/end dates, the number of saved finished games, distinct participants and the largest saved game. It is a season overview, not an individual's win record or a promise of future games.

A season can remain active with game-count or calendar-month limits, or a separately scheduled first rollover. These limits describe rollover policy; they do not set the next match time. A pending game can delay rollover.

## /wrapped: completed-season personal recap

Run `/wrapped` for the previous season by default, or supply `season` for a particular completed season. It uses saved seasonal records and finished-game participation to produce personal highlights such as teammates, memorable games, maps and roles where supported.

The active season cannot have a Wrapped recap. A missing recap means the required player record or completed participation was not found; it does not establish that the person never played. Recap highlights are summaries, not proof of every historical event.

## Ranked and Relaxed seasons

Ranked seasons use recorded Elo for rating and placement. Relaxed seasons still record wins, losses and streaks but have no active Elo ranking or overall Elo winner. A numerical Elo field stored elsewhere is not evidence that a Relaxed match was rated.

Season types normally alternate at rollover unless an organiser overrides the successor. Relaxed limits are derived from half the Ranked game/month limits; a separately scheduled first rollover can take priority. Do not conflate a season deadline with a game announcement.

## Which matches change Elo?

A saved result updates eligible participants' wins, losses and streaks, but only an Elo-rated match changes Elo. Relaxed matches are unrated; a Ranked match with fewer than 20 active team players at start is also marked no-Elo. The final game record, not merely an announcement or game-end flag, is the basis for saved stats.

A game can therefore appear in finished-match counts without contributing an Elo observation. Elo history is not a complete match-by-match history, and zero observed Elo movement does not imply no games.

## How a Ranked Elo change is worked out

For a rated result, the bot estimates the teams' chances from their average Elo. The player's existing rating affects how strongly the result moves their Elo: generally, a less expected win earns more and a surprising loss costs more. The change factor decreases as a player's Elo rises.

For favoured teams, the expectation may also blend team strength with that player's rating. A winning streak from the third consecutive win increases the match-gain component (with a cap). When teams' mean ratings differ by at least 25, an expectation-based weighting applies; a higher-rated player on a favoured team can take an additional loss penalty.

## Elo bonuses and double-Elo matches

A rated player can receive extra Elo for being a selected team MVP, serving as captain and casting an MVP vote. Bonuses are additive, so a loss does not guarantee a net Elo decrease. The precise result depends on the recorded match and its settings.

Double Elo multiplies the winner's match-result gain, not the loss penalty or the separate MVP, captain and MVP-vote bonuses. It does not turn Relaxed or otherwise unrated matches into rated games. Do not infer exact per-game changes solely from final ratings.

## Why statistics might not update yet

Finishing gameplay and saving the match are different steps: the post-game voting and shutdown/persistence workflow can still be pending. An in-memory `finished` state does not confirm the database transaction committed. A failed or uncertain save must not be presumed completed or rolled back.

Check the season number, whether the game actually finished, and whether its normal shutdown/save was confirmed. Ask an organiser to verify uncertain persistence by approved procedures; `/ask` cannot repair statistics or audit the database.

## Current bot records versus REST_API history

Current `/stats` and current-season AI tools read the bot's saved seasonal records; the separately enabled historical REST_API tools read another service. A numbered season in either source does not by itself prove that the records are identical or complete.

For “my” historical questions, the bot uses the caller's trusted linked Minecraft IGN. A named-player lookup uses an exact, case-insensitive current/latest IGN; renamed, unlinked or old aliases might not resolve older results. Do not infer player identity from an approximate name.

## What historical Elo observations prove

Historical Elo is reported only when the historical season is verified Ranked. Points are dated Elo observations returned for that player and season; the reported start and end are the first and last **observed** values, not guaranteed actual season-opening and season-closing ratings.

A limited Elo request returns only the newest requested points even though the reported observed extremes and change are calculated from the bounded response. The first point need not be the 1000 starting baseline, and a missing point need not mean that no match occurred.

## Comparing two historical seasons

Historical comparison reports each season's recorded wins and losses and their differences (second minus first). An Elo difference is reported only if both seasons are Ranked; it subtracts two seasonal recorded values, **not** the player's chronological rating change between dates.

Do not invent games, percentages or an Elo trajectory between seasonal records. If either season is missing or cannot be verified, the comparison is unavailable rather than a zero-filled comparison.

## Limits of historical seasons and match counts

Historical season listings show at most the latest 20 of up to 200 validated returned seasons; a `truncated` result means earlier seasons were omitted. A historical season summary inspects at most 200 game records, counts only those marked finished, and reports a date range only from available timestamps.

More than 200 returned games leads to an unavailable summary, not a partial total. Even a successful bounded scan cannot independently prove the upstream dataset is complete. Missing historical stats, Elo observations or season entries do not establish zero wins or zero games.

## Reading unavailable, missing and unsupported results

`not_found` means the requested season/player record or linked IGN could not be established; it is not a zero. `unsupported` means a historical Elo request was not valid for a verified Ranked season (including Relaxed or unknown type). `unavailable` may mean the separate service is disabled, offline, timed out, returned invalid data or exceeded a safe limit.

State the precise uncertainty and suggest a suitable ordinary command or authorised human check. Neither `/ask` nor these tools can run arbitrary database queries, read private documents, execute scripts, verify live Discord delivery or change game state.
