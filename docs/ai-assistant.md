# Optional Discord AI assistant

The bot exposes `/ask question:<text>` as an opt-in assistant with **public
answers in the configured server channel**; bot DMs remain private to their
recipient. Rejections of invalid or unauthorised requests remain ephemeral.
Navi supports casual conversation and concise game questions. FW means
Friendly War: this is a competitive community for Shotbow's Minecraft
Annihilation. Friendly Wars-specific instructions use approved guides, while
player statistics
or live server facts require verified read-only data. It does not listen to
regular messages, invoke maintenance scripts, edit records or perform
Discord actions on behalf of a model. The built-in Discord commands continue
working if AI is disabled or its provider is unavailable.

## Minimal setup

**Off by default.** `ai.enabled` is `false` when omitted. To use Navi:

1. Add **one** credential to the bot's private, uncommitted `.env` (or use the
   existing supported systemd credential mechanism). The only AI variables
   needed in `.env` are provider keys:

   ```dotenv
   # Choose whichever providers you intend to use
   MC_AI_GROQ_KEY=...
   MC_AI_GEMINI_KEY=...
   MC_AI_CLOUDFLARE_KEY=...
   ```

2. In `config.json`, set:

   ```json
   "ai": { "enabled": true }
   ```

   The existing `channels.botCommands` **must already be a valid Discord
   channel ID**; there is no separate AI channel allowlist. Other guild
   channels remain denied. Direct messages to the bot are allowed **only
   for members of the guild owning that configured channel**, with fresh
   membership and organiser-role verification. For Cloudflare-only setup, also set
   `"cloudflareAccountId": "YOUR_32_HEX_ACCOUNT_ID"` inside `"ai"`.

3. Restart TeamsDiscordBot, then use `/ask` in the configured bot-command
   channel **or DM the bot** as a verified member. DM availability requires
   normal global command registration (`dev.enabled=false`); dev-mode
   guild commands are restricted to the configured dev guild.

Setting `ai.enabled=true` **is the explicit administrator acknowledgement**
that the question, approved role-filtered documentation excerpts, advertised
read-only tool definitions, and safe projected tool results may be sent to an
external provider. Review the community's privacy and hosted egress policy,
service quota, and account entitlement before enabling. To disable, set
`ai.enabled=false` (or remove the `ai` block) and restart. No AI credential
is read and no provider request is made while disabled.

### Provider selection and credentials

Providers are selected **once per question**, in fixed priority order:

| Priority | Provider                            | Default model                | Credential             |
| -------- | ----------------------------------- | ---------------------------- | ---------------------- |
| 1        | Groq                                | `openai/gpt-oss-20b`         | `MC_AI_GROQ_KEY`       |
| 2        | Google Gemini                       | `gemini-2.5-flash`           | `MC_AI_GEMINI_KEY`     |
| 3        | Cloudflare Workers AI (direct REST) | `@cf/qwen/qwen3-30b-a3b-fp8` | `MC_AI_CLOUDFLARE_KEY` |

`MC_AI_CLOUDFLARE_API_TOKEN` is also accepted as a compatibility alias.
A provider without a valid credential is skipped. **Cloudflare Workers AI
requires a real account ID**, not derivable from its token: set
`ai.cloudflareAccountId` to your own 32-character hexadecimal Cloudflare
account ID. The token must have Workers AI permissions (typically Workers AI
Write). It uses `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/qwen/qwen3-30b-a3b-fp8`;
no AI Gateway ID, gateway URL or model override is used. Invalid/missing
Cloudflare account setup is skipped, and an administrator-facing explanation
is returned when there is no other usable provider.

For systemd, the bot also supports fixed per-service files
`$CREDENTIALS_DIRECTORY/ai-groq`, `ai-gemini` and `ai-cloudflare`.
Existing `LoadCredential=ai-groq:...` provisioning remains compatible.
Files are read lazily, refuse symlinks/invalid content, and take precedence
over environment keys if present. Inject tokens privately for PM2 or a local
uncommitted `.env`; never store real credentials in `config.json`, docs,
commits or command lines. TeamsDiscordBot does not read HiveOps secrets or
depend on HiveOps' gateway and quotas.

Model defaults, provider origins, output/timeout/temperature and rate limits
are central code constants. Providers receive native tool schemas; Gemini
retains opaque thought signatures in signed tool-call history, and Workers AI
uses its reviewed model-specific function calling. A model is never allowed
to select a URL or execute a tool itself. **There is no automatic retry or
cross-provider switch after a failed live request.** If a provider responds
with an error, that question fails safely, with no unexpected second egress.
Local admission denials are not provider errors: the bot reports whether a
question is already in flight, the short per-user cooldown is active, the
process is at capacity, or the UTC daily limit was reached. Each admission
denial is logged as `ai.ask outcome=denied reason=...`, with
`retry_after_s` for the cooldown and rolling-minute limit; none cause
an external AI request. The 300 daily allowance counts _questions_, not
provider inference rounds, which can be up to three for tool-using questions.
It is a local safeguard, **not a guarantee of any Groq/Gemini/Cloudflare
quota**. All three configured keys do not create load balancing: the first
available credential wins (Groq, then Gemini, then Cloudflare), and a live
provider failure does not trigger cross-provider retry.

Separate direct clients do **not** share HiveOps' usage ledger. Default caps
allow 300 accepted questions per UTC day **shared across all users**,
2 concurrent total, 2 per guild, one in flight per caller, a 5-second
per-user cooldown, and a second limit of **5 accepted questions per rolling
60 seconds per user** (both measured from accepted request starts). These
limits apply
also to organisers, even though the existing general command rate limiter
exempts the organiser role. The existing command safety filter still runs
before the AI pathway. Each question can
make up to 3 provider inferences (max 2 tool rounds, 4 tool requests/round,
1,024 maximum completion tokens/call, including model reasoning tokens), with 20s timeout per provider call, a 3s application deadline per read-only
DB tool, no automatic retries, and bounded response bodies. Limits are local to one process; restarts and
multiple processes do not provide durable shared-account accounting. Operator
must reserve enough account quota for HiveOps before switching on. This
prototype should **not** be enabled across multiple replicas without durable
cross-process quota coordination.

## Data and permissions

Guild /ask requests are allowed only in the configured `channels.botCommands`
channel, and answers there are public. **All reviewed player and organiser
workflow guides are community-readable**: any verified member can ask how
organisers announce, start, end or manage FW games. The organiser label
describes who performs the action, not who is allowed to learn about it.
A verified organiser may also request read-only, role-gated live diagnostics
in the guild channel or in a DM; that filtered answer is visible to the
channel when asked publicly. Ordinary members are not offered privileged
live tools, and neither audience can trigger a state-changing action through
AI. Bot DMs are also eligible, but **only for current members of the guild
owning that configured channel**: the bot resolves that fixed channel
through Discord, then fetches the DM sender's membership and organiser role
from the associated guild. Missing channels, failed membership checks, other
private interaction contexts, and arbitrary mutual guilds fail closed before
AI egress. In dev mode, only the configured dev guild is eligible; slash
commands registered to a dev guild cannot be used in DMs. Every tool independently checks
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
file has a player or organiser **topic tag**, not a secrecy classification.
All selected headings are reviewed for community visibility; private or
sensitive sections remain excluded even when present on disk. Other Markdown,
source files, private event forms and operational logs are not indexed.
Future additions require a file-and-heading review, not directory scanning.

Retrieval refuses symlinks and files outside the project root, limits chunks
(maximum four), and records headings, line spans and content hashes. It ranks
the reviewed guidance by question relevance, favouring player instructions
for general questions so organiser procedures do not crowd them out.
Organiser-only **live tool schemas** remain withheld from players, and every
tool rechecks role and membership. The assistant rechecks permissions around each provider turn;
revocation prevents delivery of a privileged answer. The model has no
filesystem browsing tool. Bot-verified citations and the read-only data source
names are attached separately. Knowledge refresh is on process restart.

The bot answers publicly in the approved guild channel, or privately in a
DM, suppresses Discord mentions, limits output length, and strips external
links and credential-shaped strings. The **final user-visible /ask reply**
(including server-generated citations) is logged as a single JSON-escaped
field **only after a successful Discord edit**, alongside provider, DM/guild
scope, latency and tool count. Provider failures are identified as
`outcome=provider_failed` with safe `error_kind` and `error_code` values
such as `finish_length` or `http_400`; they are not counted as successful
answers. No raw provider response/error body is logged. Groq now has a
larger maximum completion allowance, but short answers are enforced by the
prompt style instructions rather than a small token budget. The generic
slash-command audit also logs the **submitted parameter values**, including
the `/ask question`, under `args={"question":"..."}`. Subcommand arguments
retain their full paths, while recognised credentials, secret-named options,
resolved Discord objects and excessive text are redacted, omitted or capped.
Context-menu commands log the target ID. Unrecognised free-form secrets or
personal details **can still enter the logs**: redaction is best-effort, not
an assurance of privacy. Provider request bodies, read-only tool JSON and
source excerpts are not logged.

**PM2 stdout now contains user-supplied questions and potentially personal
command parameters and player-facing answers**, including in DMs. Restrict
operator access, review player consent/privacy policy, and configure log
retention and rotation. Inspect output using `pm2 logs` as an authorised
operator. Avoid posting raw logs publicly. Existing input safety filtering
still rejects unsafe slash inputs before command execution.

## Historical REST_API integration (read-only, disabled by default)

Historical access is a separate advanced opt-in: supply
`TEAMS_AI_HISTORICAL_ENABLED=true`, `TEAMS_AI_REST_API_ORIGIN` and
`TEAMS_AI_REST_API_APPROVED_ORIGIN` through a reviewed deployment configuration
(not needed for ordinary `/ask`). These are deliberately **not** enabled by
`ai.enabled=true`. Set them **only after** reviewing the actual deployment
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
other AI functions. Set `ai.enabled=false` in `config.json` to turn off the entire
`/ask` command. No migrations, scheduled jobs, production config or
REST_API project changes are involved.

## Offline verification and live acceptance

`npm run typecheck` and `npm run tests` validate TypeScript and a fully
offline custom-runner suite (with globally blocked network fetch). New tests
cover Groq, Gemini and Cloudflare fake HTTP text/function replies, invalid/oversize/401/429/5xx
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
`ai.enabled=false`. Future work may add shared quotas and further
citation-quality review.
