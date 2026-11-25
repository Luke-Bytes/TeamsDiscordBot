# /ask registered-command coverage manifest

This is a QC inventory, **not** an AI knowledge source. The offline test compares every row with `CommandHandler.loadCommands()`, so newly registered commands require an explicit choice. Paths in the last column identify safe player/organiser evidence when allowlisted, or explain intentional exclusion.

- **full**: focused allowlisted user-facing how-to.
- **brief**: only a short user-facing mention or an unapproved/low-priority detailed guide; `/help` remains authoritative.
- **restricted**: restricted or risky action; only safe role/limits/escalation is allowed in `/ask`, not execution/bypass steps.
- **excluded**: developer/internal command excluded from LLM knowledge on purpose.

| Registered command | Coverage   | Safe evidence or exclusion rationale                                                            |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------- |
| `ask`              | brief      | player-guide: privacy and limitations                                                           |
| `event`            | full       | organiser-events-and-admin: draft, form, roster privacy, closure                                |
| `sign`             | full       | player-community: sign-up, reserves, edit/withdraw                                              |
| `announce`         | full       | organiser-game-ops: announcement preview and cancellation                                       |
| `igns`             | brief      | player-community: command help; organiser-only diagnostics not needed                           |
| `leaderboards`     | full       | player-stats-and-history: Ranked and Relaxed leaderboard                                        |
| `register`         | full       | player-actions: register and linked-account correction                                          |
| `need`             | full       | player-actions: replacement request                                                             |
| `stats`            | full       | player-stats-and-history: saved seasonal stats                                                  |
| `team`             | full       | player-actions: list; organiser-game-ops: generate, reset, cancel                               |
| `recover-game`     | restricted | organiser-guide: blocked recovery escalates; reconstruction procedure excluded                  |
| `captain`          | full       | organiser-game-ops: captain appointment                                                         |
| `test`             | excluded   | developer/debug utility; not player knowledge                                                   |
| `cleanup`          | excluded   | internal maintenance/debug, unsafe to surface                                                   |
| `scenario`         | excluded   | developer/debug utility                                                                         |
| `registered`       | full       | player-actions: signed-up roster                                                                |
| `unregister`       | full       | player-actions: leaving                                                                         |
| `restart`          | restricted | organiser-guide: no forced restart; operator escalation only                                    |
| `player`           | full       | organiser-game-ops: roster corrections                                                          |
| `winner`           | full       | organiser-game-ops: confirmed winner                                                            |
| `performance`      | brief      | low-priority utility; consult /help                                                             |
| `mvp`              | full       | player-actions: vote                                                                            |
| `game`             | full       | player-actions: request; organiser-game-ops: start/end/shutdown/diagnostics                     |
| `missing`          | brief      | low-priority roster utility; consult /help                                                      |
| `captainnominate`  | full       | player-actions: nominations                                                                     |
| `teamless`         | brief      | low-priority roster utility; consult /help                                                      |
| `plan`             | brief      | captain planning workflow; avoid private plans in /ask                                          |
| `massregister`     | brief      | organiser-game-ops source has bulk-add notes; not allowlisted                                   |
| `punish`           | restricted | organiser-events-and-admin: basic add/remove; expunge excluded                                  |
| `punished`         | restricted | organiser-events-and-admin: sensitive punishment read warning                                   |
| `modcheck`         | restricted | docs/moderation-review: organiser-only sensitive review; not exposed through /ask                 |
| `timestamp`        | full       | player-community: timestamp                                                                     |
| `verify`           | brief      | organiser verification, not needed for ordinary /ask                                            |
| `class`            | full       | player-actions: captain ban and view                                                            |
| `season`           | full       | player-stats-and-history: view; organiser-game-ops: status/rollover                             |
| `username`         | restricted | organiser-events-and-admin: identity review and safe correction; no AI mutation                 |
| `name`             | brief      | player-community: private name history command; no AI access to historical names                |
| `forfeit`          | full       | player-actions: confirmed captain forfeit                                                       |
| `maps`             | brief      | player-community: map list                                                                      |
| `coinflip`         | brief      | general utility; consult /help                                                                  |
| `nickname`         | full       | player-community: nickname                                                                      |
| `help`             | brief      | player-guide: available-command discovery                                                       |
| `spectate`         | full       | player-actions: request, rejoin, stop                                                           |
| `website`          | brief      | link utility; consult /help                                                                     |
| `wiki`             | brief      | player-community: wiki navigation                                                               |
| `profile`          | full       | player-community: view                                                                          |
| `profilecreate`    | full       | player-community: edit                                                                          |
| `titles`           | full       | player-community: display titles                                                                |
| `title`            | restricted | organiser-events-and-admin: title editing needs human review                                    |
| `scripts`          | restricted | Discord title-reconciliation command; executable maintenance procedures deliberately unapproved |
| `season-recap`     | brief      | publication is human-controlled; detailed workflow not allowlisted                              |
| `wrapped`          | full       | player-community: completed-season recap                                                        |
| `vc`               | full       | player-community: temporary voice channel                                                       |
| `tierlist`         | brief      | organiser-led optional workflow; not indexed due to low relevance                               |

The allowlist is intentionally smaller than the manifest. Do not make the manifest itself retrievable or add internal commands to close a coverage percentage. When a command changes, review both its documentation and this inventory.
