# Temporary scenario match simulations

Run independently from the permanent suite, from the repository root:

```sh
node_modules/.bin/esbuild tests/temporary/run-scenario-flows.ts --bundle --platform=node --target=node18 --format=cjs --external:sharp --external:esbuild --outfile=dist/tests/scenario-flows.js
node dist/tests/scenario-flows.js
```

No live Discord, MongoDB, HTTP, or process restarts. Do not run against a live bot process. The runner denies HTTP and uses fake guilds, channels, membership, messages, role/voice state, a controlled scenario scheduler, and intercepted persistence/checkpoint/restart calls.

## What the simulations cover

| Scenario | End-to-end scenario path | Failure / safety checks |
| --- | --- | --- |
| Mystery Dungeon | 18 registered players, questionnaire, lock, proposal, approval, match | Incomplete answers, wrong owner, withdrawal/rejoin, absent responses; separate one-player attendance cancellation and next announcement |
| Partners in Crime | 20 registered, mutual preferences, consent, allocation, confirmation, match | Self-selection, unilateral preference, private non-consenting duo, stale controls across matches |
| People's Captains | 20 registered, frozen ballots, election deadline, approval, normal snake draft, match | No self-vote, early close refusal, insufficient turnout and normal-match fallback |
| Masked Draft | 20 registered, anonymous card picks, approval, match | No identity exposure in controls, stable card mapping, wrong actor, stale controls, withdrawal and normal-draft fallback |
| Draft Roulette | 20 registered, actual offered cards, reroll, full draft, match | Wrong actor, stale controls, withdrawal and normal-draft fallback |
| Captain's Wildcards | 20 registered, veto and switcheroo, completed normal draft, match | Credits consumed, both powers exercised, unique roster |
| Cursed Classes | 20 registered, completed normal draft, approved class pool, both captain submissions, six assignments, match | Invalid targets and duplicates, incomplete submissions, inaccessible class blocks start, cancel overlay and finish ordinary match |
| The Impostors | 16 registered, normal draft, secret role cards, mission reroll, readiness, actual runtime/voice adapters, both sabotage timers, discussion, ballots, claims, reveal, corrected winner | Production gate remains closed; role delivery required, wrong owner, stale actions, premature shutdown, restore permissions and remove owned isolation channels, roster invalidation |

Successful match paths include real serialized start, fake Discord role/VC assignment, duplicate start protection (common scenarios), actual end command, winner confirmation, MVP counting, shutdown, intercepted save and cleanup checkpoint, intercepted restart, role removal and scenario/lifecycle reset. Failure paths exercise the real coordinator and normal fallback, not fabricated outcomes.

## Boundaries

- Tests begin at confirmed announcement and inject registered players into the roster, invoking registration hooks. Full announcement slash-command, Minecraft account lookup and registration database validation are not repeated here.
- Standard snake draft uses the real selection mutation rather than Discord message parsing. Scenario draft controls use actual rendered component IDs.
- The persistence delegate is intercepted at the database boundary: this verifies the data passed to shutdown and its sequencing, not real MongoDB transactions or Elo writes. Captain plan DMs and live Discord permissions/rate limits are outside scope.
- Impostors is enabled only in an isolated test registry; this is not a release decision. The runtime simulation exercises randomly selected voice effects, not every possible sabotage assignment in one match. Existing focused tests remain important for recovery, timeouts and adapter failure cases.
- The temporary files are intentionally not imported by the regular test runner. Keep or remove independently after review.
