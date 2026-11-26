# Mystery Dungeon - The Personality Test

**Status:** Design proposal, not implemented. **Type:** primary team-formation scenario. Read [shared rules](./shared-design.md).

## Fantasy / promise

Make joining a Friendly War feel like the opening of *Pokémon Mystery Dungeon*: players answer five lighthearted "what would you do?" questions, discover a playful Annihilation personality and then learn which team they belong on. It should produce surprise and conversation, **not** diagnose anyone's personality or rank their skill.

The quiz shapes team composition but **does not deterministically sort one personality onto RED and another onto BLUE**. Competitive balance remains important.

## Proposed v1 rules

1. Once the match is announced, every registered player gets a **five-question private** multiple-choice quiz, accessible from the registration/game feed prompt. Answering is optional but encouraged.
2. Each answer contributes one point to an archetype. Four archetypes are enough for v1:
   - **Guardian:** defence, safety, saving teammates.
   - **Pathfinder:** scouting, improvisation, unusual approaches.
   - **Strategist:** preparation, efficiency, careful tactics.
   - **Vanguard:** initiative, teamwork and coordinating decisive attacks.
3. Show the player's derived archetype privately when they submit, but save the **team assignments and full personality reveal** for the public reveal moment.
4. At the deadline, classify respondents, build two size-balanced teams with a reasonable Elo gap, then prefer a mix of archetypes on each side. An unanswered quiz produces **Unclassified** and is still included in matchmaking.
5. Show the organiser an Elo/player-count preview and the number of archetypes per team. They can confirm or cancel/recalculate if the roster changed. Do not let them "reroll" endlessly without seeing the consequences.
6. Once teams are locked, reveal players grouped by RED/BLUE with their personality labels. Afterwards, choose a suitable captain **within each team**, subject to normal captain/organiser permissions and player consent.
7. Optional flavour: suggest 1–2 *playstyles/classes* per archetype. This is **not** a forced class rule and should never imply that someone must play a particular class.

## Question bank

The quiz samples five distinct questions from the 25-question pool in `src/logic/scenarios/mysteryDungeon/QuestionBank.ts` for each player in each game. The pool mixes everyday preferences, silly situations, community jokes and Annihilation scenarios. Questions have two to four choices; each choice explicitly maps to one archetype independently of its display position.

The selected question IDs and order are saved with the player's answers, so reopening or editing the questionnaire cannot reroll it. Older recovered quizzes retain their original five questions to avoid reinterpreting saved answers.

Scoring: +1 to the matching archetype for each selected answer. Highest score wins; ties use the existing fixed archetype priority. The quiz is for fun and does not use Elo or historical stats to label personality.

## Allocation / balancing

- Build from the frozen registered roster, including Unclassified players. Do not make quiz participation a condition for playing.
- Hard constraints: every roster member exactly once; team sizes differ by at most one; one valid captain per side *after* allocation.
- Soft goals: small Elo difference; spread archetypes across sides where possible. Expose both goals in the preview.
- Suggested v1 optimisation: start from an existing Elo-balanced proposal; swap pairs of players across teams if the change improves archetype variety **without materially worsening** Elo balance. Make the threshold configurable/reviewable, not a hidden promise of mathematical optimality.
- A team may still have mostly one archetype if the roster composition forces it. Never guarantee otherwise.

## Discord interaction sketch

- Public: "Mystery Dungeon Night! 14/20 players have discovered their class personality. Quiz closes at HH:MM." No individual raw answers.
- Private: one question at a time, two to four answer options; **Back / Next / Review / Submit**. Players may edit until the freeze.
- Private result: "You are a **Pathfinder** - a player who spots opportunities others miss."
- Final public reveal: short personality summary + RED and BLUE roster with icons/labels. Only after roles are final.
- Organiser preview: answer count, nonrespondents, current roster version, mean Elo and archetype distribution.

## Edge cases and fallback

- No/very few quiz responses: still form normal Elo-balanced teams; announce that personality matching had too little data and show fewer/no personality labels. Do not cancel the match solely because nobody answered.
- Late sign-up before lock: give them the quiz with the remaining time. After lock: follow the normal late-signup policy; do not silently reassign already revealed teams.
- Unregistration or missing Discord member before confirmation: invalidate and recalculate the pending preview; do not put an absent member into a team.
- Tie score: deterministic, repeatable resolution; **do not** repeatedly change a player's archetype when they reopen their result.
- Captain appointment before quiz conclusion: if organisers already chose captains, either anchor them to opposite teams as a hard allocation constraint or require organisers to clear/reconcile those appointments **before** confirmation. Do not silently move a captain.
- Personal information: no psychological claims, sensitive questions or public raw responses.

## Acceptance criteria

- Five validated answers per completed quiz; returning to the form doesn't duplicate data.
- Every question/answer set has a reproducible personality result.
- Nonrespondents remain eligible and get balanced placements.
- Given a fixed roster/results, repeated preview generation is stable until explicitly recalculated.
- Confirming a roster produces valid RED/BLUE teams with sensible Elo and composition metrics.
- Raw quiz answers stay private; the public reveal contains only the personality labels and finalized teams.
- Cannot finalise after game start, from a stale lifecycle, or while a separate team-picking session is active.

## Open decisions

- Should players be able to hide their **archetype** from the public reveal? (Recommended: opt out of the label while still allowing team assignment.)
- How much Elo gap should be tolerated to preserve a better personality mix?
- Do playful archetype titles unlock anything beyond presentation? (Recommended: **no** gameplay advantage initially.)
