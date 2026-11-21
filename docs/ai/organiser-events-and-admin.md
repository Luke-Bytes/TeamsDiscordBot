# Organiser events and administrative Discord workflows

For legitimate Discord use by authorised organisers. `/ask` can explain a command and recommend checks but must not execute it, view private forms, expose account records or perform maintenance. State-changing commands are performed by humans through their ordinary Discord controls.

## Event drafting: `/event create` and `/event edit`

`/event create title:... description:... terms:...` creates a **draft**, not an open event. Optional `starts-at`, `deadline` and `capacity` accept zoned ISO dates and a confirmed-place limit; `capacity:0` means unlimited. `/event edit` changes permitted fields; `deadline:none` clears a deadline.
Only organisers can manage events. Save the draft event ID for later edits because the default event is the current open/closed event, not necessarily your new draft.

## Draft questions: `/event question`

Before opening, build questions with `/event question add`, `edit`, `remove` and `move`. Use `label` and `type` (`SHORT_TEXT`, `LONG_TEXT`, `SINGLE_CHOICE` or `MULTI_CHOICE`), optional `required` (true by default) and pipe-separated choice `options`.
`number` and `position` are **1-based**. The form supports up to 20 questions and 25 choices per choice question. Use `/event preview` to inspect the draft and terms before opening.

## Event opening and validation

`/event open` makes the selected draft the current event and freezes questions and terms. It requires a configured sign-up text channel and a manageable participant role. Finish the previous current event before opening another.
Opening can reject missing permissions, wrong role hierarchy, invalid questions or an incompatible event state. Inspect `/event view`/`preview` and have a trusted operator check configuration/role permissions; do not bypass validations.

## Event navigation and privacy

`/event list` finds current and historical events; `/event view` displays event details; `/event preview` checks a draft. Commands with optional `event` generally target the current event unless an ID is supplied.
`/event roster`, `/event response player:<user>` and `/event export` are **organiser-only ephemeral** outputs. Responses and CSV exports contain private applications and identifiers. Limit access to responsible organisers; do not paste answers, exports or personal records into `/ask` or public channels.

## Capacity, deadlines and reserves

While regular admission is open, applicants become confirmed if there is space before the deadline; otherwise they join the reserve queue. `capacity:0` is unlimited, and capacity cannot be reduced below the already confirmed count.
Withdrawals promote the earliest reserve; promotions can continue after regular closure/deadline until finishing. The start date alone does not end registration. Changing capacity or deadline can change admissions; verify confirmed and reserve counts using `/event roster`.

## Closing, reopening and finishing events

`/event close` stops **regular** admission; reserve applications/promotions may still continue. `/event reopen` restores regular admission when capacity and deadline permit. `/event finish` ends participation changes, stops promotions and removes participant roles.
These are persistent state changes with external Discord effects. If reopening appears ineffective, inspect deadline, capacity and event state. A finished event is not simply a temporarily closed event.

## Event role sync and delivery failures

Only **confirmed** applicants receive the participant role, not reserves. Withdrawal, promotion and finish trigger external role changes. Missing Manage Roles permission, role hierarchy, channel access, or a departed member can delay syncing; a disabled DM does not undo a promotion.
The database application status is the intended record, Discord roles/messages are separate observations. Do not ask players to resubmit to fix a role. If status and roles disagree, escalate permission/sync verification.

## Punishments: `/punish add` and `/punish remove`

Organisers can use `/punish add player:<name> reason:<reason> duration:<n>s|m|h|d` to add a dated strike and expiry; an unknown player or invalid duration is rejected. This changes stored punishment history.
`/punish remove player:<name>` clears the **active expiry**, not past reasons or strikes. Do not use removal to claim a historical record has been erased; inspect the existing record when handling an appeal.

## Sensitive history removal: `/punish expunge`

`/punish expunge player:<name>` is an organiser-only, ephemeral selection of one stored punishment history entry. The selection is bound to its requesting organiser and message and expires; it **changes or deletes durable history**.
Use only after the legitimate disciplinary review/authorisation. If the result or confirmation is uncertain, stop and obtain trusted human verification of the record before another request. `/ask` cannot approve or perform an expunge.

## Reading punishment status: `/punished`

`/punished` without `user` lists active punishment expiries; `/punished user:<name or Discord ID>` shows available history, dates, strike count and expiry for that player. The registered reader command does **not** enforce an organiser role, unlike `/punish`.
Treat returned disciplinary details as sensitive even if Discord permits the query. “No active expiry” does not necessarily mean “no prior strikes”; use the specific-record view when a permitted review needs history.

## Player titles: `/title`

`/title player:<Discord mention, ID or latest IGN>` opens an organiser-controlled title editor with Add, Remove and Close controls. Changing unlocked titles can write profile state; an unknown player or expired editor session needs a fresh normal request.
Verify the player and selected title before changing it. Discord interface acknowledgement and stored profile state can diverge on failure; ask a trusted operator to verify if uncertain.

## Title reconciliation: `/scripts titles-update`

`/scripts titles-update` is a **registered Discord command**, not permission to execute files under the repository’s `scripts/` directory. It asks the authorised organiser to confirm lifetime/ranked-placement title reconciliation; it can persist title changes and post new-unlock announcements.
The confirmation is user/message-bound and expires. If some work or posts may have succeeded, inspect title state and announcements before requesting it again. Do not use shell scripts or database edits as a workaround.

## Season recap publication: `/season-recap`

`/season-recap season:<number>` defaults to `preview:true` (private recap preview); omitting the season selects the active season. To publish, use `preview:false`, review the prepared first block and confirm the Publish control.
Publishing sends multiple announcement messages and can partially succeed. If publication fails, check the announcements channel before any fresh request; the original confirmation cannot safely replay.

## Running a tier list: `/tierlist`

`/tierlist start` creates a new organiser-led tier-list event; optional `limit`, `played_recently`, `fast_mode` and `no_community_input` constrain its scope. Use `/tierlist show` to inspect progress and `/tierlist next count:<1-10>` to advance once the anchor phase is over.
`/tierlist skip`, `undo` and `rereview player:<name>` adjust provisional choices; `final` begins final review once everyone is placed. `reset` discards the current event. These affect the live tier-list workflow and can post community prompts; verify state before using disruptive controls.

## Tier-list stalls and review limits

A tier list may be waiting for community anchor voting, a question, a reviewer action or a model-assisted placement. A missing state, unfinished anchor phase or remaining unplaced players can block later stages. Use `/tierlist show`, check the visible prompt and ask a human to review unexpected outcomes.
Do not treat a provisional ranking, generated prompt or partial Discord post as an official finished result. `/ask` cannot resume the workflow or guarantee external model availability.

## Minecraft identity checks: `/verify igns`

`/verify igns names:<space-separated usernames>` is organiser-only and checks up to **25 distinct** Minecraft names (maximum 16 characters each) against identity service and stored player records. `pingplayers:true` optionally mentions verified guild members; the default is not to ping.
A valid Minecraft name can still lack a stored player, and an external lookup outage means **unknown**, not invalid. Verify the intended recipients before pinging; this command checks identities and does not register players or rewrite records.

## Minecraft account corrections: `/username update`

A player cannot replace an existing Minecraft link through `/register` or `/unregister`. After an identity review, an authorised organiser can use `/username update oldusername:<current> newusername:<intended>` to correct the stored primary Minecraft association. Both names must resolve through the Minecraft identity service, and the intended account must not already belong to any player's stored links. The change is refused when ownership is conflicting or uncertain.

This is a stored identity change, not a way to bypass account ownership checks. If the lookup is unavailable, the command reports a conflict, or the outcome is uncertain after an error, **stop and have a trusted operator verify the current association** before another attempt. The AI cannot view or perform this account change.

## When to stop and escalate

Escalate if an event cannot open due to channel/role access, saved sign-up status conflicts with Discord roles, a private export reaches the wrong audience, or punishment/title/recap publication is uncertain. Do not repeatedly execute state-changing commands to chase a missing response.
Only a trusted operator should verify durable records or service health. `/ask` may explain expected behaviour and safe read-only checks but must not disclose private answers, prescribe database maintenance, run scripts or bypass confirmation gates.
