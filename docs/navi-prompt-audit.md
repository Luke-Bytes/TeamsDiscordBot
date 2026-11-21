# Navi `/ask` context and prompt audit

**Date:** 2026-11-21  
**Scope:** Source-level, offline review of TeamsDiscordBot `/ask`. No provider, Discord, MongoDB or REST_API calls. This is not a hosted-model answer-quality evaluation. The audited changes were transferred to the original repository checkout without editing concurrently maintained `docs/ai/*`, `Knowledge.ts` or `AiTools.ts`. At transfer, the original checkout was on `season-recap-refactor`; no local `main` branch existed.

## A. What is actually sent

| Stage/source                   | Provider input or server action                                                                                                                                                                                                                                     | Why it exists / necessity                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AskCommand.execute`           | Only opted-in, enabled `/ask` calls in approved guild channels; question trimmed, 3–450 chars, with a basic credential-pattern rejection; ephemeral response                                                                                                        | Server-side gate; not sent as instructions. The raw accepted question **is** sent to the provider.                                                                                                                                                           |
| `AiAssistant.answerAiQuestion` | Fresh Discord membership check, role-derived audience, approved evidence retrieval                                                                                                                                                                                  | Critical privacy boundary: a prompt cannot claim organiser access.                                                                                                                                                                                           |
| `AiPrompt.buildNaviMessages`   | **Two system messages**: Navi identity/behaviour/grounding/security/tool limits, then player vs verified-organiser audience                                                                                                                                         | Necessary rules and role separation; concise and separately maintained.                                                                                                                                                                                      |
| Same builder                   | **One user message**: `Question: ...`, followed by up to four evidence blocks `[E#] file#heading:\nparagraph`; explicit untrusted-data label                                                                                                                        | Grounds command/rules answers. Headings help relevance; SHA-256 hashes and line ranges are no longer repeated to the model.                                                                                                                                  |
| `Knowledge.ts`                 | Paragraphs from an explicit approved-file-and-heading allowlist: five player guides and four additional organiser guides, scope-filtered **before** ranking; up to four paragraphs, each at most 1,400 characters, max two per heading                              | Necessary selective evidence. No arbitrary file retrieval, symlink following, entire-guide dump or private docs. Cached on first authorised command, not reread per `/ask`.                                                                                  |
| `AiTools.ts`                   | Fixed JSON tool schemas. Six player-visible local tools without historical approval; eight for verified organisers. If historical approval is enabled, eight historical schemas are added (14 player, 16 organiser)                                                 | Needed only for live/saved/historical questions. Schemas remain unchanged and bounded, including no caller-provided identity for self-tools.                                                                                                                 |
| `AiPrompt.toolsForAsk`         | Omits **all** tool schemas only for an exact, timeless command-help phrase with matching approved documentation; otherwise offers the original role- and feature-filtered set                                                                                       | The largest safe saving. Questions with extra clauses, dynamic intent, ambiguity or no approved excerpt still have full applicable tools.                                                                                                                    |
| `GameReadSnapshot.ts`          | `get_current_game_state` returns a process-local, audience-filtered snapshot. Organisers also see operational flags, counters and safe next checks                                                                                                                  | Current observations, **not** proof of DB persistence, real Discord delivery, active poll or timer execution. `get_game_diagnostics` is a legacy alias of this snapshot.                                                                                     |
| `AiTools.executeAiTool`        | Only fixed approved read-only operations: server-bound self and named public statistics, season summary, leaderboard, recent saved games, process game state, organiser status, conditional historical tools                                                        | Tool arguments are parsed against explicit allowlists and checked against fresh membership. No raw DB, arbitrary URLs, writes, shell access or private records.                                                                                              |
| `HistoricalStatsClient.ts`     | Optional fixed-route REST_API reads, bounded and projected into public DTOs; up to six shared upstream reads per `/ask`                                                                                                                                             | Distinct from saved bot records and process memory. Errors/not-found/unsupported are explicit; never infer zero from absent results. No historical endpoint is model-selected.                                                                               |
| `GroqClient.ts`                | Chat-completions request with fixed model from operator settings, temperature 0.1, max 500 completion tokens, non-streaming and no parallel tool calls                                                                                                              | Transport contract. Nothing in this audit changes the provider/egress settings.                                                                                                                                                                              |
| Multi-round context            | Up to two sequential tool rounds and one final answer inference. Each subsequent call resends the two system messages, original user/evidence message and prior assistant tool calls plus JSON tool results; schemas are resent in rounds 1–2 and absent in round 3 | Required by stateless chat-completions; notable repeated cost. Each round verifies membership before and after inference. Tool results are JSON-serialized, capped at 4,000 characters or replaced by `result_too_large`; at most four tool calls per round. |
| `AskCommand` output            | Up to three **server-derived** `file (heading, lines, hash)` citations and data-source category labels, appended after output sanitisation; 1,850-char final Discord cap                                                                                            | Not instructions to the model. Model response itself is bounded/sanitised (links, mentions and code fences), then returned ephemerally. Never log raw prompts or evidence.                                                                                   |

There is **no cross-request conversation history** injected. The user's Discord ID, guild ID, role-verification details and provider credential are handled server-side, not included as prompt metadata or model-controlled tool arguments. Dynamic active-season/game information arrives through typed tools, not hardcoded per-request prompt text. The provider still sees approved public data from tool responses, including player IGNs and permitted organiser diagnostic summaries.

## B. Audit findings

1. The prior core prompt repeated several security and uncertainty concepts, while leaving the assistant unnamed and giving no specific tone or direct-answer default.
2. The model received full source line spans on every excerpt even though the server independently appended authoritative citations. Keeping `file#heading` retains context without the extra location text.
3. All role-permitted JSON schemas were sent even for an unambiguous `How do I register?`. With historical tools approved, this alone cost about 1,831 estimated tokens for a player.
4. Tool descriptions duplicate some source/data-scope guidance, but **were not modified** because they are shared with the documentation/retrieval integration work. The documented `get_game_diagnostics` alias duplicates the preferred `get_current_game_state` in model choice but remains for compatibility.
5. All tool schemas and the original evidence are resent on subsequent inference rounds. That repetition is partly unavoidable with this stateless endpoint; large result projections and a speculative broad schema router were not introduced to avoid correctness regressions.
6. The unsupported-question fallback is safe, but an unrelated query can still cause one inference with tool schemas. A future local out-of-scope filter would require evaluated recall tests before replacing it.

## C. Navi's final personality and answer defaults

Navi is a friendly, calm, lightly playful **AI** guide, not a real player or organiser. She answers in roughly 1–3 sentences by default, adds useful steps when needed, and avoids greetings, catchphrases, repetitive introductions and generic AI disclaimers. She uses approved guides for command explanations; typed tools for observed statistics or state; and clear uncertainty labels for missing, failed or incomparable evidence. She does not claim to repair games or verify persistence from process memory.

Examples of the intended style (illustrative, **not** observed model outputs):

- **Registration:** “Use `/register` while registration is open. You'll need your Minecraft username; an organiser can help with an existing linked-account change.”
- **Elo delay:** “The result might not be saved yet. I can check the available saved stats, but I can't verify an unsaved result.”
- **Organiser recovery:** “I can't change the game directly. Check `/game diagnostics` and confirm the lifecycle state; if recovery is blocked or persistence is uncertain, stop retries and involve the trusted operator.”
- **Unsupported:** “I couldn't verify that from the approved information. Try `/help` or ask an organiser.”

The prompt text is in `src/ai/AiPrompt.ts`, separate from enforcement code.

## D. Implementation

| File                                                | Purpose                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/AiPrompt.ts` (new)                          | Compact, role-separated identity/behaviour/security prompt; concise evidence formatting; conservative, documented-command no-tool selector.                                                                                                                                         |
| `src/ai/AiAssistant.ts`                             | Uses central message builder; reuses the selected tool schemas across permitted rounds; rejects a model tool call not in the offered schema set, in addition to existing server-side validation. Keeps original membership, timeout, response/citation and tool execution controls. |
| `tests/cases/naviPrompt.test.ts` (new)              | Deterministic identity and safety checks, static-vs-dynamic tool gating, source metadata, forged calls, role boundaries, injected tool text and before/after context-size comparisons.                                                                                              |
| `tests/run.ts`                                      | Registers the new offline tests in the usual suite.                                                                                                                                                                                                                                 |
| `tests/navi-only.ts` (new) and `tests/run-tests.js` | Opt-in `NAVI_TEST_ONLY=1` AI-only test entry. Default full-suite behaviour remains unchanged.                                                                                                                                                                                       |
| `docs/navi-prompt-audit.md` (new)                   | This audit, metrics, reproduction and known limitations.                                                                                                                                                                                                                            |

No edits were made to `AiTools.ts`, `Knowledge.ts`, `docs/ai/*`, HiveOps, command permissions, database operations, provider settings or integration configuration.

## E. Token-size estimates

Estimator: `ceil(UTF-8 bytes of JSON-serialized input / 4)`; **not exact provider token counts**. The offline test snapshots the pre-change prompt builder verbatim, retrieves the same local approved evidence, uses the same unchanged tool schema definitions, and simulates the same read-only DTOs and tool rounds before/after. It counts the message and schema payload for each inference; excludes fixed provider envelope and hidden tokenizer framing. The multi-round example sums three inference inputs. Historical access is simulated as enabled for a worst-relevant schema comparison.

| Scenario                                                              | Before | After |     Reduction |
| --------------------------------------------------------------------- | -----: | ----: | ------------: |
| Simple command help: `How do I register?`                             |  2,734 |   885 | 1,849 (67.6%) |
| Player guide: captain class bans                                      |  2,400 | 2,386 |     14 (0.6%) |
| Player stats (one tool round)                                         |  5,156 | 5,110 |     46 (0.9%) |
| Organiser diagnostic (one tool round)                                 |  5,225 | 5,201 |     24 (0.5%) |
| Historical stats (one tool round)                                     |  5,207 | 5,161 |     46 (0.9%) |
| Multi-round historical observations (two tool rounds, final response) |  6,124 | 6,052 |     72 (1.2%) |
| Unsupported query                                                     |  2,222 | 2,210 |     12 (0.5%) |

Component example, player static help: core instructions **275→282**, player audience **70→55**, tool schemas **1,831→1**, question-plus-evidence **553→541** estimated tokens. The 7-token core increase is intentional to give Navi a real identity; schema omission drives the useful improvement.

The regression suite enforces a **core-instruction budget of under 400 estimated tokens** and a **combined first-turn component budget of under 8,500 estimated tokens** for its seven scenarios. Tool results are represented by deterministic fixtures, not synthetic claims of real game state. Changes to docs/tools may change these estimates: rerun the measurement after integration.

**Reproduce (offline, from the original checkout with installed dependencies):**

```sh
NAVI_TEST_ONLY=1 npm run tests
```

The test logs `NAVI_CONTEXT_ESTIMATES` and the scenario breakdown. On an isolated checkout lacking dependencies, `NODE_PATH` can point at an existing offline package tree and `PRISMA_QUERY_ENGINE_LIBRARY` at a local Prisma binary; neither requires a hosted API.

## F. Preserved security and residual risks

Preserved: opt-in/egress/channel/ephemeral gates, credential-pattern question check, fresh membership before/after every model inference and each tool, organiser-only evidence and schemas, strict tool argument validation, server-bound self identity, fixed read-only DB and REST_API paths, response-size/time/request limits, no arbitrary filesystem/network/shell access, sanitised Discord replies, server-derived citations, and historical not-found/unavailable handling.

Added: **even if a model fabricates a function call, it cannot execute a tool absent from the schemas offered for that question**.

Still important: prompting cannot guarantee that the provider always ignores malicious data, nor that it consistently chooses a tool or writes a pleasant answer. Retrieved text and some projected database fields can be adversarial inputs; they remain data messages, not instructions. The server cannot verify live Discord delivery or persistence from game snapshots. Citation lists identify supplied passages, not a verified claim-by-claim entailment. Exact cost depends on the deployed provider tokenizer, models and replies.

## G. Offline verification and limits

- AI-focused suite: **45/45 passed** both in an isolated, sample-based test context and subsequently in the original checkout. Prettier checks and `git diff --check` passed in the isolated context.
- Strict `npm run typecheck`: **passed in the original checkout**. An earlier isolated-context attempt could not resolve its external package types; the original checkout has its normal local dependencies.
- Full suite: attempted but **did not pass** with that sample-only config; unrelated role-mapping and active-game recovery tests require environment-specific fixture values. Those failures are not attributed to Navi changes. No production config was inspected to work around them.
- Tests exercise prompt construction, read-only projections, role boundaries, tool rounds, safe fallback and deterministic context sizes. They **do not** prove hosted-model compliance, answer quality, latency, true provider usage or in-guild correctness.
- No live Discord, MongoDB, REST_API, Groq or maintenance scripts were called; no deployment, restart or HiveOps changes.

## H. High-value follow-ups (integration review, not implemented here)

1. Run a small, approved offline/provider evaluation later for directness, uncertainty, safe organiser guidance, tool selection and citation fidelity, especially with injected text. Static tests only check the instruction envelope.
2. Consider a **high-recall** intent router for unambiguous live-stat or historical requests, but only after measuring mixed-question false negatives; over-restricting the model's tools is worse than modest schema cost.
3. Coordinate with the knowledge/tool integration agent before removing the legacy diagnostic alias from offered schemas, trimming repeated descriptions or changing excerpt retrieval. Preserve compatibility and existing permission boundaries.
4. If provider costs justify it, evaluate a conservative out-of-scope prefilter so wholly unsupported queries do not consume a hosted inference; keep safe fallthrough for unknown supported command variants.
