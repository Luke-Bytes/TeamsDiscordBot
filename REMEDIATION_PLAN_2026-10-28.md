# Production remediation plan — 28 October 2026

This is a code-inspection plan, not a deployment log. Production services, data, credentials and `scripts/` are out of scope.

## Lifecycle policy and invariants

- Announced but **not started** (`gameStartStatus === "idle"`): confirmed departed users are removed from all three current-game rosters and from any draft/preview. A departed captain invalidates the draft; cancel it and require new captains. Reconciliation precedes team generation and does not treat transient lookups as departures.
- **Starting**, **started** or **completed**: never automatically prune participants. The in-memory roster may be used for historical results/Elo, and the game-start boundary is guarded separately. Notify/log a departure but preserve its snapshot.
- Departure records are not deleted, and rejoining the guild does not automatically restore a registration. The user can register normally, subject to checks.
- One Discord user appears at most once across all team arrays, regardless of name or UUID. Late-signup/draft pools must be subsets of the live game membership. Cancelled/retired sessions cannot mutate new sessions; only the owning session's messages/buttons are actionable.
- A missing message is recoverable only for idempotent edit/delete cleanup. Uncertain member lookups must halt finalisation rather than silently drop a player. Discord roles are an external projection of the roster; partial failures require explicit warnings/retry, never false success.
- One timely initial interaction acknowledgement; deferred interactions are edited, not replied to. External lookup failures cannot become purported valid Minecraft identifiers.

## Prioritised work (confirmed vs suspected)

1. **P0 — roster and identity integrity.** Confirmed: `GameInstance.addPlayerByDiscordId` permits fallback with no UUID, appends duplicates and may persist an unchecked ID; `MojangAPI.primaryFallbackUsernameToUUID` returns the username on errors. Change UUID validation, safe stored-ID fallbacks, deduplicated insertion and removal, and test invalid API responses/outages. Scope: `src/api/MojangAPI.ts`, `src/database/GameInstance.ts`, `RegisterCommand.ts`, tests. Risk: legacy records may contain invalid IDs; do not migrate/delete them automatically.
2. **P0 — departures and reconciliation.** Confirmed: `GuildMembers` intent without `guildMemberRemove` listener; mass register skips membership check, role setting logs unknown member but retains it. Introduce a membership classifier (10007 vs transient errors), an idempotent pre-start departure handler, active-session sync and pre-generation reconciliation. Scope: `TeamsBot.ts`, `TeamCommand.ts`, `MassRegisterCommand.ts`, `GameInstance.ts`, team sessions and shared utility. Tests: undecided/team/captain/offline/repeated departures, temporary failures, rejoin, game-start state.
3. **P0 — interaction lifecycle.** Confirmed: `MassRegisterCommand` responds after sequential I/O; `UnregisterCommand` replies in advisory branches and then again; central handler retries expired initial replies and omits deferred error follow-up. Defer promptly, send exactly one result, distinguish 10062 and already-acknowledged. Scope: both commands, `CommandHandler.ts`, focused tests. Preserve punishment policy (current warning appears not to apply a punishment).
4. **P1 — session lifecycle and messages.** Confirmed: `TeamCommand.resetTeamPickingSession` fire-and-forget; previews update live game teams; `RandomTeamPickingSession` sends preview via the deferred interaction reply while drafts use channel messages; broad button IDs have no owning-message verification. Serialise generation/cancel/reset/button operations; guard by message ID (and state), await cancellation, stop draft timers, protect against stale continuation; safely handle 10008 on obsolete operations, never mask unrelated failures. Scope: `TeamCommand.ts`, both sessions, session base and `DiscordUtil.ts`. Risk: Discord message edits may fail after live in-memory changes; establish ordering and recoverable warnings.
5. **P1 — API reliability.** Confirmed: no lookup timeouts, unbounded sequential bulk requests, no 429-aware backoff, unsafe fallback response. Use timeouts, bounded Retry-After aware backoff, UUID/schema validation and stored identity reuse. Tests with mocked fetch.
6. **P2 — audit and observability.** Confirmed: `TeamsBot` maps console.warn to ERROR and console.error to INFO; errors log potentially sensitive raw request bodies. Fix levels, add context without secrets. Audit register, team, captain and player subcommands for late replies and partial mutations; make only focused corrections. Avoid invoking `npm run lint` (its format step would rewrite unrelated files); use read-only `npx eslint` and `npx prettier --check` on changed files. Build only with offline/local tooling; `npm run build` invokes Prisma generate but not the application.

## Validation stages

A. Existing offline baseline (`npm run tests`), inspect test harness and failures. B. Implement identity, parsing and interaction fixes with unit regressions. C. Implement departure/reconciliation and draft sync; exercise uncertain lookups and lifecycle states. D. Session/Discord message/error hardening; concurrency and stale-button regressions. E. Full offline suite, `npm run typecheck`, scoped ESLint/Prettier, safe build if locally available. Report all failing/timeouts without weakening assertions.

## Suspected causes / evidence needed

- 10008 may arise from moderator deletion, duplicate bot cleanup or interaction-response ownership; exact production event ordering is not in repository. Code paths prove lack of defensive handling, not which actor deleted each message.
- Reported 429 is observed, but whether primary or fallback API limits dominate needs production telemetry. Backoff and caching must avoid identity corruption.
- Discord role update can fail for missing member, missing permissions, or transient connectivity; only explicit 10007 warrants roster deletion. Unknown 10062 may reflect slow response or already expired response token; confirm from interaction timing.
- Timeout tests in tier-list finalisation and punishment expiry are reported baseline defects until reproduced independently.
