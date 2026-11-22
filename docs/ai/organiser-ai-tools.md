# Organiser-facing /ask diagnostic tools

These additional reads are available only to a freshly verified organiser. They expose filtered operational observations, never private logs, database documents, Discord form answers, raw identifiers or actions. The assistant must not start, end, reset, recover or modify a game.

## get_current_game_state — organiser snapshot

Use for “What state is the current game in?” or “What may be stopping start?” No model inputs. The same read as the player snapshot supplies lifecycle, scheduled start, registration, teams, match flags and known settings; an authorised organiser also receives in-memory operational details.

Extra details cover lifecycle substage, paused-workflow count, whether teams appear playable, team-picking method, captain assignment, session presence, class-ban progress, poll references, timer-handle presence, readiness suggestions, recovery block and explicit persistence/external-cleanup uncertainty. The snapshot observes one process at one moment; it is not a live Discord or durable database audit.

## get_game_diagnostics — same operational snapshot

Use for “Are there pending class bans or a blocked recovery?” and specific troubleshooting requests. This organiser-only, no-input tool returns the same organiser process snapshot as `get_current_game_state`, not a second independent diagnosis.

Prefer a single `get_current_game_state` for broad state questions rather than repeatedly calling both. For a guided ordinary command view, recommend the read-only `/game diagnostics`. If the tool or membership check fails, say diagnostics were not verified rather than assuming the game is safe to start.

## get_game_roster — current rosters, captains, class bans and draft

For roster, eligibility, captain, replacement, class-ban, draft, MVP and winner questions, this verified-organiser-only read returns the current RED/BLUE/UNDECIDED latest IGNs (up to 24 entries, with explicit truncation), registered IGN differences, captain status, live or paused draft progress, captain ban counts/window locks, classes recorded in memory, and selected result fields. All these are process-memory facts. Do not confuse a draft's proposed list with committed teams or a recorded winner with a saved result.

## get_game_discord_state — targeted external Discord inspection

For voice/role problems, focus:players checks up to 16 assigned players by fresh targeted Discord member REST reads and reports expected/opposite team roles. The voice-location column comes from the gateway cache, **not** an independently fetched voice audit; a missing cache entry is unknown. An optional targetIGN must exactly match a currently assigned roster member and limits the check to them. No guild-wide scan or arbitrary lookup is allowed.

For map/minerush polls, focus:polls checks the bot's known poll message references in the configured announcement channel. For publish trouble, focus:announcement similarly checks announcement references. A successful REST lookup means the message exists now, not that it opened on schedule or the poll closed; missing references are not proof of non-delivery, and inaccessible lookups stay unavailable. These are all read-only, bounded checks.

## get_game_persistence — exact current match checkpoint

For shutdown, saved result and cleanup uncertainty, this verified-organiser-only tool looks up **only the process-bound current match identity** in the database and returns a saved-result fingerprint/finished flag and cleanup checkpoint: PENDING, COMPLETE or unrecorded. No raw ID or database document is exposed. COMPLETE means the application stored its cleanup checkpoint, not an independent external cleanup audit. No record found at observation time does not prove a failed/rolled-back transaction; the database may still be changing. If the process has lost its match identity, the answer is unverified. Never advise retrying shutdown or starting another game merely because a record is absent.

## get_organiser_status — saved season and announcement queue

Use for “How far along is the active season?” or “How many announcements are pending?” No inputs. Unlike game snapshots, this reads active season status from saved records: type, active flag, finished-game count, game/month limits, scheduled first rollover, deadline and pending announcement block count.

A configured scheduled rollover differs from a computed/estimated deadline; neither is a match start time. Pending announcements represent retryable blocks, not a count of confirmed deliveries or evidence that season activation failed. This result does not report individual delivery status or the detailed rollover workflow. If no active season can be read, that is a failed read, not zero games. For fuller rollover state use the normal `/season status` command.

## Lifecycle and team allocation interpretation

`inactive` means this process has no announced game; `announced` means preparation may be underway; `starting` is an in-progress transition; `started` and `finished` are process-local stage markers. `awaiting cleanup or shutdown` signals pending or uncertain end processing, not completion.

Registered players, red/blue/undecided counts and team stage are current memory totals. `playable` means the remembered teams meet the bot's final-allocation check, not that every player has the correct live Discord role or voice location. Picking-session presence is not proof its workflow finished.

## Readiness checks are advisory, not permission to proceed

`startConditionsInMemory` checks whether a game is announced, teams appear playable, no active picking session is seen and recovery is not blocking. It does not prove class bans are resolved, all players are present, Discord changes will work or a command will succeed.

`startCompletion` describes an in-memory transition only. Class-ban readiness and recorded captain bans are local data; a missing captain can yield an unknown count, not zero bans. Use suggested next checks as prompts for normal verified commands, not as authorisation for AI action.

## Poll references and timer handles

Map/minerush manager presence or a saved poll-message reference says only that a local object or reference exists. The reported poll-open state is **unverified**: it cannot establish whether the Discord poll is visible, accepting votes or closed.

A warning, deadline, reminder, captain-selection or draft timer handle says only that this process holds a handle; it does not prove a callback will execute, has fired or survived restart. Do not infer missing handles imply the corresponding operation never happened.

## Recovery, finishing and persistent state

`recoveryBlocked` reports a local recovery gate at observation time. If true, advise against retrying lifecycle actions and escalate to the trusted operator. If false, that alone is not clearance to perform a risky retry; previous Discord or database effects might still need checking.

A local `finished` or `end recorded in memory` state does **not** prove the match was durably saved. `persistence: unknown` means no database check was done. Cleanup status, Discord roles/voice moves and message delivery remain unverified. Do not assert commit, rollback or successful external cleanup without independent authorised evidence.

## Distinguish operational reads from saved-match reads

For what the process currently remembers, use `get_current_game_state` or `get_game_diagnostics` once. For committed seasonal finished-game totals and pending announcement blocks, use `get_organiser_status` or the ordinary `/season status`; for latest saved winners use `get_recent_games`.

For old REST_API seasons, use the separately enabled historical tools; their bounded game scans and observed Elo points cannot verify the current live match. An unavailable read, unknown value, absent poll, missing seasonal record or local flag must never be silently turned into a false or zero.

## Tool access and safe escalation

Organiser rights are rechecked for each read; the tool takes no permission flag, arbitrary query, account identifier or executable instruction from the model. If the game is blocked, persistence is uncertain, or Discord delivery cannot be checked, guide the organiser to approved read-only commands and the human operator's recovery process.

The assistant cannot run scripts or shell commands, browse project files, inspect private sign-ups, query raw databases, repair season stats, verify live Discord state by implication or issue game-changing commands. Report exactly what the snapshot establishes and what remains unknown.
