# Operations guide

Operator reference for diagnosing games, finding lifecycle logs, and handling command confirmations. For setup and command usage, see the [README](../README.md) and [wiki](../WIKI.md).

## Organiser diagnostics

Run `/game diagnostics` as an organiser. The response is ephemeral, read-only, and uses the existing in-memory game, team-picking session, timer handles, and recovery gates. It does **not** query the database, fetch Discord messages, or run scheduled tasks.

- Lifecycle reports announced, starting, started, finished, and awaiting shutdown/cleanup when known. The correlation ID is the current game ID or lifecycle token.
- Player/team counts, captain readiness, last selected map/minerush setting, class-ban counts, and scheduled timer presence come from current managers.
- A poll manager with a message reference does **not** prove a poll is currently open. Open/closed vote status is deliberately labelled unknown rather than inferred.
- A blocked recovery gate is reported, but the raw reason is not echoed into Discord. Inspect server logs for details.
- Persistence/cleanup status is deliberately labelled unknown unless shutdown is currently in progress. Determining the exact DB checkpoint would require an extra query and could create a misleading result during an in-flight operation. Check durable match state manually before restarting an uncertain operation.

## Searchable operational logs

Lifecycle and maintenance events are written through `console.info`, `console.warn`, or `console.error` with `key=value` fields. Inspect the bot process output or your process manager’s captured logs. These calls do not pass through the Winston rotating file transport. Search by `event=` and correlate by `game=` (game ID or lifecycle token) when present.

| Event                                                            | Typical fields                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `game.announcement`                                              | `game`, `outcome=started/succeeded`, `duration_ms`                                        |
| `game.start`                                                     | `game`, `outcome=started/succeeded/skipped/failed`, `reason`, `duration_ms`, `error_type` |
| `game.voice.assign`, `game.roles.assign`                         | `game`, `outcome`, `duration_ms`, `players`                                               |
| `team.finalize`                                                  | `game`, `outcome`, `method`, `role_warnings`                                              |
| `vote.map.finalize`, `vote.minerush.finalize`                    | `game`, `outcome`, `result` or `reason`, `duration_ms`                                    |
| `match.persist`, `match.cleanup`                                 | `game`, `outcome`, `duration_ms`                                                          |
| `recovery.inspect`                                               | `outcome`, `block` and, on failure, `reason`                                              |
| `season.operation`, `scripts.titles_reconcile`, `punish.expunge` | `outcome`, operation details or `error_type`                                              |

Lower-level Discord and database failures may have separate error messages. A succeeded event describes that step; it does not establish that the entire game lifecycle completed.

## Confirmation and game-feed behaviour

Season, scripts, restart, and punishment expunge confirmations require the originating Discord message, requesting user, and current organiser permission; expiring or consumed requests are rejected. The request is consumed _before_ an irreversible or externally visible action. After a potentially partial failure, inspect state before initiating a **new** request; the original button cannot retry.

Game feeds check for updates every 20 seconds and skip edits when the embed content matches the last successful publication. Message lookup allows a missing message to be recreated. This comparison state exists only in memory and is discarded when the feed is removed or stopped; it is not a durable game checkpoint.
