# Optional Discord AI assistant (offline implementation)

The bot exposes `/ask question:<text>` as an **ephemeral**, opt-in assistant. It does
not listen to regular messages, invoke maintenance scripts, edit records or
perform Discord actions on behalf of a model. The built-in Discord commands
continue working if AI is disabled or its provider is unavailable.

## Activation prerequisites (not performed by this change)

**Off by default.** A deployment operator must explicitly review hosted data
egress/privacy policy, select a real entitled model, allocate a shared-account
budget and allowlist Discord channel IDs. Configure these **only after** test
guild approval and a deliberate live preflight:

| Variable                                                  | Meaning                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `TEAMS_AI_ENABLED=true`                                   | Explicit feature switch; omit/false disables                          |
| `TEAMS_AI_EGRESS_APPROVED=true`                           | Separate acknowledgement of external egress                           |
| `TEAMS_AI_CHANNEL_IDS=123...,456...`                      | Comma-separated Discord channel snowflakes, required                  |
| `TEAMS_AI_GROQ_MODEL=operator-approved-id`                | Required provider model ID; not selected from chat                    |
| `TEAMS_AI_DAILY_REQUESTS=50`                              | Optional per-process daily admission cap (1–200)                      |
| `TEAMS_AI_HISTORICAL_ENABLED=true`                        | Separate historical HTTP feature opt-in; false by default             |
| `TEAMS_AI_REST_API_ORIGIN=http://127.0.0.1:3000`          | Historical API origin (illustrative; use the actual approved address) |
| `TEAMS_AI_REST_API_APPROVED_ORIGIN=http://127.0.0.1:3000` | Independent exact-origin approval, including scheme and port          |

No sample model ID confirms real entitlement. The provider endpoint is fixed
at the official Groq HTTPS chat-completions route; the assistant cannot use a
user-supplied model, URL or arbitrary HTTP tool. No other provider is active
in this MVP. A provider error never triggers automatic cross-provider fallback.

### Credentials and HiveOps independence

Teams uses the **same existing provider account/key** without modifying HiveOps
or touching its gateway/socket, filesystem permissions, deployment or quota
ledger. With a separately supervised systemd Teams service, the operator can
reference the existing protected _source_ secret through Teams' own credential
copy, e.g. `LoadCredential=ai-groq:/operator-confirmed/secure/groq-key`.
The process looks up `$CREDENTIALS_DIRECTORY/ai-groq` lazily and refuses a
symlink/non-file; do not assume this path or service arrangement exists. For a
PM2-managed service, the operator must arrange a private `MC_AI_GROQ_KEY`
environment injection using the actual process-manager lifecycle. Do **not**
put keys in `config.json`, committed `.env` or process command lines.
No credentials are checked or logged when the assistant is disabled.

Separate direct clients do **not** share HiveOps' usage ledger. Default caps
allow 50 accepted questions per UTC day, 2 concurrent total, 2 per guild,
one in flight per caller and a 30-second user cooldown. These limits apply
also to organisers, even though the existing general command rate limiter
exempts the organiser role. The existing command safety filter still runs
before the AI pathway. Each question can
make up to 3 provider inferences (max 2 tool rounds, 4 tool requests/round,
500 output tokens/call), with 20s timeout per provider call, a 3s application deadline per read-only
DB tool, no automatic retries, and bounded response bodies. Limits are local to one process; restarts and
multiple processes do not provide durable shared-account accounting. Operator
must reserve enough account quota for HiveOps before switching on. This
prototype should **not** be enabled across multiple replicas without durable
cross-process quota coordination.

## Data and permissions

Only allowlisted guild channels are eligible. DMs fail closed. In dev mode,
only the configured dev guild is eligible. Each tool independently checks
fresh guild membership, and organiser-only `get_organiser_status` also
checks the configured organiser role. The `get_my_stats` query binds to
the actual interaction user's Discord ID. Models cannot supply this ID.
No event signup answer, personal form, password, private diagnostic field,
raw Prisma filter, SQL or write tool is available.

Existing bot-database public tools: `get_my_stats`, `get_player_stats` (exact
IGN), `get_leaderboard` (max 10), `get_season_summary`, and
`get_recent_games` (max 5). These still use bounded Prisma/SeasonService
reads. The separate REST_API historical tools below only run if independently
approved and do not replace these existing commands.

The public `get_current_game_state` tool obtains **one** synchronous
process-local view of registration, lifecycle, teams, counts, schedule and
public settings. Organisers receive additional verified-role-gated captain,
team-picking, class-ban, poll, timer, start/end/shutdown and recovery guidance
in that same call. Normal players never receive the operational fields.
Organiser-only `get_organiser_status` (active season and pending announcement
count) and legacy `get_game_diagnostics` remain available. The latter
preserves compatibility with the existing `/game diagnostics` command.

No tool exposes raw IDs, logs or private records. Ranked results may use
Elo; Relaxed uses wins and streak activity and never reports an Elo
ranking. Missing records are not zero values.

The knowledge store is built on first authorised request from an explicit,
heading-level allowlist in `src/ai/Knowledge.ts`. Two short overviews
(`docs/ai/player-guide.md` and `docs/ai/organiser-guide.md`) link to
focused player, statistics/tool and organiser workflow guides. Each approved
file has a single player or organiser audience. Some sensitive sections are
deliberately excluded even when present on disk; other Markdown, source
files, private event forms and operational logs are not indexed. Future
additions require a file-and-heading review, not directory scanning.

Retrieval refuses symlinks and files outside the project root, limits chunks
(maximum four), and records headings, line spans and content hashes. Player
requests are filtered **before** constructing the model prompt. Organiser-only
tool schemas are also withheld from players, and every tool rechecks role and
membership. The assistant rechecks permissions around each provider turn;
revocation prevents delivery of a privileged answer. The model has no
filesystem browsing tool. Bot-verified citations and the read-only data source
names are attached separately. Knowledge refresh is on process restart.

The bot replies ephemerally, suppresses Discord mentions, limits output
length, strips external links, and does not log raw questions, secret
values, source excerpts or provider bodies. It cannot stop a user from
voluntarily typing sensitive information, so player/organiser consent and
channel policy still need an operator privacy review before activation.

## Historical REST_API integration (read-only, disabled by default)

Set all three `TEAMS_AI_HISTORICAL_*` and `TEAMS_AI_REST_API_*`
settings shown above **only after** reviewing the actual deployment
destination, transport and data egress. The origin and its separate approved
origin must match exactly, including `http:` versus `https:` and port.
Only canonical IP-literal origins with no credentials, path, query or fragment
are supported: for a local server, explicitly approve an address such as
`http://127.0.0.1:3000` rather than assuming TLS or using a DNS hostname.
DNS hostnames, link-local/metadata addresses, redirects, arbitrary ports chosen
by a model, user-defined URLs and arbitrary request methods are rejected.
The application constructs fixed GET paths; never enable a model-controlled
proxy. Firewall policy and the actual REST_API service binding must still be
checked by the operator. An IP literal avoids DNS rebinding, but does not
substitute for destination validation by the operator.

| Public tool                     | Input                                  | Projected evidence                                                     |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `list_historical_seasons`       | none                                   | Up to 20 season numbers, types and active flags; explicit truncation   |
| `get_historical_player_stats`   | `ign`, `season`                        | Validated IGN, type, wins/losses/streaks; Elo only for Ranked          |
| `get_my_historical_stats`       | `season`                               | Same, using the caller's trusted Discord-to-Minecraft mapping          |
| `get_historical_elo`            | `ign`, `season`, optional `limit` 2–20 | Ranked-only Elo observations and derived observed changes              |
| `get_my_historical_elo`         | `season`, optional `limit` 2–20        | Same, bound to authenticated caller                                    |
| `get_historical_season_summary` | `season`                               | Count of completed game documents in a bounded scan and observed dates |
| `get_historical_comparison`     | `ign`, `firstSeason`, `secondSeason`   | Two verified seasonal public records and numeric differences           |
| `get_my_historical_comparison`  | `firstSeason`, `secondSeason`          | Same with trusted caller mapping; no model-supplied IGN                |

All IGN values must have 3–16 alphanumeric/underscore characters; season
numbers are integers from 1–10000. Only fixed routes are used:
`GET /api/player/:ignUsed?season=N`,
`GET /api/elohistory/:ignUsed?season=N`,
`GET /api/gameHistory?season=N`,
`GET /api/seasons`, and `GET /api/seasons/:number`.
The raw `GET /api/gameParticipation/:gameId` endpoint was inspected but is
**not exposed** to the LLM because its document contents are not needed for
these tools. `/api/custom-query` is never used.

**Bounds and failures:** Per incoming question, at most six REST_API requests
across all historical tool calls and rounds; no retries or HTTP redirects;
1.5-second per-read default deadline; 3-second tool deadline; 128-KiB
response cap; max 500 Elo rows inspected with at most 20 chronological points
returned; max 200 raw game documents scanned; max 200 seasons accepted with
20 returned. Game history currently has no upstream pagination or count
endpoint. If it exceeds a cap, the tool reports unavailable rather than a
misleading partial match total. When approval is absent, historical tool definitions are not offered to the model. No background sync or adapter cache is added:
requests read current upstream responses. The REST_API player controller
currently uses its own 60-second cache, so even a successful historical
player response may reflect that cache. HTTP 404 means not found; 429, 5xx,
timeouts, malformed structures, invalid dates and overlarge responses produce
controlled unavailable results without leaking API error bodies or stack
traces. Historical read failures stop further model inference for that tool
response, avoiding invented figures.

The REST_API `/player/:ignUsed` implementation currently resolves
`latestIGN`, not arbitrary old aliases, and performs its own season lookup
via a locally configured internal URL. The adapter does not repair upstream
availability or assert support for historic name changes. Its Elo endpoint
supplies dated observations, not a guaranteed season-opening checkpoint; the
adapter labels the starting and latest **observed** Elo. When the season type
cannot be verified, Elo is withheld rather than assigning a Relaxed Elo rank.

**External LLM data:** The provider receives the user question, approved
role-filtered guide excerpts, server-selected tool schemas, and the resulting
projected public DTOs. A successful historical DTO contains only validated
season/IGN/statistic/date fields, never raw player documents, Discord IDs,
Minecraft UUIDs, game IDs, MongoDB IDs or full match data. The authenticated
Discord ID is only used in a local trusted lookup, not exposed in the tool
arguments. Organiser snapshots contain counts/booleans and safe checks,
not player identifiers, recovery reasons or raw handles. Source labels
(`REST_API historical stats`, `current bot process snapshot`, or
`Teams bot read-only database`) are attached server-side to the Discord
reply. The current-game snapshot cannot verify durable commits, successful
Discord message delivery, open poll status or timer execution.

**Disable/rollback:** Set `TEAMS_AI_HISTORICAL_ENABLED=false` (or remove
either REST_API origin approval) to disable history requests without disabling
other AI functions. Set `TEAMS_AI_ENABLED=false` to turn off the entire
`/ask` command. No migrations, scheduled jobs, production config or
REST_API project changes are involved.

## Offline verification and live acceptance

`npm run typecheck` and `npm run tests` validate TypeScript and a fully
offline custom-runner suite (with globally blocked network fetch). New tests
cover provider fake HTTP text/function replies, invalid/oversize/401/429/5xx
responses, cancellation, bounded admission, read-only tool validation,
role denial, caller identity, REST_API fixture parsing, historical response
bounds, read budgets, redirects, origin approval, Ranked/Relaxed semantics, vetted sources,
symlink rejection, public/organiser isolation, forged role hints, mid-request
revocation, sanitised game snapshots, and disabled-mode behaviour. Neither these tests nor
this document prove provider entitlement, true Pi credential delivery,
actual Discord registration, provider costs or MongoDB performance.

**Not run / requires separate authorisation:** real hosted LLM requests,
real Pi credential/service inspection, production deployment, Discord login
and test-guild interaction, live REST_API endpoint validation, approved HTTP
transport/firewall preflight, MongoDB queries/migrations, provider quota or
cost checks, and modifications to HiveOps.

Before enabling: confirm actual service manager (PM2 vs systemd); approved
channels/test guild; hosted data egress consent (questions, vetted public
context, public player statistics, and organiser-only counts); entitled
model/key delivery; provider account spending and capacity reservation;
end-to-end guild permissions; reliable error responses and rollback via
`TEAMS_AI_ENABLED=false`. Future work may add Gemini with validated thought
signature continuation, shared quotas and explicit citation-quality review.
