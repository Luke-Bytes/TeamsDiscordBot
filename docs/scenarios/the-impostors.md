# The Impostors - implementation preview

**Unavailable for live selection.** The registry contains the eighth definition with `enabled: false`. The existing guide preview remains informational; the live announcement menu and Navi's approved player knowledge continue to describe the seven released scenarios. Do not enable this by changing the flag alone.

## Intended player experience

Once normal teams are finalised, everyone gets a private role card. Check your DMs or use **Open My Scenario** / `/game scenario open`. Innocents play normally. Impostors try to win with their own team, finish any four of five secret missions, and remain undetected. You can reroll one unwanted mission before play. Everyone can optionally make an early guess.

One compulsory voice sabotage per impostor is assigned automatically. You can choose a short delay privately when its window opens, but you don't need to use Discord during the match. Only assigned sabotage is permitted in the authorised custom game. No sharing cards or screensharing in team voice chat. No additional physical missions have been introduced.

After the match, stay with your own team for four minutes, then vote privately for up to the assigned impostor count. Both teams have 90 seconds. Impostors then have 90 seconds to report completed missions privately. These are honour claims, not verified evidence. The bot shows the anonymous team mission lists, allows 45 seconds of speculation, and then reveals the impostors and results. Ordinary MVP activity resumes after ballots lock. Normal match results are independent of scenario achievements.

## Implementation and tuning

- `ScenarioRuntimeSession` and capability-gated coordinator hooks bridge final teams, normal start/failure, end, winner, roster invalidation, reset and intentional restart. Ordinary scenarios retain their existing preparation actions.
- `ImpostorRound`, `ImpostorMissions`, `ImpostorVoiceSlots`, `ImpostorScoring` and `ImpostorPrivateControls` own the match-local state. Shared `PrivateBallot` and `ScenarioRandom` support future scenarios. The minimum is eight per team; 8/9-15/16+ on the smaller side means 1/2/3 impostors per side. No player maximum is imposed. Predictions and final ballots support pagination, explicit submission or abstention, and majority positive-ballot quorum; cutoff ties remain unresolved.
- `ImpostorRuntime` schedules effects against announced time + 3 minutes, then +20/+30/+40 minutes for four-minute windows. All six effects are represented in shared `VoiceEffects`, `VoiceEffectService` and `DiscordVoiceEffectAdapter`. A missed or unsafe slot is void. There is no Minecraft telemetry.
- `DiscordStreamRestrictions` sets only the per-member Stream channel overwrite where required, preserves prior state and checks effective permission. Privileged users and active streams block preflight. It cannot prevent external sharing.
- `/game scenario status` provides the runtime status and organiser emergency stop; unresolved cleanup must be manually reconciled before confirmation. Role cards and private votes never enter the recovery snapshot. The existing match persistence receives only the final public projection (or void); no new database migration.
- The selected defaults are the reviewed recommendations, not additional product approvals. No Elo policy has been changed. Decide explicit rating policy before release.

## Cleanup and safety

Normal end cancels pending effects and restores recorded changes before discussion. Stream restrictions remain until ballots lock. Cancellation and intentional restart request cleanup, and unresolved changes block normal reset/shutdown. Inspect only the identified members/channels in organiser status and restricted logs (`event=scenario.voice.change`, `event=scenario.voice.channel`, `event=scenario.stream`). Do not blanket-unmute or delete unrelated channels. The manual acknowledgement is an organiser assertion after inspection, not an automated guarantee.

Unexpected process loss cannot reconstruct all private state or prove ownership of Discord changes. An unfinished recovered scenario is void, not replayed. Server flags or temporary channels can survive a crash. Same-value moderation changes cannot reliably be distinguished from scenario changes. Confirm logs are retained and access-restricted; staff should stop the scenario before changing an affected member's voice state. The organiser dashboard also offers a member selection to stop the scenario while preserving that member's reported staff voice action for manual reconciliation. A dedicated persisted effect journal was deliberately not introduced.

## Release gates remaining

- Resolve the pre-existing Mystery Dungeon compiler error and obtain a clean typecheck.
- Extend the mocked permission/voice adapter coverage to isolation creation/movement, partial failures and end-to-end coordinator lifecycle/recovery boundaries; the offline tests are not a substitute for these. Validate actual Discord permissions, member hierarchy, stream overwrites, disconnect and partial REST failure in separately authorised staging.
- Confirm bounded readiness/grace behaviour, test the explicit moderation-conflict handoff, restart receipt review, and end-to-end organiser recovery. The current implementation blocks start until role delivery or organiser cancellation; no automatic grace timeout is implemented.
- Confirm rating and release policy; ensure the live announcement discloses the scenario and rating. Only after the safety gates pass, promote the preview to canonical live metadata and update guide, announcement/feed, help, approved Navi sources/manifests and documentation tests. The temporary reviewed specification remains a design reference, not a live knowledge source.

## Validation recorded at implementation handoff

Full offline suite: 819/819 passed. New tests cover the catalogue, assignment and rerolls, private ballots, scoring, round transitions, six voice policies and service operations, partial/in-flight failures, fake-clock scheduling, paginated controls, and mocked permission/voice adapter cases. Typecheck remains blocked by the unrelated Mystery Dungeon TS7053 error. No live validation was attempted.

Reviewed design: [development specification](./the-impostors-development.md). No live Discord or Minecraft permission changes, deployment, or database migration were performed during implementation.
