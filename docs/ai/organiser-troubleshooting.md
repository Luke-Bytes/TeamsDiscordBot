# Navi organiser live-game troubleshooting scenarios

These are reviewed *human actions*, not Navi operations. Before recommending a mutation, use the organiser's current-game overview and, when relevant, roster/draft, targeted Discord or exact-match persisted-result diagnostic. Prefer the relevant slash command over speculative fixes. Every process observation is local; Discord message existence, REST role membership, gateway voice cache and durable database checkpoints are separate evidence. If a diagnostic is unavailable, state unknown instead of asserting success or failure. These instructions do not authorize a user; organiser checks run afresh.

## Announcement preview exists but was not published

Symptom: the organiser sees a preview yet players cannot register or no announcement is visible. In the announcement stage, inspect the process announced flag and targeted announcement-message lookup. A preview is not a posted game; inspect the preview's Confirm & Send (Ping) or (No ping) controls, review settings, then confirm **once** if still valid. Verify the published announcement and registration feed. Do not run a second /announce start merely because a preview exists. If confirmation timed out, check Discord before repeating any action; unresolved partial publication requires operator review.

## Registration or signups fail

Symptom: a player says /register did nothing or is missing. Compare registered RED/BLUE/UNDECIDED roster and latest IGN with /registered and check the announcement is confirmed. A missing link, invalid IGN, duplicate entry, expired registration or departed guild member can prevent joining; ask the player for their exact error and whether registration succeeded on Discord. They may retry /register only if the bot confirms they are not registered and the signup window is open. Never mass-register repeatedly after a timeout; partial success must be checked first.

## A registered player cannot be assigned to a team

Check the exact latest IGN in the organiser roster and /team list; confirm the player is still a guild member, not already assigned and no draft or start transition is active. If the correct registered eligible player is undecided, /player move player:<IGN> from:NONE to:RED or BLUE is the supported organiser correction; /player add player:<IGN> team:RED or BLUE may be appropriate for a newly eligible player. Verify roster and Discord roles after. If the command rejected registration, the game is starting, or an external role change partially failed, do not force it.

## Wrong game settings were selected

A preview can be edited before confirmation with its time, map, bans or modifier controls. Compare the confirmed schedule, map, modifiers, organiser bans and double Elo from the process snapshot against the public announcement. After publication, no general safe /announce edit command exists: if play has not started and cancellation is genuinely intended, /announce cancel can withdraw the match but destroys current session state. Never use cancel to repair an active or finished match; seek operator review when the game has registrations or downstream actions.

## Team generation fails or the preview looks wrong

Inspect /game diagnostics, /team list, latest names, number registered, team method and active picking session. /team generate method:random|elo|balance offers a preview; accepting is separate from generating, and random permits reroll preview. Draft/snake require both captains and even undecided count. Use /team cancel only for an active picking session; use /team reset only before start when intentionally discarding teams. Verify final roster and Discord effects before a new attempt. A timed-out generation may have applied roles despite an error: never blindly regenerate.

## Draft stuck or captain stops picking

In an in-progress /team generate method:draft or snake session, check current turn and proposed undecided count in Navi's draft observation and inspect the team-picking chat. The bot normally auto-picks after its turn deadline (opening pick 2 minutes; subsequent picks 1 minute). A timer handle does not prove a pick happened. Do not assign an unpicked player by bypassing the draft. If the timer is genuinely stalled, an organiser may /team cancel the active session then deliberately restart /team generate after verifying the roster/captains and confirming the previous session is cancelled; the old picks will be lost. If recovered/paused or uncertain, escalate.

## Captain selection fails

Look for RED and BLUE captains in the current roster. /captain randomise may reject for absent guild members or too few eligible players; /captain set user:<registered player> team:red|blue provides an explicit choice before picking or game start where permitted. Verify the team and captain role on Discord, and check class-ban eligibility afterward. Do not change captains during an active draft or startup/shutdown, and do not assume auto-selection will retry after a restart.

## Player leaves after teams were picked

Check if the leaving IGN still occupies RED or BLUE, whether a draft is active and whether the game has begun. If an eligible, registered replacement is available and old player still appears, /player replace old_player:<IGN> new_player:<IGN> is the direct supported substitution. Otherwise /player remove player:<IGN> if still present, then use /need team:Red or Blue to invite a replacement, who must register and Join while unassigned. Verify team count, captain and roles/voice. Do not reset finalised teams just to replace one player; avoid mutations in active picking.

## Replacement needs to be added

Inspect the target team's roster, UNDECIDED and recent registration in memory and /team list. The replacement must be registered, eligible and still in the guild; /player replace is for swapping a currently assigned player, whereas /player add or /player move can place a correctly registered eligible player as permitted. /need team:Red|Blue requests volunteers but does not silently assign them. Verify the old name is gone, the new name appears once and Discord roles align. If a draft/transition is active, wait or escalate instead of racing it.

## Incorrect Discord team roles before start

Compare the exact in-memory roster to targeted fresh Discord member role checks. RED players should have the RED role, BLUE the BLUE role; both/neither means mismatch, not automatically an incorrect roster. /team list proves only process allocation. Do not run /game start solely to repair role assignments or /team reset when a game has begun. A supported roster correction may legitimately update roles before start; if the roster is correct but role assignment failed, an organiser with appropriate Discord permissions or operator should reconcile them and verify again.

## Map poll never appears or does not finish

Check the process map, map poll manager/reference, scheduled start and targeted Discord poll message existence. The scheduled map vote closes around 10 minutes before start, but a timer or message ref is not proof it opened or closed or that votes were accepted. Verify the visible poll and current map; do not invent the winning map, re-run any hidden vote function or repeat /announce start. If the map remains unknown close to start, pause progression and seek operator review; no ordinary safe manual poll-reopen command is exposed.

## Class bans incomplete or deadline appears stuck

Use /class bans alongside current captain ban counts, locked-window flags, shared/opponent-only mode and start time. Captains use /class ban class:<class> only while the window is open and their allowance remains; the configured mode determines permitted classes. The bot normally enforces deadlines, but absent handles may be normal after execution or restart, and present handles do not prove delivery. Verify actual recorded bans and the public ban message. Never tell captains to ban after their window was locked or bypass a ban timer; escalate unresolved restrictions.

## Automatic start or pregame scheduling does not happen

The scheduled captain workflow reminds at roughly 20 minutes and selects captains/attempts draft around 15 minutes before scheduled start; too few signups may cancel automatically. That is **not** automatic /game start of Minecraft play. Check start time, player threshold, captains, stage, pause flags and timer observations. If teams are genuinely final and organisers are ready, the authorised /game start is the manual match-start workflow. Do not issue it while already starting, when a recovery gate is active or while Discord effects are inconsistent.

## /game start fails

Inspect lifecycle start status, playable team check, exact roster and targeted Discord role/voice observations. Start moves players to team VCs, assigns roles then posts messages; an error may happen after some moves. If still starting, wait and recheck; if idle after failure, that means the start claim was released, **not** that Discord rolled back. Do not automatically retry /game start: reconcile members, role/voice outcomes and causes first. Only an organiser, with confirmed safe external state and no recovery block, should decide whether a fresh normal start attempt is appropriate; otherwise escalate.

## Game remains in starting

A process "starting" stage means a transition is underway; it is not a deadlock diagnosis. Check whether assigned members are already in team voice channels, whether team roles were applied and whether the stage changes after completion. Do not run competing /game start or mutate teams during it. If it remains stuck beyond the normal operation, or check results are unavailable, escalate while preserving the current roster and original match context. A restart or cancellation is not a safe default workaround.

## Some players moved to voice but others did not

Compare /team list with targeted Discord member checks and gateway voice observations for the named player. Role verification uses fresh REST; voice observations use the guild gateway cache, so absence from cache is unknown. Ask the player to join the assigned VC if permitted; an authorised organiser with Discord Move Members permission may move a confirmed member manually using Discord, then verify their connection. Do not repeat full /game start for a single partial move, and do not move unregistered/undecided people to a team channel.

## Discord team roles disagree with rosters

First establish the roster from memory, then check selected members' actual Discord roles. Stale role assignment can result from an interrupted generation, replacement or start. A fresh member lookup with both RED/BLUE roles is a mismatch, but missing gateway voice cache says nothing about role correctness. Before start, if the **roster** is wrong, use the supported /player move or /player replace with normal preconditions and verify. If the roster is correct and only Discord is wrong, reconcile roles through authorised Discord management and recheck; never swap teams to mask a role failure.

## Captain or player disconnects during play

The Discord member/voice observations cannot establish whether someone disconnected from Minecraft. Confirm the affected IGN and current team with /team list and ask the captain/player about their in-game status. If they can reconnect, have them rejoin the game and their authorised team VC. If replacement is needed, apply the normal /need and /player replace process only if the current stage permits it; otherwise escalate the competition decision without falsifying a game result. Do not mark a forfeit or winner from a Discord disconnect alone.

## Organiser needs a live roster correction

Before a /player add, move, remove or replace, inspect current stage, exact registered members, captains and active draft. The command layer restricts updates during active picking/transition; never bypass that with manual data changes. For a known eligible replacement, /player replace old_player:<IGN> new_player:<IGN> avoids full regeneration; /player move player:<IGN> from:RED to:BLUE corrects a known placement when permitted. Afterward verify /team list and real Discord roles/voice, and confirm any team plan affected. Stop if state changed while the request was pending.

## Bot restarts during an announced or active game

Inspect whether current memory still describes an announced/started match or the game is now inactive with a recovery block. A normal restart is not proof of safely restored voice, roles, drafts, polls or timers. /restart preservegame:true is a **separately confirmed, privileged** planned snapshot action, not a way to fix an already disrupted game. Do not ask Navi to restart or run scripts. A lost active game may require a carefully reviewed /recover-game proposal from trustworthy Discord evidence, only with operator approval and no conflicting saved record.

## Recovered game misses some workflow

Check resumed lifecycle/roster, paused workflow count and any paused draft record. Recovery can deliberately restore data without reactivating draft picking, map/minerush polls, messages or timers; an absent timer is not a safe instruction to re-run it. Verify stage and current Discord messages, then agree on a manual supported next step only if no hidden prior effect is possible. /recover-game repair_existing is a sensitive option for a specifically supported post-game repair, not a general workflow unpause. Escalate ambiguous recovery rather than forcing start.

## Previously scheduled action never resumes

Compare scheduled start with currently known stage, map/minerush settings, captain/class-ban state and paused recovery indicators. Timers in this process cannot prove that callbacks ran, and recovered workflows may remain intentionally paused. Where the workflow is still ordinarily actionable, use its exposed command (such as a legal /class ban or manual captain selection), verify results and avoid assuming the missed scheduled action is safe to replay. No ordinary organiser command replays arbitrary scheduler callbacks; operator reconciliation is required if timing or votes make the next step uncertain.

## External Discord operation partially succeeds

A role change, voice move, message send and subsequent database save are separate effects. Check the intended in-memory team and stage, plus targeted Discord message or member evidence, and classify missing/unavailable checks as unknown. Prefer manually correcting a known voice placement with permitted Discord controls or a normal authorised roster correction when safe. Do not replay a multi-step command merely to fill in one failed side effect. If the failed operation is start/end/shutdown, preserve the match context and escalate uncertain cross-system state.

## /game end fails or appears to do nothing

The command requires announced + started + playable teams, not already finished and no shutdown in progress. Read the lifecycle and /game diagnostics before retrying. The end handler sets finished/end time **before** moving players and opening MVP messages, so a later Discord error may leave the game already ended but with partial post-game effects. If finished is recorded, do not run /game end again to repost voting; confirm messages/voice and escalate partial delivery. A failure before any end marker can be re-evaluated only after prerequisites are verified.

## Minecraft match finished but bot is at an earlier stage

Navi cannot verify Minecraft server results; get organiser confirmation of the actual match and the bot's memory state. If the bot says started and teams are finalised, /game end is the normal route to MVP voting, then /winner set and /game shutdown after appropriate checks. If the bot is still announced/starting/paused or was restarted, /game end may reject; never set invented start or end flags or cancel to force progress. Preserve Discord evidence and ask an operator to reconcile a lost stage before normal result recording.

## MVP voting does not open or finish

/game end attempts to move players and post voting instructions in RED/BLUE chats, but it records "finished" in memory before all messages are sent. Check whether the game is finished, the team chats have voting instructions, and whether votes/selected MVPs exist in memory. Eligible players use /mvp vote normally. If messages failed, do not re-run /game end to duplicate effects. Votes may be absent; do not fabricate an MVP or claim a quota is mandatory. Verify winner and post-game integrity before shutdown, or escalate ambiguous message/vote state.

## Wrong winner selected before confirmation

/winner set team:RED or BLUE opens a user-bound confirmation. If the proposed team is wrong, press No/cancel rather than Yes, then issue /winner set with the correct team and confirm deliberately. Verify the recorded winner in the in-memory result before shutdown. Neither opening a confirmation nor seeing its embed means a winner is saved. Do not proceed with shutdown based on an unconfirmed or disputed outcome.

## Winner confirmation fails or times out

Inspect the in-memory winner first; a confirmation may have been consumed before Discord acknowledged it. If the winner remains unset, confirm that the game is announced and not shutting down, then initiate a fresh /winner set team:RED|BLUE and verify once. If the wrong winner was recorded, resolve it with the authorised organiser before persistence. Do not retry blindly while a save/shutdown may be underway. A stale confirmation button cannot be used to clear a recovery gate.

## /game shutdown fails partway through

This command requires isFinished and a confirmed winner; it first attempts result persistence and **then** Discord cleanup. An error can mean persistence committed and Discord roles/voice/messages were only partly cleaned. Inspect process status and the exact-match database checkpoint; check the Discord cleanup separately. Do not retry /game shutdown, reset, restart or announce a new game because the reply timed out. If the database read is unavailable or PENDING, stop and request trusted operator reconciliation to preserve the result.

## Match result may already have been saved

Ask Navi for exact current-match persisted status, not only /game diagnostics or season totals. A finished record with persistence fingerprint is verified saved-result evidence; PENDING means cleanup checkpoint remains incomplete, COMPLETE means only the persisted cleanup checkpoint was recorded. A missing record or lookup error does **not** prove transaction rollback; the commit may have been uncertain/in flight. Never create a duplicate result or run a new shutdown based on missing process flags. The operator must reconcile match identity, saved stats and external cleanup before further writes.

## Database persistence succeeds but Discord cleanup fails

If Navi verifies a finished fingerprinted match with cleanupState PENDING, the result was saved but cleanup is unresolved. Inspect actual roles/voice and messages; do not run /game shutdown again as a cleanup retry. A COMPLETE database checkpoint means the application recorded cleanup completion, not independently that every role and channel is clean. Only an operator may reconcile pending state and approve recovery. No ordinary /ask tool can change the checkpoint or safely execute maintenance.

## Recovery gate prevents further actions

An active MatchRecoveryGate or recovery coordinator block protects against uncertain match cleanup or interrupted recovery. It can block announcements even when memory has no active game. Read-only /game diagnostics and Navi observations can show that a gate exists, but may not expose the sensitive cause. Do not bypass with /announce cancel, reset, /recover-game, restart or new season/game. Escalate to the operator who can establish persistence and Discord reconciliation; only explicit authorised recovery can clear the gate.

## Organiser wants the next game but cleanup is incomplete

Check both current-game memory and the exact persisted cleanup checkpoint, then verify actual Discord team roles/voice state. It is unsafe to start /announce start while the current result, cleanup or recovery gate is unresolved—even if the bot restarted or now appears inactive. If the previous match is confirmed saved but Discord effects remain, route to operator reconciliation rather than a second shutdown. Only after the prior match's cleanup is genuinely resolved and the normal game lifecycle is clear should organisers begin a new announcement.
