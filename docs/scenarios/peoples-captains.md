# The People's Captains

**Status:** Design proposal, not implemented. **Type:** captain-selection scenario; followed by a normal or scenario draft. Read [shared rules](./shared-design.md).

## Fantasy / promise

The community elects two captains using **personalised mini-ballots**. Each registered voter sees a different group of **three** would-be captains, rather than a giant public popularity poll. Quiet but capable players can get noticed, and who wins isn't obvious until the reveal.

**The election chooses captains, not teams.** Once elected, the captains are assigned to RED and BLUE and the chosen draft method runs as normal.

## Proposed v1 rules

1. Registered players can **opt in to stand for captain**; opting in confirms they are available, willing to communicate and able to make draft decisions. An existing nomination can be surfaced as a suggestion, but current `/captainnominate` is only an organiser selection, **not** an election ballot.
2. Organisers open a fixed-length election window before normal captain auto-selection. Freeze the candidate slate and voter roster when voting opens. Candidate must still be registered and a server member at tally time.
3. Each eligible voter privately receives **three distinct candidates**, excluding themselves. They get **one vote** for one of the three. Ballot choices are fixed for that match once issued.
4. Distribute candidate appearances as evenly as possible. Prefer equal exposure; randomise candidate combinations and positions without choosing the same three-person group for everyone when avoidable.
5. Close the election at its stated deadline. Two top eligible candidates become captains, after tie handling and eligibility recheck. Assign BLUE/RED **fairly at random** or by an organiser-confirmed deterministic mechanism; do not allow the first elected candidate automatically to choose the more favourable colour.
6. Captains then draft via ordinary `draft` or `snake`, [Masked Draft](./masked-draft.md) or [Draft Roulette](./draft-roulette.md). For v1, recommend **snake** by default.

## Ballot fairness — the core design problem

Raw vote counts alone are biased if someone appeared in eight ballots and someone else appeared in two.

Example: with 20 voters, three options each, there are **60 ballot appearances**. If ten people opt in as candidates, each should appear approximately six times. This is easy to balance. But if all 20 people stand, each candidate will appear only approximately three times; tiny differences in exposure matter and results are noisier.

Proposed v1 approach:
- Use a **balanced exposure allocator**: make sure every candidate gets as close as possible to the same number of appearances. Each voter sees three different candidates, never themselves; each candidate should appear at most once on any ballot.
- Track `ballotsShown` and `votesReceived` per candidate, plus the frozen voter IDs and ballot assignments.
- Rank by **support per appearance** (`votesReceived / ballotsShown`) with a preannounced minimum-exposure/smoothing rule to prevent 1/1 beating 6/8 by accident. A simple documented option is a score like `(votesReceived + 1) / (ballotsShown + 2)`, with actual vote counts used as a secondary tie-break. The exact formula is a product choice, **not** existing functionality.
- Do **not** count candidates who cannot be shown to a reasonable number of voters. If the combinatorial constraints cannot make exposure fair, reduce the candidate slate transparently or switch to a direct all-candidate ballot for that particular game rather than pretending a three-choice election is fair.
- Show the organiser the exposure counts before ballots are published, and the final participation/exposure summary afterwards. Never change ballots while voting is live.

There must be **at least three** candidates available *to each voter*, after removing themselves. For a simple v1, require **at least four willing candidates**. If the pool is smaller, skip personalised ballots and let organisers appoint captains via existing commands after explaining why.

## Worked example

- 20 registered voters; 8 opted-in captain candidates.
- Voter A sees **Alex / Blake / Casey**. Voter B sees **Dana / Emi / Fin**. Voter C sees **Casey / Gina / Harley**.
- A votes Casey; B votes Emi; C votes Harley. Each ballot has three *different* candidates, and no voter can vote for themselves.
- At close, the two best eligible candidates based on the published scoring rule are announced. Each has accepted leadership and is assigned to a different colour.
- The bot announces: "Your elected captains are **Alex (RED)** and **Emi (BLUE)**. Snake draft begins next." (Names are placeholders.)

## Discord UX

- Public announcement: election opening and closing times; X candidates; Y of Z voters voted; explanation that not everyone sees the same ballot.
- Private / ephemeral ballot: three readable player names with an **Elect** button/selector and a final confirmation. The player can change their vote until the deadline, but only their latest vote counts.
- Private candidate nomination: opt in/withdraw until slate freeze; candidates can view their eligibility status.
- Result: captains, vote/participation totals and method summary; do not disclose which individual voted for whom or everyone's personal ballot.
- Organiser-only: verify eligible candidates, exclude a withdrawn/ineligible person, explain tally/tie outcome, approve captain assignments.

## Deadlines and exceptions

- **No eligible candidates or fewer than four opt-ins:** announce fallback to organiser captain selection; do not randomly elect unwilling players.
- **No votes / very low turnout:** abandon election for this match and use ordinary willing-captain selection, not a fabricated winner.
- **Tied result:** one short run-off using the tied candidates (equal exposure), if schedule allows; otherwise a predeclared deterministic tie-break or explicit organiser approval. Avoid an endless ballot loop.
- **Candidate withdraws during voting:** invalidate ballots that include them; pause/reissue ballots if time allows, else cancel the election and use normal selection. Do not silently tally an uneven, changed exposure matrix.
- **Nonvoter / player leaves:** ignore their vote if no longer eligible at close, but **recheck exposure calculations** because their fixed ballot no longer participates.
- **No candidate wants a particular team:** colour assignment should be impartial; allow organiser intervention only before locks with an audit note.
- **Existing captain already set:** prevent opening an election or explicitly require organiser to clear the assignment first.
- **T−15 autopick:** the scenario must own captain selection until a sufficiently early deadline; on failure, provide an intentional fallback before automatic draft starts.

## Acceptance criteria

- Each voter gets one immutable three-person candidate set with no duplicates or self-reference.
- Candidate exposure is as even as possible for the frozen roster; the allocation fails with an explanation when impossible.
- Only one ballot per registered voter counts, with safe revoting and final deadline handling.
- Tally is deterministic, auditable and cannot elect a withdrawn/unregistered candidate.
- Captain appointments and team colours use the normal game mutation/role sync protections.
- No public display or log exposes an individual voter's selection.
- The election finishes with **exactly two** consenting captains or a clear safe fallback, never a half-applied appointment.

## Open decisions

- Exact exposure-aware tally method and minimum turnout (recommended: decide once, document in player-facing rules).
- Should nominees have a short public pitch, or should this remain a pure "who would lead well?" ballot?
- Candidate count cap versus all-player candidacy: more candidates yields less reliable per-candidate samples.
- How to resolve exposure imbalance after a late withdrawal fairly without delaying the match.
