# The People's Captains

The players decide who leads their teams! Everyone who registers is eligible to be elected captain, regardless of Elo or captain experience. No volunteering is required.

## How to play

1. Register as usual. Voting normally opens 35 minutes before the game, with at least four registered players.
2. Check your DM or click **Open My Scenario** in the game feed. If you miss it, use `/game scenario open`.
3. Pick one of your three candidates. You cannot vote for yourself. You can change your vote until voting closes, normally 20 minutes before the game.
4. The bot announces the two elected captains and turnout. An organiser confirms the result, then normal snake drafting can begin.

## Fair voting

The roster is frozen when voting opens. A match-specific shuffled circular roster gives every player exactly three distinct options and every candidate exactly three appearances. The candidate list and ballot order stay fixed for the election. Only the latest valid vote per registered voter counts.

The score is (votes + 1) / (appearances + 2). Because exposure is equal, this is equivalent to ranking by vote count. Ties use a fixed match-specific draw; team colours are assigned by a separate fixed draw. Neither favours high Elo or low Discord IDs. At least three votes or 20% of the roster (rounded up), whichever is higher, and at least two candidates with actual votes are required. Individual ballots and low vote counts are never published.

## Organiser controls and exceptions

- Use `/game scenario status` to see progress, failed deliveries and controls. Players can reopen their own ballots; reminders use the same choices.
- Late announcements or missed opening stages can be started manually if the voting deadline is still in the future. Reschedule if more time is needed; voting cannot close before the advertised deadline, even if everyone has voted.
- Roster changes during voting pause the election for review. The frozen ballots are not silently regenerated. If the roster changed, cancel the scenario and use ordinary captain selection.
- After voting closes, use **Review Roster** to retain the elected result with a changed roster, or **Replace RED Captain** / **Replace BLUE Captain** if a proposed captain cannot serve. The next still-registered candidate who received votes is offered, and the change is announced. Confirm the revised result separately. If there is no supported replacement, use the ordinary fallback.
- After confirmation, ordinary team-picking recovery applies if a captain becomes unavailable; do not silently change the election.
- A restart pauses the election. With the same roster and valid frozen ballots, organiser resume restores the same choices and saved votes with fresh controls. A completed tally can be reviewed without rerunning it. Legacy volunteer elections require cancellation and ordinary captain selection.
- If turnout is insufficient or the result cannot safely be recovered, use `/game scenario cancel` or the existing team scenario fallback. Review existing roles and assignments before proceeding.

See [shared rules](./shared-design.md).
