# Shared design: scenario integration and safety

**Status:** Proposed cross-scenario requirements for future work. See [catalogue](./README.md). This is not an implementation specification for a replacement game engine.

## Desired player experience

An organiser announces a normal Friendly War with an optional named scenario. The public preview explains the twist **before players commit to registering**. Players register with the existing process and, if needed, receive a private Discord interaction (quiz, ballot or preference). The bot announces what happens next and a clear deadline. When the selection closes, an organiser reviews the result, and only then are captains/teams and Discord roles finalised. Play, winner selection, MVP and shutdown remain as normal.

Prefer direct Discord buttons/select menus/ephemeral responses over requiring players to use external sites or submit public text. Private questions, votes and preferences must not accidentally appear in a public registration feed.

## Current repository constraints (verify again at implementation time)

- One live game is managed through `GameInstance` and `CurrentGameManager`. Normal team generation is `random`, `elo`, `balance`, `draft`, or `snake` (`TeamCommand` and `logic/teams/`). The team-picking contract has `inProgress`, `finalized`, and `cancelled` states.
- Ordinary captain scheduling reminds at **T−20 min** and may select captains / auto-start a snake draft at **T−15 min**; a registration count below **15** can cancel the game at automatic-start time. The scenario must deliberately coordinate with this scheduling, not race it.
- A game with fewer than **20 active players** is currently marked no-Elo; Relaxed seasons are unrated. A scenario with 20+ players in a Ranked season is **not automatically unrated**. Do not assume novelty scenarios are exhibition games without an explicit policy and implementation.
- The persisted `gameType` and active-game recovery validation currently enumerate the five existing team methods. Adding a new method string without updating persistence, snapshots, diagnostics and recovery will break or misreport matches.
- The `/sign` questionnaire handles **standalone events**, not ordinary Friendly War registrations. Its button/modal UX is a useful pattern; its `EventSignup` records should **not** be repurposed as an implicit scenario store.
- Existing class bans and modifiers (`modifiers-config.json`) can conflict with scenario rules. The bot has Discord authority, **not** Minecraft server authority: class-use restrictions require voluntary compliance or human supervision.

## Suggested lifecycle

1. **Configure (announcement preview):** choose exactly one primary team-formation mode, optionally a compatible draft add-on and/or gameplay overlay. Set deadlines, show impact on normal captain/draft auto-flow, ensure selected options do not contradict map/class modifiers. Confirm and publish as part of the existing announcement transaction.
2. **Recruit (registration open):** player identity is their registered Discord snowflake linked to a valid Minecraft identity; changes to IGN should not create new participants. Capture any opt-in/answers with match ID and participant ID. Explain what happens to nonrespondents.
3. **Freeze and calculate:** at a clear pre-game deadline, lock the eligible roster/answers or explicitly recalculate after a membership change. Compute the proposed result, validate participants/teams, and publish a **preview** (not yet live roles). All participants must be unique; teams must be as equal in size as reasonably possible; each captain is on their own team.
4. **Confirm:** organiser accepts/rejects the preview; locking teams uses the existing serialised roster-operation and Discord role-sync approach. Do not commit team changes solely because a preview was rendered or an interaction timed out.
5. **Play and finish:** apply game overlays before `/game start`; communicate any voluntary gameplay rules to every affected player; then use the existing `/game end`, `/winner set`, `/game shutdown` path. Save scenario metadata alongside match history without changing ordinary Elo rules by accident.

Suggested state vocabulary for a future implementation: `configured → collecting → locked → ready → completed`, with `cancelled` and `invalidated` paths. This is *conceptual*; it is not a demand for a new framework or database model.

## Rules common to all scenario interactions

- **Who may act:** only verified registered participants can answer/vote; only a live member of the appropriate team can act as its captain; only authorised organisers configure, cancel, approve final rosters or override an issue.
- **Binding:** bind every interaction to a match/lifecycle token, owner, phase and deadline. Reject outdated, forwarded, double-submitted or post-start interactions with an informative message. Treat Discord API failure and duplicate clicks as normal conditions.
- **Membership:** removing/unregistering a player invalidates their answer and votes cast *as a player*; newly registered users may join only before the relevant freeze. If a roster change makes a published result invalid, return to a safe preview/recovery path, never silently leave ghost assignments.
- **Privacy:** private ballots, questionnaire responses, targeted picks and preference graphs should be visible only to relevant actors or organisers as needed. Publish summaries, not raw private answers or identities behind anonymous cards.
- **Randomness:** unbiased sampling/shuffle, no duplicate candidate in one hand, no self-vote, no identity appearing twice in a team roster. Fix a selection once displayed; interaction retries must not redraw outcomes. Keep enough server-side audit state to explain results without exposing private votes.
- **Deadlines:** explicit open and close times, visible completion counts, reminders, a defined nonresponse result, and a modest deadline extension when viable. Do not hold the match indefinitely for one missing player.
- **Player dropouts:** compute on verified membership at lock; ideally reject new changes during finalisation, or invalidate/rebuild the preview after a dropout. Never auto-remove a registered player simply because they did not answer a fun question.
- **Accessibility and tone:** avoid trick questions that embarrass players; use readable labels, no colour-only distinctions, and an option to inspect their own response before confirming. Do not imply a personality archetype or "bad class" describes a person's ability.
- **Moderation:** no arbitrary targeted harassment, personal data, unconsented permanent restrictions, game-breaking tasks or incentives to grief a teammate.

## Fairness and ratings

Two different considerations must be displayed separately: **competitive balance** and **scenario fidelity** (e.g., keeping a mutual pair together or respecting a captain's pick). For a v1, accept some Elo difference to preserve the scenario's identity, but show team player counts and Elo totals/averages in the organiser preview and warn on unusually large gaps. Reject impossible allocations rather than hiding them.

Choose an explicit rating policy per scenario **before** release. Suggested default: unusual role/class interference scenarios such as Class Hex should be opt-in **unrated exhibition** modes unless organisers and players agree on a fair competition policy. This is a product recommendation, **not** a capability of current `noElo` flags or season rules. Do not silently manipulate Elo calculation to enforce it.

If an optional restriction cannot be verified in Minecraft, the bot must say **"honour rule; organiser-enforced"**, not claim it automatically applies. No bot-side stats should imply automatic proof of class compliance.

## Interoperability / boundaries

| Primary selection | Compatible extension | Caution |
| --- | --- | --- |
| Mystery Dungeon | Later captain assignment; Class Hex | Not simultaneously with Partners in Crime or a normal draft |
| Partners in Crime | Later captain assignment; Class Hex | Cannot promise all preferences are satisfied |
| People's Captains | Standard draft, snake, Masked, Roulette | Election chooses captains, **not** teams |
| Masked Draft | Captain's Wildcards; Class Hex | Preserve masking in all embeds, logs visible to users and previews until reveal |
| Draft Roulette | Captain's Wildcards; Class Hex | Wildcard availability depends on offer count |
| Any finalised teams | Class Hex | Class pool must be valid for both sides; requires external honour-rule enforcement |

Default to **one** gameplay overlay. Combining more than one complex twist should be a deliberate future enhancement with cross-compatibility tests.

## Implementation guardrails and likely extension points

- Use small per-scenario modules for scoring/selection (pure logic), Discord interaction controllers for buttons/forms, and one safe finalisation path to `GameInstance`. Reuse existing `TeamCommand` roster locking and Discord role-sync semantics rather than writing seven copies.
- A future scenario record likely needs a **scenario ID/version, match ID, phase, configuration, deadlines, locked participant IDs, submitted inputs, random offers/assignments, result and confirmation status**. Choose persistence and retention deliberately; never assume in-memory sessions survive a restart.
- Include scenario type/version in saved games if needed for historical displays. Keep existing `gameType` semantics or migrate callers/recovery validation together. Captains' selections and player assignments must survive an intentional preserved restart where supported, or fail closed and require review.
- Before changing `AnnouncementCommand`, `GameInstance`, `MatchPersistence` or active-game recovery, inspect their latest state and project guardrails. The repository has concurrent work; do not erase it.
- Use the current permissions, identifier escaping, guild-member reconciliation and interaction expiry patterns. Race-check that a game has not started or changed before mutating roles.
- Existing `/scenario` is developer-only test fixture setup. Don't reuse its behaviour as though it were the player-facing feature.

## Minimum integration acceptance criteria

1. Scenario selection is visible before signups and cannot overwrite a running match.
2. A registered player can complete their one private interaction and review it; an unregistered or wrong-user interaction is rejected.
3. Expired, duplicated and prior-match interactions cannot change the current game.
4. Every locked roster player appears **exactly once** in RED, BLUE or an explicitly unresolved queue; nobody appears twice.
5. The organiser can preview/cancel safely without assigning team roles, and confirm only once.
6. Automated captain selection/drafting does not start over an active scenario; deadlines and safe fallback are clear.
7. A dropout, bot restart or Discord role failure produces a recoverable state and a truthful status.
8. Tests cover zero/one eligible candidate, odd/low registration counts, tied scores, no answers, large rosters, rejected selections and final save/recovery paths.
9. In-game honour rules are plainly labelled and never represented as server-enforced.

## Open policy decisions

- Which scenarios may affect Rated/Ranked matches, if any? How does an exhibition flag interact with the current season rules?
- Where does the scenario live in the announcement UX, and when can organisers edit/disable it?
- Should scenario responses be retained after the match? For how long, and who may see them?
- Which automations should run at T−20/T−15, and which should explicitly pause?
- Should **manual organiser override** be available before confirmation, with a visible reason/audit record?

Resolve these once for the whole feature area rather than allowing individual scenarios to implement incompatible answers.
