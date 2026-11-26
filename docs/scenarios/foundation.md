# Friendly Wars scenario foundation - implemented integration guide

This document describes the **implemented foundation**, not gameplay for any of the seven designs. Read the [catalogue](./README.md), [shared design](./shared-design.md), and the specific scenario proposal first. All seven planned scenarios are **disabled** until their mechanics and Discord UX are complete.

## Where the pieces live

| Module | Responsibility |
| --- | --- |
| `src/logic/scenarios/ScenarioRegistry.ts` | Single source of names, IDs, categories, capabilities, implementation and enabled status |
| `ScenarioTypes.ts` | Narrow TypeScript contracts for hooks, phases, configuration, actions, rosters |
| `ScenarioCoordinator.ts` | Per-`GameInstance` lifecycle, stage ownership, private choices, versioned snapshot, invalidation, fallback, restart review |
| `ScenarioInteractionRouter.ts` | Shared Discord button/select/modal routing (`fwsc:` prefix) with verified user and organiser role; always ephemeral |
| `ScenarioPromptDelivery.ts` | Best-effort private registration prompts (ephemeral for self, DM for organiser-added players), with self-service reopening |
| `ScenarioTeamPickingSession.ts` | Organiser preview for proposed RED/BLUE/UNDECIDED teams, validation, confirmation and cancellation |
| `TeamCommand.ts` | **Authoritative roster lock and role finalisation** for both normal and scenario team sessions; `previewScenarioTeams` and `confirmScenarioCaptains` |
| `AnnouncementCommand.ts` | Optional scenario and No Elo options, previews and confirmation |
| `GameInstance.ts`, `CurrentGameManager.ts`, `GameCommand.ts` | Match ownership, registration and reset hooks, automatic captain/draft ownership, start gate |
| `ActiveGameRecovery.ts`, `MatchPersistence.ts` | Validated saved scenario snapshot and public historical match metadata |

## Stable registry IDs

- `mystery-dungeon`: **Mystery Dungeon - Personality Test** (team formation)
- `peoples-captains`: **The People's Captains** (captain election)
- `partners-in-crime`: **Partners in Crime** (team formation)
- `masked-draft`: **The Masked Draft** (draft)
- `draft-roulette`: **Draft Roulette** (draft)
- `captains-wildcards`: **Captain's Wildcards** (draft extension)
- `class-hex`: **Cursed Classes** (pre-game restriction)

`ScenarioRegistry.requireAvailable(id)` requires a known definition with **both** `enabled: true` and a real `implementation`. Planned definitions have neither. `/announce start scenario` derives its choice list from `scenarioRegistry.available()` plus `none`, so no unfinished game mode can be advertised. Changing a definition requires the next normal command registration to publish the new choices. No external command registration/deployment was performed as part of this foundation.

Exactly one scenario is selectable per announcement for now; categories and capability flags are kept distinct to support future compatible combinations without modelling them now. The registry is ordinary TypeScript, not a dynamic plugin loader. Do not reassign legacy `gameType` enums to scenario IDs.

## Announcement options and rating

`/announce start` accepts **optional** `no_elo` (Boolean, defaults `false`) and `scenario` (choice list, defaults `none`). Both appear in preview and posted announcement. Scenario labels come from the registry. Explicit `no_elo:true` plus `doubleelo:yes` is rejected **before** starting the proposal. Season restrictions on Double Elo remain intact.

`game.organiserNoElo` records the explicit choice; `game.noElo` is the effective rating state after applying organiser choice **OR** Relaxed season **OR** active roster below 20 at game start. `refreshNoElo()` centralises that check. Do not replace `organiserNoElo` with the low-player predicate. Match persistence saves `organiserNoElo`, effective `eloRated` and `unratedReason` (`ORGANISER_SELECTED`, `RELAXED_SEASON`, `LOW_PLAYER_COUNT`) with organiser choice taking precedence. Ordinary games are unchanged.

## Per-game lifecycle

1. **Announcement preview:** `game.scenarios.configure(id, config)` validates the enabled definition and calls its optional `validateConfig`. `none` clears the selection.
2. **Confirmation:** `GameInstance.beginConfirmedAnnouncement()` changes phase from `configured` to `collecting` with the confirmed match token; `announce()` activates the ordinary announcement and `onAnnounced()` executes the scenario's setup hook. Failed hook -> `needs_review` and start blocked.
3. **Registration:** `GameInstance.addPlayerByDiscordId` / `removePlayerByDiscordId` call `onRegistrationChanged(game, userId, joined)` (also covers normal mass registration and departure handling). After successful `/register` or `/massregister`, the command independently calls the optional private `registrationPrompt` hook for `on_registration` policies. Failed delivery cannot roll back registration. Dropouts erase user-owned pending actions, and a change after a captured roster or prepared result invalidates it. Scenario-specific `data` must additionally remove references to departed users in its hook.
4. **Selections:** the implementation requests match-scoped interactions through `scenarios.openAction(...)`. Use `markReady(result)` once enough verified input is collected; do not apply teams or captain roles merely on questionnaire completion.
5. **Confirmation:** captain-election implementations call `TeamCommand.confirmScenarioCaptains(guild, redId, blueId)` after organiser-approved results. Team-producing implementations call `TeamCommand.previewScenarioTeams(guild, proposal)`. The latter posts a dedicated organiser confirmation preview; no authoritative roster mutation occurs until confirmation. These methods use the normal roster serialisation, verified membership, lifecycle checks and Discord roles.
6. **Gameplay:** draft hooks (`onDraftTurn`) and after-finalisation hooks (`onTeamsFinalized`) provide attach points. Pre-game restrictions can allow normal captain/team automation yet block `/game start` until preparation completes.
7. **Start and finish:** `GameCommand` checks `scenarios.startBlock()` before transitioning to starting. The normal `/game end`, `/winner`, `/game shutdown`, MVP and Elo flows remain authoritative. Finished matches save **only public scenario metadata**, not private votes/answers; the implementation can return an optional `publicResult`.
8. **Cancellation/shutdown:** `CurrentGameManager.resetCurrentGame()` calls scenario `onCancel`, then clears state and the match token. Pending interactions become stale; cleanup is idempotent.

Phases: `configured`, `collecting`, `ready`, `completed`, `needs_review`, `cancelled`. For a scenario that doesn't generate teams, its implementation calls `scenarios.complete()` after its own required preparation is safely applied. `complete()` is required to pass the start gate.

## Ownership and safe fallback

`definition.capabilities` declares `captains`, `teams`, `draft`, `normalDraft` or `requiresFinalTeams` as applicable. `automationBlock("captains" | "teams" | "draft")` is used by automatic captain selection, delayed draft and manual captain/team commands:

- **Team formation** (Mystery Dungeon, Partners): holds team generation and ordinary drafting while preparing.
- **Captain election** (People's Captains): holds automatic captains and premature draft until elected captains are confirmed.
- **Custom draft** (Masked, Roulette): holds normal drafting; elected or organiser captains can still be chosen when appropriate.
- **Normal-draft extension** (Wildcards): allows the ordinary draft, uses `onDraftTurn` to affect it.
- **Gameplay restriction** (Cursed Classes): allows ordinary captain/team selection and draft, uses `onTeamsFinalized`, and requires a completed restriction phase before match start.

On failure or a restart, `needs_review` blocks automatic progression and `/game start`. Inspect `/game diagnostics` for the scenario phase and start block. **Explicit organiser escape hatch:** `/team scenario-fallback` cancels a pre-game scenario before teams are finalised, informs the game feed, and re-enables ordinary `/captain` and `/team generate` workflows. It deliberately does not auto-replace existing captains or change partially applied Discord roles; inspect them first. `resumeAfterReview()` is a typed primitive for future per-scenario organiser UX; never call it without an authenticated organiser review and fresh interaction publication.

## Private interaction contract

`openAction({id, kind, ownerId, role, deadline, allowUpdates})` generates a Discord component custom ID in the form `fwsc:<game token>:<action id>:<Discord user id>`. The shared router passes the *actual* Discord `interaction.user.id`, verifies the member for organiser roles, and stores the response via the existing serialized roster lock. For button, select and modal UX, normal Discord.js builders may embed this ID; they do **not** need a new CommandHandler branch.

`submitAction`/`applyAction` reject wrong user, unknown/expired/replayed action, wrong phase, stale game, unregistered participant, non-captain, insufficient organiser role, duplicate single-use response, or expired deadline. Editable responses may be changed before deadline. Values are size- and structure-validated JSON; do not put Discord tokens, unsafe objects or private responses in the custom ID or public messages. `onActionSubmitted` lets the implementation react to accepted, private input. `expireActions()` removes stale tracked actions; only configured stage activations (not individual answer expiry) receive scheduler jobs.

Important: **Actions are server-side game data**, not a replacement for the future scenario's Discord questionnaire/modal layout. Each implementation still designs its own question/answer presentation, private collection rules, and organiser summaries. Avoid logging answers. The coordinator's schema is bounded; put only necessary deterministic results/config in `data`, and keep per-user answers in action records when possible.

## Team proposals and captain results

`ScenarioTeamProposal` contains unique registered Discord IDs: `red`, `blue`, `undecided`, optional `captains: { red, blue }` and a known historical `method` (`RANDOMISED`, `ELO`, `BALANCE`, `DRAFT`, `SNAKE_DRAFT`). Proposal validation checks **every registered player exactly once**, both sides nonempty, team size difference at most one, match token and captain membership. The preview shows participant lists and mean Elo.

A proposal must first be `markReady()` and is confirmed through a `ScenarioTeamPickingSession` under the **same TeamCommand roster lock** used for ordinary team sessions. TeamCommand checks organiser role, rejects obsolete message buttons, syncs team/captain roles and only then emits the existing game-start prompt. A failed role sync warns organisers instead of asserting complete external state. A roster change during an unconfirmed preview prevents commit. `/team reset` invalidates scenario prep when its result depends on teams.

For a captain election use `confirmScenarioCaptains(guild, redId, blueId)` *after* the election is ready and organiser-approved. It verifies membership, updates Discord roles before committing `setTeamCaptain`, and completes the captain-selection scenario. Do not change `game.teams` or `captain` flags directly from your scenario's Discord handler.

## Persistence and restart recovery

`ActiveGameRecovery` continues to use schema version 1 with **optional** `game.organiserNoElo` and `game.scenario` fields so legacy snapshots work. Scenario state carries `id`, definition `version`, match lifecycle token, `config`, `phase`, `deadline`, `data`, `actions`, optional trigger runs (`status`, planned/actual activation times, frozen roster) and optional per-player prompt delivery records; the recovery validator checks schema, bounds, IDs, allowed values, game linkage and snapshot checksum. No scenario records are stored in global mutable maps.

Recovery **does not replay** questions, timers, draft picks or random offers. Noncompleted scenario states enter `needs_review`; old action collectors are invalidated, and start remains blocked until an organiser rechecks/resumes or cancels the scenario. Missing or version-mismatched implementations fail closed. Completed results remain completed when the implementation matches. Finished match history stores scenario ID/version and public metadata; intentionally **excludes private responses**. Avoid long-term retention of raw votes and consider privacy when implementing individual scenarios.

## Implementing a new scenario (concrete checklist)

Example: Mystery Dungeon team formation.

1. Read [mystery-dungeon.md](./mystery-dungeon.md). Implement questionnaire wording, private Discord UX and deterministic team-building logic in **its own small module**. Do not modify core registration or game lifecycle.
2. Export an object implementing `ScenarioImplementation`, e.g.:

   ```ts
   import type { ScenarioImplementation } from "../ScenarioTypes";

   export const mysteryDungeon: ScenarioImplementation = {
     validateConfig(config) {
       if (Object.keys(config).length) throw new Error("Mystery Dungeon has no configurable options yet.");
     },
     registrationPrompt(game, userId, customId) {
       // Build this player's private Discord controls (using customId).
       // Called after successful registration, not when the announcement posts.
       return buildPersonalityPrompt(userId, customId);
     },
     activateTrigger(game, trigger, rosterIds) {
       // At the "lock" trigger deadline: close responses, snapshot eligibility,
       // then calculate teams and present an organiser preview (not live roles).
       if (trigger.id !== "lock") return;
       game.scenarios.assertCapturedRoster("lock");
       return buildTeamProposalForReview(rosterIds);
     },
     async onRegistrationChanged(game, userId, joined) {
       // Remove references to departed people from any derived private data.
     },
     checkReadyToStart(game) {
       return game.hasFinalizedPlayableTeams() ? null : "Teams are not finalised.";
     },
     onCancel() {
       // Cancel any scenario-specific Discord collectors and timers.
     },
   };
   ```

3. Create scenario-specific Discord components with `game.scenarios.openAction`, use the shared router, and store only necessary versioned state. Use `markReady()` after validating results.
4. Present the result via `await TeamCommand.instance!.previewScenarioTeams(guild, {red, blue, undecided, method: "BALANCE"})`. Do not assign team arrays or roles yourself. On confirmed captain election, instead use `confirmScenarioCaptains`; for custom drafts use a specialised `TeamPickingSession` but still route final confirmation through `TeamCommand`.
5. Add all scenario-specific failure, deadline, dropout, nonresponse, roster-race and recovery tests with **offline** Discord/db fakes.
6. In `ScenarioRegistry.ts`, attach `implementation: mysteryDungeon` and `enabled: true` **only when steps 1–5 work**. Then re-register commands through the normal deployment process (outside this task). `/announce start` will automatically list it without a new special case.
7. Confirm `/debug-scenario` remains a **development-only** utility.

## Trigger policies, automatic activation and organiser controls

Each enabled scenario can opt into `ScenarioDefinition.triggers`. One definition may have **multiple stage policies**. The entry-point types are:

| Type | Entry point |
| --- | --- |
| `on_registration` | Per registered Discord user; one pending action per participant, editable if `allowUpdates` is true |
| `before_game_start` | Scheduled at `game.startTime - offsetMinutes` (typically T−15); optionally start early with `manual: true` |
| `on_captains_ready` | After both RED/BLUE captains have been assigned through the normal captain setter |
| `on_teams_finalized` | After authoritative role/team confirmation, not after a proposed preview |
| `on_draft_start` | When the draft automation reaches a scenario-owned draft, or when a compatible ordinary draft reaches its draft-turn callback |
| `manual` | Organiser-only explicit stage activation |

Policies use stable short `id` values. Optional `minPlayers`, `requireCaptains`, `requireFinalTeams`, `captureRoster` and `requiredPhase` constrain execution. `offsetMinutes` controls the scheduled deadline and may also override the registration-answer cutoff. The framework checks the current match, start state, completion, recovery gate, prerequisites and roster-operation lock **again at activation**. When a guild is available it reconciles participant membership before capturing identities. `activateTrigger(game, policy, rosterIds)` is the only scenario implementation callback for stage activation, regardless of whether a timer, lifecycle signal or organiser invoked it. It may open new actions, change collection stages through `markReady`, or leave the stage `active` while the scenario collects responses. It must not directly overwrite captains or live team arrays.

The per-stage statuses are `pending`, `scheduled`, `running`, `active`, `completed`, `missed`, and `failed`. `markReady` and `complete` advance the shared scenario phase independently of the trigger status. Only one execution per stage is admitted, including simultaneous manual/timer requests. `captureRoster` saves sorted unique Discord snowflakes; `assertCapturedRoster(stageId)` rejects a stale roster. `TeamCommand` also checks captured rosters before confirming a scenario captain result or team proposal.

Normal captain automation still runs at T−15 **unless** a scenario owns captain selection (e.g. People's Captains) or pre-empts team formation (e.g. Mystery Dungeon). For custom drafts with ordinary captains, auto-captain selection remains allowed but the next draft step dispatches `on_draft_start` instead of an ordinary snake session. Cursed Classes does not block ordinary captain/draft setup; its activation follows finalised teams. Stage ownership is driven by registry `capabilities`, not scenario IDs.

The scheduler is the existing recovery-aware `SchedulerUtil`. Each task is scoped to the announcement token and stage ID and is cancelled on scenario cancellation/reset/review; changing the start time through the announcement controls rearms the same stage at the new offset. If a target time has already passed, status is `missed` and **no automatic catch-up** occurs. An organiser can review and manually activate the stage if policy permits. Timer callbacks verify the match token, phase, live status, schedule and prerequisites before the implementation runs. A hook exception records a failure reason and pauses the scenario for review; it does not trigger a second draw or restart.

- `/game scenario status` - organiser-only private status: selected scenario, phase, stage timing/status, eligible count, completion and any blocker.
- `/game scenario start [stage]` - organiser-only early/manual activation; omitting `stage` selects the next pending manual-eligible stage. Exactly the same coordinator path handles scheduled starts.
- `/game scenario resume` - organiser-only explicit release from `needs_review`. Old actions and timers are **not replayed**. A future scenario must safely restore or re-create its pending interaction state before further gameplay.
- `/game scenario open` - registered participants reopen their own pending or editable private action, always ephemerally. Never exposes another player's response.

For registration entry points the scenario supplies `registrationPrompt(game, userId, customId)` returning private content and Discord component rows. The coordinator creates the owner-bound `fwsc:` action and delivery state before invoking this renderer, and it reuses the same action on retries. Self-registration sends an ephemeral follow-up; organiser-initiated registration and `/massregister` attempt a direct DM. If Discord delivery fails, registration remains intact and the player can run `/game scenario open`. The public registration announcement advertises this fallback when a scenario is selected. A single-use submitted action is not prompted again. Deadline expiry, roster changes, and game-token replacement reject stale buttons. No default placeholder questionnaire/vote is ever sent when a scenario lacks its actual UX hook.

A preserved restart restores validated trigger and prompt metadata but **never rearms timers or redistributes private actions**. Unfinished scenarios become `needs_review` and must be inspected before manually resuming or using the existing `/team scenario-fallback`. Earlier snapshots missing trigger fields remain valid. Completed matches only persist safe public scenario metadata, not private inputs.

### Example A - Mystery Dungeon (integration sketch, not implemented)

```ts
const triggers = [
  { id: "questionnaire", type: "on_registration", kind: "questionnaire", allowUpdates: true },
  { id: "lock", type: "before_game_start", offsetMinutes: 15, manual: true,
    minPlayers: 2, captureRoster: true, requiredPhase: "collecting" },
] satisfies ScenarioTriggerPolicy[];

// Future Mystery Dungeon implementation:
const implementation: ScenarioImplementation = {
  registrationPrompt(game, userId, customId) {
    // The scenario's own Discord UX builds a five-question select/modal UI.
    // Its controls carry customId. The foundation saves each private answer.
    return buildPersonalityPrompt(userId, customId); // supplied by that implementation
  },
  activateTrigger(game, trigger, rosterIds) {
    if (trigger.id !== "lock") return;
    game.scenarios.assertCapturedRoster("lock");
    // Lock the responses, calculate/propose teams from this roster.
    // Call game.scenarios.markReady(result) only after actual calculation.
    // Send a preview through TeamCommand.previewScenarioTeams(guild, proposal).
  },
};
```

At registration, the answer action opens privately. Its deadline is T−15 by default (or a policy-specific earlier offset); reopening allows edits. T−15 or manual `/game scenario start stage:lock` runs the same roster snapshot/lock logic once. The future scenario handles questionnaire scoring and proposal creation; an organiser still confirms teams through `TeamCommand` before match start. Late roster changes require review, not silent recalculation.

### Example B - The People's Captains

The election opens at T-35 and closes at T-20. It freezes the eligible registered roster, with at least four players, and creates one private three-person ballot per player. Every registered player is a candidate at opening. The organiser may manually open a missed stage before the deadline. After voting closes, the scenario calls `markReady()`; organiser approval uses `TeamCommand.confirmScenarioCaptains(guild, redId, blueId)` to verify the roster, commit captains and call `complete()`. That releases ownership of the normal draft at T-15. See [The People's Captains](./peoples-captains.md) for scoring, review and recovery.

## Remaining decisions for each implementation

Set question formats and timeouts, public progress indicators, how to handle nonresponse and tied results, rating policy for special scenarios, the precise organiser approval UX for captain-only selections, what private input is retained during recovery, and whether Cursed Classes relies on honour rules (the bot cannot enforce Minecraft class use). The foundation intentionally does not implement these scenario-specific policies or a multi-scenario composition engine. Scenario stage timers now reuse the existing `Scheduler`, not a new scheduling framework.
