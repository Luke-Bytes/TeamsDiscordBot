# Draft Roulette

**Status:** Design proposal, not implemented. **Type:** alternate captain draft. Read [shared rules](./shared-design.md).

## Fantasy / promise

Captains can no longer scan the full pool and always take the obvious strongest player. **Each turn, the bot deals three randomly chosen available players; the captain must draft one of those three.** Players are still chosen strategically, but the constrained hand injects unpredictability, comebacks and funny "I had to pick you" moments.

The goal is a short, entertaining draft — not a long gambling-style system, and not a mechanism for hiding or punishing weaker players.

## Proposed v1 rules

1. Two captains are appointed or elected first and placed on RED/BLUE as normal.
2. Freeze the draftable player pool; recommend the existing **snake** turn order to reduce first-pick advantage. Captains themselves are not in the pool.
3. At the beginning of a captain's turn, sample **three different players** from all currently undrafted eligible players, uniformly and without replacement. If only two remain, show two; if one remains, automatically assign them to the side entitled to the final slot.
4. The captain selects **exactly one** from the displayed hand. The others go back to the general undrafted pool, so they may appear on later turns.
5. Each captain gets **one reroll token per entire draft**. On their own turn they may discard the offer and request a new random hand; the token is consumed only on a successfully acknowledged redraw. A redraw may overlap with the old hand, but avoid an identical hand if the remaining pool permits a different one.
6. An unacted turn uses the existing timer pattern (opening pick approximately two minutes, later picks approximately one minute in the present draft code). At timeout, **auto-pick uniformly from the currently shown hand**, not from the full pool.
7. Display every pick and update team sizes/mean Elo as the draft progresses. The proposed teams are finalised only by an explicit confirmation at the end.
8. Normal gameplay proceeds unchanged once teams are locked.

## Example

```text
DRAFT ROULETTE — RED CAPTAIN'S TURN
Pick 1 of your 3 players:

[ Alex — 1050 Elo ]  [ Blake — 1120 Elo ]  [ Casey — 1012 Elo ]

Rerolls remaining: 1
[Pick Alex] [Pick Blake] [Pick Casey] [Reroll]

Next turn: BLUE
```

If RED chooses Blake, Alex and Casey return to the pool. RED's reroll token remains untouched. BLUE then receives a new, independently sampled hand. The exact name and Elo formatting should follow current safe, escaped player-display utilities.

## Fairness and limits

- The captain can only draft someone displayed on the current hand. No direct text-command bypass of the offered candidates.
- New hand generation must be unbiased and tied to a stored turn ID. Refreshing a message or repeatedly clicking a button cannot reroll for free.
- A legal hand is fixed until the captain picks, spends a reroll or times out. If the remaining pool changes, invalidate the offer and regenerate **under the same turn** after validation, without awarding an unearned new token.
- No candidate may appear twice **within the same hand**. Candidates may appear on different turns.
- Rerolls do not change pick order, team sizes or who is captain. They are an optional tactical choice with identical starting allowances on both sides.
- With three or fewer players left in the pool, a reroll generally offers no meaningful alternative. Hide/disable the button and preserve the unused token.
- Existing late-signup rules may create a new draftable window; v1 should **freeze a roster before this mode** and ask organisers to reconcile later additions. Avoid changing hand probabilities midway through an active draft.
- Since randomness can create unbalanced rosters, show an organiser preview. Do **not** secretly alter the random distribution to force better Elo unless a clearly disclosed balance rule is chosen.

## Discord UX

- Public draft embed: captains, turn, team rosters, remaining players, reroll counters.
- Active captain's controls: pick buttons/select menu and reroll button. Others may view but cannot interact successfully.
- On timeout: "Time expired: the bot selected Casey from RED's offered hand."
- Reveal: normal completed roster and a brief "Roulette stats" note, such as total rerolls used. No fake "odds" or misleading advantages.
- Organisers can cancel the session under normal pre-start rules.

## Interaction with Captain's Wildcards

[Captain's Wildcards](./captains-wildcards.md) is an optional overlay, **not** required. The baseline Roulette scenario already supplies one reroll per captain. If a wildcard grants a redraw, the implementation must either disable that duplicate power or define a combined per-captain redraw limit explicitly. Veto-style powers need to filter the target hand without creating an impossible empty offer.

## Dropout, timeout and recovery behaviour

- If an offered player unregisters, remove that player and invalidate the hand; create a replacement legal hand only after roster reconciliation.
- If a captain disappears, pause and let an organiser replace them before drawing a new hand; no arbitrary opponent picks.
- If a redraw or pick response times out, check saved turn state before accepting further inputs, not simply generating another random offer.
- A restart should preserve the **exact current hand, already-made picks, reroll counters and timer state** if recovery is supported. Otherwise pause and require organiser review; no invisible reshuffle.
- If an odd roster prevents a legal even-team draft, use existing pre-draft handling or stop before starting; do not eject someone simply because they were never offered.

## Acceptance criteria

- Every legal hand has `min(3, available pool size)` unique current candidates.
- A valid pick assigns exactly the chosen offered player, once, and updates the next turn correctly.
- A failed, repeated or stale button press cannot grant extra draws or picks.
- Each captain has exactly one usable reroll unless a separately documented combination changes that rule.
- Timeouts choose from the **current stored hand**; same result is visible to all.
- Final teams are valid, previewable and committed only after confirmation.
- Cancellation, bot restart and roster change cannot leave a displayed hand secretly pointing to different people.

## Open decisions

- Should v1 use **snake only**, or allow traditional alternating draft as an organiser option? (Recommended: snake default.)
- Should captains see exact Elo, the current bot's normal public format, or broad bands?
- Do players enjoy watching all three cards revealed to everyone, or should the hand be captain-private until a pick? (Recommended: public for spectators.)
