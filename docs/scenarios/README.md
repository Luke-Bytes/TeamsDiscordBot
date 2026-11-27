# Friendly Wars scenarios - design catalogue

**Status:** All seven scenarios and their shared lifecycle are implemented and selectable from `/announce start scenario:`. The individual design documents retain proposed rules and future ideas; consult the current implementation for authoritative behaviour.

## Playing and managing a scenario

Use `/game scenario guide` (also linked in `/help`) to browse all seven scenarios privately, even before a game is announced. The dropdown includes a home page and a clearly labelled coming-soon preview of The Impostors. Announcements and the game feed reuse the same detailed scenario page, with a **Learn About Scenarios** button. The guide is read-only; private-action buttons appear when there is something to do. Ordinary games have no extra scenario page.

Current player-facing names, short descriptions and detailed rules are maintained together in `src/logic/scenarios/ScenarioMetadata.ts`. The registry and shared `ScenarioGuide.ts` renderer consume that catalogue. Update the metadata when mechanics change; the design documents below are historical proposals, not a second authoritative player guide. Information delivery is advisory and never changes the selected scenario or Elo policy.

Players register normally. The registration channel explains the selected scenario. Registration scenarios send a private prompt when the player joins, while other scenarios send instructions when needed. Where provided, **Open My Scenario** opens only the invoking member’s private editor. All private prompts show their deadline and whether participation is optional or required. Players can recover their own editor with `/game scenario open`; partial questionnaire or class assignment edits do not count as final submissions.

Organisers use `/game scenario status` for the current stage, scheduled transition, outstanding actions, delivery failures and contextual controls. The existing `/game scenario start stage:`, `resume` and `cancel` remain advanced/recovery alternatives. Team proposals and elections still require explicit organiser confirmation. To resend an editor, use `/game scenario open user:@Player`; the bot DMs that player, never the organiser. If private delivery fails, the player can use the public recovery button or slash command.

| Scenario | Player / captain action | Automatic progression and organiser action |
| --- | --- | --- |
| Mystery Dungeon | Optional five-question quiz; explicitly submit | Generate at T-15, confirm team preview |
| Partners in Crime | Optional private partner or no preference | Generate at T-15, confirm team preview |
| The People's Captains | Everyone is eligible; vote privately | Voting opens T-35, closes T-20; confirm elected captains |
| The Masked Draft | Captains pick anonymous cards | Draft entry follows captain/draft preparation; timeout picks, then confirm teams |
| Draft Roulette | Captains pick from offered hands; optional reroll | Same draft entry/confirmation; timeout picks from offer |
| Captain's Wildcards | Optional private power on eligible draft turn | Uses normal draft timing and team confirmation |
| Cursed Classes | Both captains submit three distinct enemy assignments | Approve pool via `/game scenario pool`; opens once teams and captains are ready; reveals after both submit; T-3 deadline |

Reminders are shared, scheduled against the action's actual cutoff, and sent at most once per action: five minutes before long deadlines or halfway through shorter windows (none for windows under one minute or optional wildcard turns). Completed, expired, replaced, cancelled and recovered actions do not receive stale reminders. Failed DMs are tracked per action; scheduled reminders do not repeatedly ping the public channel. Discord timestamps display in each member's local time zone.

Recovery deliberately does not replay collectors or notifications after a restart. An organiser must inspect, resume where supported or cancel. Interrupted drafts require cancellation/rebuilding. The existing roster, role and game-start safety checks remain authoritative. Cursed Classes is an organiser-enforced honour rule; class access reports block game start. No Elo policy is changed.

A *scenario* changes how one Friendly War is prepared or played. It should enrich the familiar announcement → registration → team selection → game → result flow, **not** create a separate match lifecycle.

## Scenarios in scope

| Scenario | Primary twist | Stage | Suggested first implementation |
| --- | --- | --- | --- |
| [Mystery Dungeon - Personality Test](./mystery-dungeon.md) | Five-question personality quiz guides the roster split | Before teams | Medium |
| [The People's Captains](./peoples-captains.md) | Personalised three-candidate ballots elect both captains | Captain selection | Medium |
| [Partners in Crime](./partners-in-crime.md) | Mutual teammate preferences influence balanced teams | Before teams | Small–medium |
| [The Masked Draft](./masked-draft.md) | Captains draft anonymous player cards; reveal later | Draft | Medium |
| [Draft Roulette](./draft-roulette.md) | Every pick comes from a hand of three candidates | Draft | Small–medium |
| [Captain's Wildcards](./captains-wildcards.md) | Each captain can spend one tactical draft power | Draft add-on | Medium |
| [Cursed Classes](./class-hex.md) | Captains assign three randomly chosen awkward classes to enemy players for the entire game | After teams, before start | Medium; voluntary in-game enforcement |

The seven above remain the only playable scenarios. [The Impostors (implementation preview)](./the-impostors.md) is registered but disabled until release validation is complete. Its [reviewed development brief](./the-impostors-development.md) is not live rules or Navi knowledge.

## Read first

[Implemented foundation and integration guide](./foundation.md) describes the actual registry, lifecycle, interaction controls, team confirmation, persistence, No Elo and the step-by-step process for enabling a scenario.

[Shared scenario design and integration rules](./shared-design.md) explains phases, the existing code, fairness, player/organiser UX, timing, recovery, permissions, persistence and gameplay-enforcement limits. **It applies to every scenario file.** Scenario-specific rules override suggestions in the shared design only where stated explicitly.

## Composability

For a first release, **one primary team-formation method per match**. For example, Mystery Dungeon and Partners in Crime should not both try to assign teams. Captain election can feed into a compatible team-formation method; Wildcards can attach to a compatible draft; Cursed Classes can run after any finalized team formation.

Suggested combinations once individual modes work:
- People's Captains → ordinary snake draft → Cursed Classes.
- People's Captains → Draft Roulette + Captain's Wildcards (limited to roulette-compatible powers).
- People's Captains → Masked Draft → Cursed Classes.
- Partners in Crime → organiser-appointed captains → Cursed Classes.
- Mystery Dungeon → captains chosen *after* team formation, using one eligible player on each side.

Do not silently combine modes or try to reconcile overlapping team assignment algorithms. The announcement preview should make the entire configuration visible.

## Design decisions versus unresolved choices

Each scenario document distinguishes:
- **Proposed v1 rules:** an implementable product direction, not yet approved behaviour.
- **Examples:** illustrative wording/values, not authoritative class strength or real player data.
- **Open decisions:** policy questions needing a product choice before coding.
- **Acceptance criteria:** behaviours an implementation and tests should verify.

The goal is an understandable player experience with minimal ceremony. A future implementation agent should check the *then-current* repository and Discord/Shotbow constraints before writing code; this catalogue is a blueprint, not an instruction to bypass safety or lifecycle guards.

## Relevant existing code

- `src/commands/AnnouncementCommand.ts` - preview, confirmation, maps, modifiers.
- `src/commands/RegisterCommand.ts` and `src/database/GameInstance.ts` - registered roster and live game state.
- `src/commands/CaptainCommand.ts`, `src/commands/CaptainNominate.ts`, `src/logic/AutoCaptainSelector.ts` - captain management.
- `src/commands/TeamCommand.ts`, `src/logic/teams/` - team previews, random/balance/Elo generation and draft sessions.
- `src/logic/CurrentGameManager.ts` - pre-game automatic captain/draft scheduling.
- `src/commands/SignCommand.ts`, `src/logic/EventService.ts` - **standalone event** form UX patterns only, not a ready-made scenario questionnaire store.
- `src/logic/ModifierSelector.ts`, `modifiers-config.json`, `src/commands/ClassbanCommand.ts` - existing modifier/class-ban system.
- `src/database/MatchPersistence.ts`, `src/logic/ActiveGameRecovery.ts`, `prisma/schema.prisma` - persisted matches and recovery compatibility.

**Command naming:** `/game scenario guide` is the player-facing guide. `/debug-scenario` (`src/commands/ScenarioCommand.ts`) is a development-only test fixture.
