# /ask knowledge-base integration and offline QC report

**Review date:** 21 November 2026. **Scope:** TeamsDiscordBot checkout, curated /ask documentation, `src/ai/Knowledge.ts` and registered tool descriptions. This is an offline code/documentation audit, not proof of hosted-model answer quality or live Discord/database correctness.

## Disposition

**Approved for offline integration, subject to the normal operator review before any enablement.** Nine individual Markdown files and precisely **83 headings** are allowlisted. No other Markdown or repository source files are indexed. There are **five player-scoped files** and **four organiser-scoped files**; normal players cannot retrieve organiser files. The old overviews were shortened to 2 and 4 sections respectively, while specific command answers are in topical guides.

The current allowlist preserves file safety checks (regular file, symlink rejection, project-root containment, 25,000-byte maximum and secret patterns), source/line span/hash metadata and role filtering before ranking. New material is not approved merely by existing under `docs/`. The command coverage manifest and this report are not knowledge sources.

## Command coverage and exclusions

The registered command inventory has **52 commands**, all individually classified in `docs/ai/command-coverage.md` and cross-checked against `CommandHandler.loadCommands()` in an offline test:

- **full (27):** `/event`, `/sign`, `/announce`, `/leaderboards`, `/register`, `/need`, `/stats`, `/team`, `/captain`, `/registered`, `/unregister`, `/player`, `/winner`, `/mvp`, `/game`, `/captainnominate`, `/timestamp`, `/class`, `/season`, `/forfeit`, `/nickname`, `/spectate`, `/profile`, `/profilecreate`, `/titles`, `/wrapped`, `/vc`.
- **brief (15):** `/ask`, `/igns`, `/performance`, `/missing`, `/teamless`, `/plan`, `/massregister`, `/verify`, `/maps`, `/coinflip`, `/help`, `/website`, `/wiki`, `/season-recap`, `/tierlist`.
- **restricted (7):** `/recover-game`, `/restart`, `/punish`, `/punished`, `/username`, `/title`, `/scripts`.
- **excluded (3):** `/test`, `/cleanup`, `/scenario`.

**Full** means a focused approved explanation, not an AI ability to execute the command. **Brief** means a low-priority utility or user-facing pointer, normally to `/help`; the full developer or operational manual is not injected into context. **Restricted** means only safe scope, refusal conditions and human escalation are appropriate. **Excluded** means deliberately absent from hosted model knowledge.

In particular, the reviewed `/recover-game` reconstruction procedure, restart preservation, punishment expunging, and title-reconciliation operation steps remain outside the approved headings. The assistant may explain recovery blocks and recommend read-only diagnostics or an authorised operator, never bypass a safety gate or propose running maintenance scripts. `/username update` is documented as an organiser-only, verified account-correction route; it is not an AI action.

## AI tool coverage

All **16** registered read-only tools have reviewed schema/description checks:

- `get_my_stats`
- `get_player_stats`
- `get_leaderboard`
- `get_season_summary`
- `get_recent_games`
- `get_game_diagnostics`
- `get_organiser_status`
- `get_current_game_state`
- `list_historical_seasons`
- `get_historical_player_stats`
- `get_my_historical_stats`
- `get_historical_elo`
- `get_my_historical_elo`
- `get_historical_season_summary`
- `get_my_historical_comparison`
- `get_historical_comparison`

`get_current_game_state` is preferred for all current-game questions; it provides a public process-local snapshot to players and extra filtered readiness/recovery observations only to freshly verified organisers. `get_game_diagnostics` is a retained organiser-only legacy alias of the same process snapshot, not independent corroboration. `get_organiser_status` reads saved season status and pending announcement count. Current saved-season data tools are distinct from conditionally enabled REST*API historical tools; the history service uses separate bounded reads. All `get_my*\*` identities remain bound to server-resolved caller identities, with no model-supplied IGN for self lookups.

Descriptions distinguish inputs, purpose, returned fields, limitations and absent/unavailable/unsupported semantics. No tool can read arbitrary repository files, private event forms, raw logs, database documents or identifiers, or mutate a game. No limits, permissions, or registered tool names were expanded.

## Documentation and contradiction cleanup

- Removed duplicated registration, team selection, stats, event and lifecycle instructions from the two original overview guides, retaining basic signposts and audience/privacy boundaries.
- Restored the missing **Historical questions versus the live game** heading as an exact organiser-guide allowlist entry, without conflating REST_API historical records with current process state.
- Clarified `/register` reuse vs corrected Minecraft account ownership. Players seek organiser review; `/username update` may correct a primary association only after identity validation and conflict checks. An uncertain result requires verification before retry.
- Clarified `/announce cancel` as an unstarted-announcement action and removed misleading comparisons between internal preview/slash safeguards. Shutdown and persistence are explicitly different from gameplay end and Discord voice moves.
- Kept private event response/export details out of AI answers and excluded operator-sensitive restart/recovery, title reconciliation and punishment deletion procedures even though the underlying guides include some of them.
- Replaced stale wording in `docs/ai-assistant.md` that described only two available guides.

## Retrieval quality and why it changed

Approved prose now becomes complete paragraph-sized excerpts instead of fixed nine-line slices cut mid-sentence at 1,400 characters. Oversized paragraphs fail closed; the offline validator rejects any approved paragraph not represented intact. Command-name matches (`/team generate`, etc.), compound tool-name tokens (e.g. `get_my_historical_stats`), basic noun normalization, wins/losses/streaks statistics matching, and narrowly prioritised `my` history queries help focused answers rank above generic introductions. Exact duplicate paragraphs are not returned twice, and no approved heading contributes more than two returned excerpts. Role filtering, lexical deterministic scoring, citation hashes/source lines, **four excerpt maximum** and **1,400 characters per excerpt** remain enforced. No embedding/vector layer or automatic document scan was introduced.

The original expanded retrieval initially crowded out the authenticated historical stats entry for a realistic query; the offline question matrix caught this. It now finds the expected source within the first three excerpts for every tested case. This is evidence about retrieval and routing, not about whether a hosted model would answer correctly.

## Offline validation

- **`npm run tests`: 577/577 passed.** Includes 46 realistic role-aware retrieval/tool probes and baseline AI, recovery, event, command and persistence fake-based tests.
- **`npm run typecheck`: passed.**
- **Targeted ESLint:** passed for changed AI code and QC test.
- **Targeted Prettier:** passed for touched guides, AI code, test and manifest.
- Approved headings and files, role isolation, full/empty paragraph preservation, hashes and source spans, tool schemas, registered command manifest, obsolete slash-root/subcommand checks, unrelated-document relevance, and no-evidence safe fallback are regression-tested.
- No hosted LLM, live Discord, MongoDB, REST_API, production configuration, scripts under `scripts/`, deployment, restart or HiveOps change was executed.

## Remaining gaps and unsupported assertions

- Retrieved context and tool-schema visibility do **not** establish answer quality, reasoning reliability, cost, provider entitlement, privacy/consent approval or live permissions. A separately approved hosted-model evaluation is needed to measure actual answers, but none was made here.
- Unannounced future games, delivery of a Discord message/role/voice move, whether a poll is truly open, whether a timer will fire, and whether shutdown durably committed cannot be inferred from in-process snapshots. Human verification or an approved saved-state read is still necessary.
- Historical REST_API availability, coverage, old aliases, truncated Elo observations and bounded game-count scans cannot be independently verified offline; missing is not zero, and a season summary is not necessarily an exhaustive archive.
- A roster or identity correction that reports uncertain completion requires protected human verification; the assistant has no write actions. Private event answers, punishment details, raw operational logs and maintenance procedures remain intentionally unsupported.
- Brief/excluded commands are not fully explained in model context. The coverage manifest makes that a deliberate relevance/privacy choice, rather than a silent omission.
- Concurrent pre-existing repository changes were preserved; this review does not attest to the correctness of unrelated recovery, event, service or production changes already present in the working checkout.

## Exact approved file-level scope and heading allowlist

Only the following **literal level-two headings** from the named files are indexed. An unlisted heading in one of these files is **not** retrievable. File scope applies to the entire file, not to individual headings; no mixed-audience file is approved for players.

### `docs/ai/player-guide.md` — player (2 sections)

- Getting help with commands
- AI assistant privacy and limitations

### `docs/ai/player-actions.md` — player (12 sections)

- How do I join the next game? `/register`
- Can I register with a different Minecraft account or correct my IGN?
- How do I leave a game? `/unregister`
- Who is signed up, and what team am I on? `/registered` and `/team list`
- How do I volunteer to captain? `/captainnominate`
- How do captains ban classes? `/class ban` and `/class bans`
- How do I vote for MVP? `/mvp vote`
- Can a captain forfeit? `/forfeit`
- Our team needs a replacement: `/need`
- How do I propose a special game? `/game request`
- How do I ask to spectate someone's voice channel? `/spectate`
- How do I rejoin or stop spectating? `/spectate`

### `docs/ai/player-community.md` — player (13 sections)

- How do I apply for a tournament or standalone event? `/sign up`
- Am I confirmed or on the reserve list for an event?
- How do I view, edit or withdraw my event sign-up?
- How do I see someone's profile? `/profile`
- How do I create or edit my player profile? `/profilecreate`
- What titles can I earn or show? `/titles`
- How can I change my Discord nickname to my IGN? `/nickname`
- How do I create my own temporary voice channel? `/vc create`
- How do I lock, invite or remove people from my temporary VC?
- How do I check or delete my temporary VC? `/vc info` and `/vc delete`
- Can I get a personal end-of-season recap? `/wrapped`
- Where can I find maps, wiki links or a command list?
- How do I make a Discord timestamp? `/timestamp`

### `docs/ai/player-stats-and-history.md` — player (12 sections)

- /stats: player record and options
- /leaderboards: Ranked rating or Relaxed activity
- /season view: seasonal participation
- Ranked and Relaxed seasons
- Which matches change Elo?
- How a Ranked Elo change is worked out
- Elo bonuses and double-Elo matches
- Why statistics might not update yet
- Current bot records versus REST_API history
- What historical Elo observations prove
- Comparing two historical seasons
- Reading unavailable, missing and unsupported results

### `docs/ai/player-ai-tools.md` — player (8 sections)

- Choosing current, historical or in-progress evidence
- get_current_game_state — one public game snapshot
- get_recent_games — recently saved results
- Historical tools — conditional access and outcomes
- get_historical_season_summary — archived season activity
- get_my_historical_stats — authenticated old record
- get_my_historical_elo — my Ranked Elo timeline
- What /ask cannot conclude or do

### `docs/ai/organiser-guide.md` — organiser (4 sections)

- How the bot works behind the scenes
- Understanding game lifecycle states
- Historical questions versus the live game
- Organiser privacy and AI boundaries

### `docs/ai/organiser-game-ops.md` — organiser (17 sections)

- Announce a match: `/announce start`
- Announcement confirmation and edits
- Team generation: registered choices
- Team generation prerequisites
- Team review, reset and cancellation
- Captains: `/captain set` and `/captain randomise`
- Roster corrections: `/player`
- Starting a match is not ending or saving it
- Ending gameplay: `/game end`
- Recording a winner: `/winner set`
- Shutting down: `/game shutdown`
- Shutdown uncertainty: stop and verify
- Cancel an announcement: `/announce cancel`
- Diagnostics: what is observed
- Season status and authority
- First scheduled rollover versus ordinary rollover
- Deferred rollover and pending announcements

### `docs/ai/organiser-events-and-admin.md` — organiser (11 sections)

- Event drafting: `/event create` and `/event edit`
- Draft questions: `/event question`
- Event opening and validation
- Event navigation and privacy
- Capacity, deadlines and reserves
- Closing, reopening and finishing events
- Event role sync and delivery failures
- Punishments: `/punish add` and `/punish remove`
- Reading punishment status: `/punished`
- Player titles: `/title`
- Minecraft account corrections: `/username update`

### `docs/ai/organiser-ai-tools.md` — organiser (4 sections)

- get_current_game_state — organiser snapshot
- get_game_diagnostics — same operational snapshot
- get_organiser_status — saved season and announcement queue
- Recovery, finishing and persistent state

## Maintenance guidance

When a command changes, update its focused guide, the explicit heading allowlist (if wording or eligibility changes), and `docs/ai/command-coverage.md` together. Run the offline QC tests before permitting new context. Do not approve another guide simply to improve documentation counts: prove it answers an unsupported representative question without displacing stronger evidence or widening audience exposure.
