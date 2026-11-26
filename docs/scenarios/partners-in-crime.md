# Partners in Crime

**Status:** Design proposal, not implemented. **Type:** primary team-formation scenario. Read [shared rules](./shared-design.md).

## Fantasy / promise

Turn "I hope I'm on my friend's team" into a community mini-event. Every registered player can privately nominate **one** teammate they'd most like to play alongside. **Mutual** preferences become meaningful duo requests that the bot tries to honour when assembling two fair teams.

The scenario should be heartwarming, not a popularity contest or a way to publicly shame someone who picked a person who didn't pick them back.

## Proposed v1 rules

1. After registration, each player can privately name/select **one other registered player** they would enjoy teaming with. "No preference" is a valid response.
2. Preferences can be changed until a clearly announced cutoff. They are visible only to the person submitting and to an authorised organiser where necessary for troubleshooting.
3. If A chooses B **and** B chooses A, that is a **mutual pair**. One-sided choices do not bind the other player and are never publicly exposed.
4. The bot attempts to keep each mutual pair on the **same team**, then balances the remaining single players using Elo and team-size constraints.
5. A mutually chosen pair is a **priority request, not an absolute guarantee**. If preserving every pair creates impossible team sizes or a severe Elo imbalance, the organiser preview must explain which pair(s) would be split, and why.
6. Organiser confirms final RED and BLUE teams. The final reveal may call out honoured mutual duos **only if both agreed to be named publicly**; otherwise show just normal teams.

## Example

A roster of 20 includes these choices:

| Player | Private preference |
| --- | --- |
| Alex | Blake |
| Blake | Alex |
| Casey | Dana |
| Dana | No preference |
| Emi | Fin |
| Fin | Emi |

**Alex + Blake** and **Emi + Fin** form eligible pairs. **Casey → Dana** is unreciprocated and creates no obligation. The algorithm groups the two mutual pairs where possible, distributes singles, and shows Elo/size balance before committing.

## Balancing approach

Suggested v1 algorithm:

1. Freeze the registered roster and validate that every submitted target is still eligible and is not the voter themselves.
2. Build disjoint mutual pairs. With one nominee per person and mutuality required, each player can be in **at most one** pair; everyone else is a singleton.
3. Allocate pairs first as two-player bundles, then singles, minimising team-size differences and Elo gaps. Use a deterministic search/heuristic with test coverage for 15–50+ players (no combinatorial explosion).
4. If pair preservation makes an equal/near-equal split impossible (for example, an **18-player roster made of nine inseparable pairs**), relax the **minimum number of pairs needed** rather than placing ten players against eight or dropping someone from the match.
5. If a mutual pair contains two highly rated players, consider the entire pair's rating in the calculation so teams are not balanced only by duo count.
6. Show the organiser how many mutual pairs formed, how many are kept and any required exceptions. Do not silently claim "all pairs honoured".

Optionally add a configurable "prioritise pair preservation" versus "prioritise Elo" setting later; v1 should have one sensible default and preview.

## Discord experience

- Public: "Partners in Crime: Choose one teammate privately by HH:MM. Both players must choose each other to form a duo. Preferences are requests, not guarantees."
- Private: search/select eligible registered name; "No preference", review and submit. Show "Your choice is saved; the other player is **not notified**."
- At lock: if two choices are mutual, privately tell both players "You formed a duo!" (do not disclose unilateral crush-style selections).
- Reveal: normal RED/BLUE roster, perhaps a "Dynamic Duos" section listing *consenting and honoured* pairs.
- Organiser preview: team Elo, player counts, pair fulfilment count, any exceptions. Avoid showing raw unilateral nominations.

## Dropouts and late signups

- One member unregisters: dissolve their pair; remaining partner becomes a singleton and stays eligible.
- A nomination target changes IGN: keep the player ID/Discord ID reference, not a typed username string.
- Someone registers after the preference deadline: treat as a singleton unless the organiser explicitly reopens collection before final teams lock.
- No mutual pairs / zero responses: this becomes an ordinary balanced team-generation outcome, with a friendly message that no duo formed.
- Prior captain appointments: if already selected, captains must be assigned to opposite teams; any duo linking two captains **cannot** be honoured. Show this before confirmation.
- A registered player cannot be included in two pairs or roster positions. Discard stale references on change.

## Optional future variation - Rivals

A related but **separate** scenario could let consenting players nominate an opponent they would love to face, with mutual rival choices prioritised for **opposite** teams. Do not mix "partner" and "rival" intentions in the same hidden button without clear labelling and mutual consent.

## Acceptance criteria

- One active preference per eligible player; no self-selection.
- Exactly reciprocal, in-roster preferences create pairs; unilateral answers remain private and do not form pairs.
- Team formation honours as many mutual pairs as feasible **while preserving viable team sizes**, and transparently reports exceptions.
- Elo gaps are visible; strong duos cannot be balanced as if each player were independent.
- Pair data does not leak through public prompts, error messages, or incomplete voting status.
- If anyone withdraws, finalising an older preview is blocked and allocations can be recalculated.
- Nobody is excluded from playing merely for not answering.

## Open decisions

- Should pair preservation outweigh a moderate Elo difference, and by how much?
- Should the duo reveal be opt-in separately from the preference itself? (Recommended: yes.)
- Is selecting from *all* registered players preferable, or should a player be shown a private random shortlist with search?
- Should the bot allow pre-existing captain pairs to remain together? (Recommended: no; one captain per team.)
