# Friendly Wars scenarios — design catalogue

**Status:** The shared [scenario foundation](./foundation.md) and optional announcement fields are implemented. **None of the seven player-facing gameplay scenarios is currently implemented or enabled.** These design documents capture the intended experience, suggested v1 rules, edge cases and acceptance criteria; they are not claims about completed scenario gameplay.

A *scenario* changes how one Friendly War is prepared or played. It should enrich the familiar announcement → registration → team selection → game → result flow, **not** create a separate match lifecycle.

## Scenarios in scope

| Scenario | Primary twist | Stage | Suggested first implementation |
| --- | --- | --- | --- |
| [Mystery Dungeon — Personality Test](./mystery-dungeon.md) | Five-question personality quiz guides the roster split | Before teams | Medium |
| [The People's Captains](./peoples-captains.md) | Personalised three-candidate ballots elect both captains | Captain selection | Medium |
| [Partners in Crime](./partners-in-crime.md) | Mutual teammate preferences influence balanced teams | Before teams | Small–medium |
| [The Masked Draft](./masked-draft.md) | Captains draft anonymous player cards; reveal later | Draft | Medium |
| [Draft Roulette](./draft-roulette.md) | Every pick comes from a hand of three candidates | Draft | Small–medium |
| [Captain's Wildcards](./captains-wildcards.md) | Each captain can spend one tactical draft power | Draft add-on | Medium |
| [Class Hex — Cursed Classes](./class-hex.md) | Captains assign three randomly chosen awkward classes to enemy players for the entire game | After teams, before start | Medium; voluntary in-game enforcement |

These seven concepts were selected for the roadmap. No other previously brainstormed scenarios are in scope here.

## Read first

[Implemented foundation and integration guide](./foundation.md) describes the actual registry, lifecycle, interaction controls, team confirmation, persistence, No Elo and the step-by-step process for enabling a scenario.

[Shared scenario design and integration rules](./shared-design.md) explains phases, the existing code, fairness, player/organiser UX, timing, recovery, permissions, persistence and gameplay-enforcement limits. **It applies to every scenario file.** Scenario-specific rules override suggestions in the shared design only where stated explicitly.

## Composability

For a first release, **one primary team-formation method per match**. For example, Mystery Dungeon and Partners in Crime should not both try to assign teams. Captain election can feed into a compatible team-formation method; Wildcards can attach to a compatible draft; Class Hex can run after any finalized team formation.

Suggested combinations once individual modes work:
- People's Captains → ordinary snake draft → Class Hex.
- People's Captains → Draft Roulette + Captain's Wildcards (limited to roulette-compatible powers).
- People's Captains → Masked Draft → Class Hex.
- Partners in Crime → organiser-appointed captains → Class Hex.
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

- `src/commands/AnnouncementCommand.ts` — preview, confirmation, maps, modifiers.
- `src/commands/RegisterCommand.ts` and `src/database/GameInstance.ts` — registered roster and live game state.
- `src/commands/CaptainCommand.ts`, `src/commands/CaptainNominate.ts`, `src/logic/AutoCaptainSelector.ts` — captain management.
- `src/commands/TeamCommand.ts`, `src/logic/teams/` — team previews, random/balance/Elo generation and draft sessions.
- `src/logic/CurrentGameManager.ts` — pre-game automatic captain/draft scheduling.
- `src/commands/SignCommand.ts`, `src/logic/EventService.ts` — **standalone event** form UX patterns only, not a ready-made scenario questionnaire store.
- `src/logic/ModifierSelector.ts`, `modifiers-config.json`, `src/commands/ClassbanCommand.ts` — existing modifier/class-ban system.
- `src/database/MatchPersistence.ts`, `src/logic/ActiveGameRecovery.ts`, `prisma/schema.prisma` — persisted matches and recovery compatibility.

**Naming collision:** the existing `/scenario` command (`src/commands/ScenarioCommand.ts`) is a developer-only test fixture. A future player-facing scenario command should be designed separately or explicitly migrate that command; do not confuse the two.
