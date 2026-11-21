# Organiser AI knowledge guide

**Community-readable organiser guidance.** These reviewed explanations are available to any verified server member; the commands and live organiser-only diagnostics still require their usual roles. This short overview distinguishes live bot memory, saved season data and external Discord effects. For concrete commands, see `organiser-game-ops.md` and `organiser-events-and-admin.md`; for read-only tool meaning, see `organiser-ai-tools.md`. `/ask` explains safe checks but never performs operations.

## How the bot works behind the scenes

A Discord command validates role, channel and game stage. The running bot remembers the announced game, roster, captains, teams, polls and transition progress; the database stores seasons, finished games and stats. Discord roles, voice moves and delivered messages are separate effects. A preview is not an announcement, an in-memory finish is not a saved match, and an announcement delivery failure does not establish that a season transition failed.

For any uncertain state, first identify which stage is confirmed. Use the read-only `/game diagnostics`, `/team list` and `/season status` as appropriate. A failed or timed-out mutation might have had partial effects; do not blindly replay it.

## Understanding game lifecycle states

`inactive` means there is no announced game in this process; `announced` means preparation may be underway; `starting` means a start transition is in progress; `started` means that transition was recorded locally; `finished` means gameplay ended in memory. `awaiting cleanup or shutdown` indicates unresolved end processing, not proof of a database commit. When diagnosing a stuck game or blocked recovery, use `/game diagnostics` and escalate to the responsible operator instead of forcing a transition or restart.

## Historical questions versus the live game

When separately enabled, read-only REST_API historical tools can report past seasons, named-player records, Ranked Elo observations and bounded finished-game counts. Historical REST_API records are a different source from current bot saved records, which are different again from current-process snapshots. For “my” past statistics, the server resolves the caller's linked Minecraft IGN. An unavailable historical service, incomplete archive or missing record is not evidence of zero results.

## Organiser privacy and AI boundaries

All members may read the reviewed operational explanations. Verified organisers can also use role-gated read-only process counters, but neither audience receives raw logs, private application answers, credentials, internal IDs, arbitrary project files or database access. The assistant cannot start, end, shut down, recover, restart or configure a game. If recovery is blocked, persistence is uncertain, or Discord delivery cannot be verified, stop state-changing retries and involve the trusted operator through established procedures. Do not copy protected records into `/ask`.
