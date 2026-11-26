# The Masked Draft

**Status:** Implemented. **Type:** alternate captain snake draft.

## How to play

Register normally. The organiser selects captains as usual and starts the scenario draft. Every other registered player receives a randomly assigned mystery card (M01, M02, etc.). Captains pick cards rather than names in the team-picking channel.

Choose based on evidence from recorded matches: a player who has won often with your captain, someone with a strong record on today's map, or someone who has earned MVP recently. Some cards have two clues, others are completely mysterious. Clues describe past results, not guaranteed future performance.

Only the active captain can pick or page through cards. The first pick has two minutes and later picks have one minute. If time runs out, the bot picks the first eligible card in the frozen shuffled deck. Picks follow snake order. The organiser confirms the finished draft before the masks come off; the game feed then shows each card, player, original clues and team.

## Example cards

These are illustrative synthetic cards, not actual player data:

- M01 - RED captain: 80%+ wins together
- M02 - Canyon: 60-79% wins · MVP in 2+ of last 10 games
- M03 - 20+ pts higher win rate with BLUE captain than RED
- M04 - 60-79% wins as captain
- M05 - Played Canyon 10+ times · Won 6-7 of last 10 games
- M06 - Mystery card

Each complete displayed description, including Mystery card when the pool is large enough, is shared by at least three candidates in the original undrafted roster. Smaller pools of fewer than three get only mystery cards. Two clues are paired only when they describe different dimensions of a player's history.

## Where the clues come from

All facts use recorded, finished team games in the past 365 days, regardless of Elo rating. The bot never uses self-declared roles, playstyles, Elo, exact rankings or untracked gameplay statistics.

- Current captain partnership: win-rate bands for games played together (minimum five shared games), a 60%+ winning record, or at least ten games together. A comparison between the two captains requires at least five games with each and a difference of at least 20 percentage points in shared win rates.
- Top lobby win-rate partner: compare same-team results with other current registrants, with at least five shared games and a win rate of at least 60%. Joint top partners qualify. Most-played lobby teammate requires at least eight shared games and may also be a joint best. Only already-public captains can be identified by their current team colour. Historical team colours are irrelevant to the clue; a masked teammate's name or card ID is never exposed.
- Today's map: win-rate band after at least five games on the selected map, or familiarity (at least five or ten games). If no map is selected, there are no current-map-specific clues. Other map clues include a uniquely highest eligible win-rate map (at least five games and 60% wins), or a most-played map with at least ten games.
- Captain experience: at least five recorded captain games, optionally with a win-rate band, regardless of team colour.
- MVP record: five or more recorded MVP awards, two or more in losses, or at least two in the last ten recorded matches.
- Recent form: a broad win count band across the last ten matches (0-3, 4-5, 6-7, 8-10). If the tenth and eleventh games have tied timestamps, no last-ten clue is generated. Recent form is lower priority than matchup and map evidence.

Rate bands are under 40%, 40-59%, 60-79% or 80%+; minimum sample requirements are applied internally, not appended to cards; game-count clues themselves still show a count band. Missing history does not imply poor ability. The bot chooses one or two true clues per card, prioritising useful partner and map records, then other historical evidence. A combined label is evaluated as a whole. Rare clues or combinations are withheld. If the bounded history lookup fails, times out or exceeds its row limit, all cards become mysteries.

## Anonymity and recovery

Card IDs and descriptions are generated once and stored in bounded private scenario recovery state before any cards appear. Only anonymous card IDs are sent as masked select values. Cards are displayed in shuffled card order, not registration or Discord ID order. Hints do not change after picks or navigation. Captains themselves are publicly known.

The mask is a gameplay mechanic, not guaranteed anonymity. Outside knowledge, public match histories and deliberate player communication can still help someone guess. Captains can weigh the evidence and make deductions, but players should not deliberately disclose their identities.

Late registration or withdrawal invalidates the frozen draft and requires organiser review. A restart preserves the private snapshot but does not automatically resume interrupted drafts; cancel the scenario and use a fresh normal draft if needed. No identities are published by the scenario until the authoritative draft confirmation succeeds. Roles and roster still need normal verification before starting the game.

Use /game scenario guide for a quick explanation or /game scenario status for organiser review.
