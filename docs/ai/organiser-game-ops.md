# Organiser game and season operations

For authorised organisers using Discord. `/ask` explains commands and safe checks; it cannot run commands, repair state, confirm database writes or verify Discord delivery. Use normal Discord interactions, not operator tools. Each visible status is evidence of its stated scope only.

## Announce a match: `/announce start`

Use `/announce start` with required `when`, `modifiers`, `banned_classes`, `map`, `organiser` and `host`; `doubleelo` is optional (`yes`/`no`). The date must parse as a future time. A live announcement or an existing proposal blocks another proposal; an active season is required. Double Elo is disabled in Relaxed seasons regardless of the requested value.
The command prepares a **preview**, not a published game. Review every setting before confirming.

## Announcement confirmation and edits

The preview offers **Confirm & Send (Ping)** or **(No ping)**, plus Cancel, Edit Time, Edit Map, Edit Banned Classes and modifier controls. Ping optionally mentions the configured game-notify role. Confirming publishes the announcement and prepares registration, feeds and scheduled workflows; a preview alone does not announce the match.
Custom modifiers use a selection editor; randomised modifiers can be rerolled before confirmation (with a short cooldown). Default/none have no editable selection. A failed reply or missing message is not proof of delivery.

## Map choice and voting

For `map` use a named supported map, `random`, or `poll ` followed by comma-separated supported maps (for example, `poll ARID1V1,CANYON1V1`). Invalid names reject the proposal. A poll is meant to choose from those options; the map-vote workflow is scheduled before game time and depends on Discord votes and message access.
A poll message reference or scheduled timer is **not** proof that the poll is open, votes were counted, or a final map was delivered. Check the visible poll and `/game diagnostics` before acting on uncertainty.

## Organiser class bans and modifier modes

`banned_classes` accepts comma-separated full class names or `none`. `modifiers` accepts `custom`, `randomised`, `default` or `none`. Custom selects per-category settings; randomised chooses configured modifiers; none supplies no modifier selections.
Default mode configures two shared captain bans (one per captain). A selected class-ban modifier may replace the ban mode or limit; protected classes cannot be banned when conflicting modifiers are active.

## Captain class-ban modes

When enabled, captains use `/class ban` and view with `/class bans`. Shared bans affect both teams; opponent-only bans affect the opposing team and disallow specified core classes. Some modes delay bans until a later phase. Organiser bans and each captain's allowance still apply.
The captain must have the captain role, an open ban window and unused allowance; duplicate/forbidden bans are rejected. Check ban counts and the announced restrictions before assuming a ban took effect.

## Team generation: registered choices

`/team generate method:random` shuffles the current roster into two teams; only random offers a reroll preview. `method:elo` sorts by Elo and alternates assignments. `method:balance` uses Elo-based captain selection and balancing. These three show a preview requiring acceptance; preview teams are **not** committed teams.
`method:draft` is standard captain picking; `method:snake` is snake draft (1-2-2-1 picking order). All five are registered choices: `random`, `elo`, `balance`, `draft` and `snake` (labelled “snake draft” in Discord).

## Team generation prerequisites

An announcement and at least two present registered players are required; Discord roster membership must be verifiable. No competing picking session may be active, and generation/reset is blocked once start has begun or the game has finished.
`draft` and `snake` additionally need one RED and one BLUE captain, an **even number of undecided players**, and a working team-picking channel. Captains make picks there, subject to picking timers and confirmation. Do not interpret draft progress or a preview as final teams.

## Team review, reset and cancellation

Use `/team list` to check RED, BLUE and undecided rosters and whether team selection is final. `/team cancel` stops an **active** picking session; `/team reset` resets team assignments and attempts Discord role cleanup (both change live state). Verify roles separately if an operation reports a partial failure.
Before starting, verify a finalised method and at least one player on each team. `/team generate` can partially update Discord roles even if its response fails; do not rerun automatically.

## Captains: `/captain set` and `/captain randomise`

`/captain set user:<player> team:red|blue` assigns a registered player; `/captain randomise` selects eligible captains using Elo and Discord presence/membership. Automatic selection requires enough suitable players; a rejection may mean organisers must choose manually.
Captains cannot change before announcement, during start/shutdown transitions, or during active picking. During play, a replacement captain must already belong to the requested team. Captain role changes are external Discord operations; inspect partial roles after errors.

## Roster corrections: `/player`

Organisers use `/player add player:<name> team:RED|BLUE|NONE`, `/player move player:<name> from:<team> to:<team>`, or `/player remove player:<name>`. These accept space-separated player names; `NONE` represents undecided. `/player replace old_player:<name> new_player:<name>` swaps a current team player for another eligible registered player.
Requires an announced game and no active picking session. Invalid registration/team conditions reject changes. Operations can affect live rosters, roles and captain planning; check `/team list` and Discord after a partial failure.

## A player leaves after teams are picked

If RED loses a player after an announcement and teams are finalised, **check `/team list` and `/game diagnostics` first** to establish the stage. Do not start with `/team reset`, `/announce cancel`, a fabricated snapshot command, or blindly repeat a mutation. If the replacement is already eligible and registered but not assigned, use `/player replace old_player:<leaving IGN> new_player:<replacement IGN>` while the old player is still in RED. The command substitutes them into the current team and may update Discord roles; check the outcome and actual roster.

If the leaving player has already unregistered or no replacement is ready, an organiser can use `/player remove player:<leaving IGN>` if they remain on the roster, then the RED captain (or organiser) can use `/need team:Red` to request a volunteer. The volunteer must `/register` and press **Join** while unassigned; `/need` is not an automatic team re-generation command. Recheck `/team list`, captains, roles and voice access before starting. If a draft is still active, start is underway, or a roster change fails partway through, stop and check state instead of forcing a replacement.

## Bulk signups: `/massregister`

`/massregister playerlist:<Minecraft names>` accepts whitespace-separated names. It requires an announced game, existing player profiles and members still in this Discord server; it skips invalid names, duplicate entries and already registered players.
The result distinguishes registered, skipped and warnings. During an early draft, late signups may need organiser review in the picking display. Never repeat the whole list just because a response timed out: inspect the roster for partial success.

## Starting a match is not ending or saving it

`/game start` (or the current confirmed start control) begins the live match transition: voice moves, team roles, team messages and captain-plan prompts. Check confirmed playable teams, captains, roster membership and class-ban readiness first; do not rely on the start command to validate every preparation.
“Starting” means work may still be underway; a failed step may leave partial Discord changes. “Started” is an in-process stage, **not** evidence of a saved match result, complete role moves or successful message delivery.

## Ending gameplay: `/game end`

Use `/game end` when gameplay has actually finished. It requires an announced, started, not-yet-finished game with finalised playable RED/BLUE teams, and no shutdown underway. It records an end time/finished flag **in memory**, attempts voice moves back, captures plans and opens MVP voting.
`/game end` does **not** persist a finished result. If it was already ended, do not run it again; continue to the post-game checks. Missing MVP messages or partial voice movement are separate issues.

## Recording a winner: `/winner set`

Use `/winner set team:RED|BLUE` and review the confirmation. It sets the winner on the current live game; the confirmation belongs to the requesting organiser and current lifecycle. A set-winner confirmation is not the database commit.
Check the actual result carefully, especially after an interaction timeout. A winner is mandatory before `/game shutdown`; it may be recorded before shutdown but must not be mistaken for a completed save.

## Shutting down: `/game shutdown`

`/game shutdown` is **distinct from both start and end**. It **requires the match to be finished via `/game end` AND a winner recorded via `/winner set`**. It counts MVP votes, attempts durable result persistence, then Discord cleanup, season follow-up and reset.
Persistence precedes role/channel cleanup, so a failure can leave a saved match with incomplete Discord cleanup—or uncertain persistence. A shutdown response, feed message, movement or end flag alone does **not** prove the database result was committed.

## Shutdown uncertainty: stop and verify

If shutdown fails, times out or reports unresolved cleanup, **do not blindly repeat shutdown, start a new game or restart the bot**. `/game diagnostics` reports process state, not the saved database checkpoint. A trusted operator must verify the stored match and cleanup status independently before authorising recovery.
Keep observations separate: winner chosen, finished in memory, roles moved, messages seen, database saved and external cleanup completed are different facts.

## Cancel an announcement: `/announce cancel`

Use `/announce cancel` only to withdraw an announcement that has not started and should not proceed. It can reset the live roster and affect Discord messages and roles. Check `/game diagnostics` and `/team list` first, especially if teams have already been picked.
Never use cancellation to end gameplay, bypass shutdown or work around uncertain state. If a match's stage is unclear or the usual end flow cannot apply, stop and escalate rather than forcing a lifecycle transition.

## Diagnostics: what is observed

`/game diagnostics` is organiser-only, ephemeral and read-only. It reports current-process lifecycle, registered/RED/BLUE/undecided counts, captains, picking state, map and minerush selections, ban counts, timer-handle presence, paused workflows and recovery blocks.
It does **not** query the database, fetch Discord messages or execute timers. The `/ask` game snapshot has the same essential limits: live-process observations do not verify database persistence, actual message delivery, open polls or running timers.

## Troubleshoot a stuck start or incomplete teams

First use `/game diagnostics` and `/team list`. If no announcement is confirmed, check the announcement flow. If teams are unfinished, check missing/undecided players, captain assignments, an active draft and whether Discord member lookups succeed.
If status is “starting” or a start failed, do not issue a competing start. Inspect real team roles and voice channels; escalate unresolved partial changes or permission failures rather than retrying changes blindly.

## Troubleshoot polls, timers and captain bans

Check the visible map poll, class-ban state and scheduled game time. A poll reference may point to a closed/missing poll, and an in-memory timer handle does not prove its callback will fire. Do not infer a winner from stale messages or fabricate the vote result.
If automatic captain selection or drafting was interrupted, use `/game diagnostics` and `/team list`; a recovered game may deliberately pause those workflows. Stop and escalate if the safe live stage cannot be established.

## Partial Discord movement and failed delivery

Role assignment, voice moves and messages are independent external effects. A player in a team VC, a “started” status or a visible game-feed message does not establish that all players moved, that every message arrived or that the result was saved.
Check the actual roster and Discord roles/channels. After any reported partial failure, avoid a repeat mutation until the live state and intended action are clear; involve the trusted operator if inconsistent.

## Recovery blocks and bot restarts

A recovery block protects uncertain shutdown/persistence or an interrupted game snapshot. **Do not work around it.** `/game diagnostics` can show a block without exposing its internal reason. Escalate for authorised verification.
An ordinary bot restart can lose live-only announced/started game progress. A separately confirmed `/restart preservegame:true` is intended to snapshot a safely capturable announced/started game; it can refuse to restart and does **not** guarantee restored polls, draft sessions, messages or timers. Restart is operator-sensitive and changes the running service.

## Reviewing `/recover-game`

`/recover-game` is an organiser-confirmed, sensitive path for reconstructing a _lost live game_ from trustworthy Discord evidence, not for undoing a saved result or clearing a recovery gate. It can be rejected for conflicting game state, prior saved matches, inadequate/mismatched evidence, ambiguous players or unfinished draft data.
If explicitly authorised by the trusted operator, the organiser must review the private preview and limitations. It reconstructs **in-memory** stage/roster; it does not recreate roles, voice movements, messages, timers or polls. `/ask` must never propose recovery as an automatic repair.

## Season status and authority

`/season status` reads the active season type, finished **saved** game count, effective game/month limits, rollover deadline, first scheduled rollover, next-type policy, rollover-pending flag and pending announcement blocks.
`/season configure`, `/season start` and `/season end` are organiser-only persistent operations; start/end also use single-use user-bound confirmation. If a response is uncertain, check `/season status` before any new request.

## Ranked and Relaxed season limits

`/season configure game-limit:<n> month-limit:<n>` sets **Ranked baseline** limits; `0` clears either limit. Ranked uses full values. Relaxed uses **floor(game limit / 2)** with a minimum of one when set, and **half the months** (including half-month intervals). A missing limit disables that trigger.
`current-type` changes the active Ranked/Relaxed type only before it has finished games. `next-type` selects a one-time successor or `AUTO` for normal alternation. Limit changes can affect whether a rollover becomes due.

## First scheduled rollover versus ordinary rollover

`/season configure start:<future YYYY-MM-DD or zoned ISO time>` schedules the **first** rollover (or `start:off` removes it). While scheduled, this date takes priority over game/month limits—even if the ordinary limit is reached first.
After that first rollover, ordinary rollover occurs when the active season reaches its effective saved-game limit **or** time deadline, whichever comes first. No configured limit means no automatic trigger.

## Deferred rollover and pending announcements

If a rollover becomes due while a game is announced or underway, it is **deferred** until that match is finished/cancelled; `/season status` reports pending current game. Do not force a manual end during an active game.
Rollover activation and recap/title/new-season **message delivery are separate**. Pending announcement blocks can exist after the successor becomes active; check the active season independently and do not repeat rollover merely to repost messages.

## Manual season start and end

`/season start` bootstraps only when **no active season exists**; optional `type` chooses Ranked/Relaxed and `number` must exceed historical numbers. `/season end` requests confirmed closure and successor activation, with optional `next-type`. Manual end is blocked while a game is announced.
Both change persisted season state and may queue/post announcements. After a failed confirmation or partial delivery, inspect `/season status` and escalate uncertain transitions rather than starting/ending again.
