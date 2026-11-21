# Temporary /recover-game stress tests

These tests deliberately live outside `tests/run.ts`. They use an entirely
fake Discord guild/message history, fake Prisma delegate responses, and a
blocked HTTP fetch. They **do not** connect to the real Discord server or
database and do not execute deployment/maintenance scripts.

## Run (from the project root)

```sh
npx esbuild tests/temporary/run-recover-game.ts --bundle --platform=node --target=node18 --external:sharp --external:esbuild --outfile=dist/tests/recover-game-temporary.js
node dist/tests/recover-game-temporary.js
```

As of 21 November 2026 the suite covers **125 scenarios (125/125 passing)**:
the original 75 (previously 68 passing and 7 failing), plus 30 additional
adversarial cases, four post-game recovery guards, four IGN/UUID identity guards,
and twelve MVP-vote recovery guards. A nonzero exit code now indicates a regression.

The unaffected normal suite is run with `npm run tests`. These temporary
tests are not imported by the normal runner. The mock state and monkey
patches are cleaned up after each case, and no live Prisma calls are made.

## Original seven regressions (now fixed)

1. **Late sign-ups lost on recovery** — the registration parser finds late
   sign-ups, but `installDiscordRecovery` does not populate
   `game.lateSignups`.
2. **Late sign-up count not verified** — a truncated `Late Signups (N)`
   field is accepted by `parseRegistration`.
3. **Changed organiser/host bypasses confirmation** — editing the original
   announcement footer between preview and confirm is not detected by the
   proposal fingerprint.
4. **Changed season rules bypass confirmation** — switching the active
   season from ranked to relaxed after preview does not invalidate it.
5. **Changed player W/L stats bypass confirmation** — only ELO is included
   in the snapshot fingerprint; changed wins/losses/streaks are accepted.
6. **Edited team plans bypass confirmation** — the proposal fingerprint
   omits plans and their source message content.
7. **Unfinished draft accepted as a final started game** — a draft embed
   with a partially chosen team and players still "Up for Grabs" can
   produce a restorable `started` proposal without a finalisation signal.

The seven original failing assertions were preserved and now pass. Each
regression has a guarded implementation path; the test expectations have not
been weakened.

## Other coverage

- Full 26-player game; 8-player unranked game; complete and missing
  announcement/registration/team evidence; fully manual reconstruction
- Current IGN precedence over historical aliases, unique historical fallback with
  an organiser warning, duplicate current names/primary Minecraft UUID rejection,
  unknown/ambiguous users, missing stats, and duplicate players
- Discord message links, spoofing, channel access, timestamps, pagination,
  registration counts, wrong phase, malformed settings, and modified sources
- DB completed-game and pending-cleanup gates, pending restart snapshot,
  in-memory lifecycle conflicts, and read-only previews
- Verified MVP replies: voter metadata, escaped target IGN, team membership,
  captain/self-vote checks, duplicate rejection, preview fingerprint, and
  post-game time scoping. Both Discord.js legacy command names (`mvp`,
  `mvp vote`) are accepted; skipped votes report specific rejection reasons.
  A 24-player, 13-vote scenario verifies both teams and voter bonuses.
  Voter-bonus eligibility is reconstructed with votes.
- Organiser authorisation, five-minute expiry, cancellation, stolen controls,
  role revocation, stale source changes, simultaneous confirmation, lost
  response acknowledgement, and single-use buttons
- Additional tests for multiple announcements, cross-game roster reuse,
  wrong channel links, unreadable/pagination-truncated history, malformed
  or duplicated registration/team entries, actual draft ELO shortcode
  formatting and separate acceptance messages, missing approval, changes to
  source content/plan metadata/player accounts/season settings, overlong
  preview fields, an unannounced but partially populated game, organiser
  role revocation during verification, early and delayed game-end signals,
  unsaved /game end restoration, spoofed/cross-game end evidence, preview
  integrity and exclusive recovery admission with deterministic barriers

## Recovery limitations and controlled rollout

The command builds a **new in-memory** game ID; it does not reconstruct the
old UUID or restart Discord roles, voice moves, feeds, team selection timers,
votes, or other incomplete workflows. The organiser must explicitly choose
the correct phase and verify the private preview, including captain inference,
plans, late sign-ups and season rules. Recovery rejects ambiguous or truncated
evidence and blocks when the game, snapshot, matching saved game, database
cleanup or confirmation lock is unresolved. A /game end/MVP message alone is
not proof of persistence: with no matching saved game, selecting the started
phase restores the ended state and an approximate end timestamp. ELO
expectations are recalculated. Bot-authored /mvp vote confirmations in
team channels can restore votes and voter ELO bonus eligibility only when
Discord retains trustworthy interaction-user metadata and both identities
match the restored teams. The preview shows verified voter-to-target pairs
and warns about skipped replies. Missing or untraceable votes must be recast
before /game shutdown. Missing optional team-chat history is warned about,
not recreated. Avoid proceeding when an unreadable optional channel could conceal
post-game activity.

These are mocked/offline tests. Before enabling this on a test server, use a
nonproduction database and dedicated guild to verify real Discord edits,
deleted messages, permissions, pagination, two organisers confirming together,
and state after a subsequent bot restart. Never retry a recovery after an
uncertain Discord confirmation without checking `/game diagnostics` and the
current in-memory state. **Do not treat mock success as production readiness.**

## Cleanup

When no longer needed, remove `tests/temporary/recoverGameStress.test.ts`,
`tests/temporary/run-recover-game.ts`, and this README. The generated bundle
under `dist/tests/` can be deleted independently.
