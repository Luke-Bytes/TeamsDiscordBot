# Captain's Wildcards

**Status:** Design proposal, not implemented. **Type:** optional captain-draft overlay or a themed draft night. Read [shared rules](./shared-design.md).

## Fantasy / promise

Every captain receives **one special tactical action** to use at a dramatic moment during team picking. Ordinary draft strategy still matters, but a captain can throw a small surprise into the process. The powers should produce fun reactions without invalidating the roster or giving one side an extra player.

This is about **draft-stage powers**, not altering Minecraft permissions, Elo, or the live match after it starts.

## Proposed v1 rules

1. Before drafting begins, confirm two captains and the draft method. Each captain receives **one wildcard credit**. Both have access to the same compatible power menu; no paid upgrades, no random unequal starting powers.
2. A captain may spend their credit **once** on one eligible power, during the specific phase that power allows.
3. The action is announced publicly after successful application, including who used it and the result. The remaining credit count is always visible.
4. An unused credit expires when the draft is finalised. A captain cannot spend it twice, transfer it or get it back from a stale click.
5. After an action, the normal draft resumes. Teams remain equal-sized at completion and both captains retain their own team roles.

## Power catalogue — suggested initial set

### A. Veto (before opponent's next pick)

The captain names **one undrafted player/card** who the opposing captain **cannot select on their next turn only**. The target remains in the pool afterward. In Roulette, it cannot appear in that turn's hand (or must be replaced from other eligible players). In Masked Draft, the veto names a **card ID**, never an identity.

- Use before the next opposing turn's hand or selection is displayed; cannot retroactively undo a pick.
- Valid only if the opponent will have **at least two legal choices** after the veto. It expires immediately after that one opposing pick.
- The wildcard is consumed when the temporary veto is accepted, not when the next captain picks.
- Example: "BLUE used Veto on **M07**. RED cannot choose M07 this turn."

### B. Switcheroo (on your own turn)

The captain swaps **one non-captain player/card already drafted onto their own team** with **one still-undrafted player/card**.

- Both sides keep their current number of picks; no opponent's drafted player may be stolen.
- The released teammate/card returns to the general pool, eligible for later picks. The chosen replacement moves into the captain's team preview.
- This is allowed only **during the captain's own turn**, before final confirmation, and while at least one undrafted candidate remains. No historical picks or Minecraft roles are rewritten after the game starts.
- Example: "RED used Switcheroo: returned **M03** to the pool and drafted **M09**." In normal draft, show player names instead.
- The organiser preview should warn when a Switcheroo significantly affects projected Elo, but a legal confirmed action should not be silently reversed.

### C. Scout Report (Masked Draft only; optional expansion)

The captain spends their credit to reveal **one additional non-identifying hint** about a chosen anonymous card privately (e.g., a broader self-described playstyle). Do not reveal IGN, exact player ID, exact Elo or uniquely identifying traits; skip the power if no safe extra hint exists.

This is **not** part of the minimal two-power implementation. It shows how the catalogue can become scenario-aware later without exposing identities.

### D. Roulette Redraw (Roulette only; optional expansion)

A one-time extra hand redraw. Because [Draft Roulette](./draft-roulette.md) already proposes a reroll token for each captain, **do not offer this power by default**. If ever added, the UI must clearly show combined redraw limits and prevent stacked duplicate benefits.

## How this plays

```text
SNAKE DRAFT — RED TO PICK
RED wildcard: 1 available
BLUE wildcard: spent (Veto)

RED can:
  Pick an undrafted player
  Use Switcheroo (own drafted player ↔ undrafted player)
  Use Veto (only if the next pick belongs to BLUE)
```

The UI must present only legally usable controls. A captain whose credit is spent sees the power's history but no live activation buttons.

## Compatibility

| Draft mode | Veto | Switcheroo | Scout Report |
| --- | --- | --- | --- |
| Ordinary draft / snake | Yes | Yes | Not useful |
| Masked Draft | Yes, card IDs | Yes, card IDs | Future only |
| Draft Roulette | Yes, filtered offers | Yes | Not useful |

For v1, implement **Veto and Switcheroo** only on one draft mode first, then adapt to Masked and Roulette. This avoids building a large reusable power engine before there's evidence that players enjoy the mechanic.

## Rules for fair application

- No irreversible player deletion, forced unregistration, team-size change, captain replacement or change of opposing captain.
- Both captains start with identical credits and power options; power use is first valid action wins.
- Before spending, show a confirmation stating exactly what changes and that the credit is consumed.
- A timeout should perform the normal legal pick; it does not automatically invent a wildcard choice.
- Power actions must run under the same roster/draft lock as picks. Check lifecycle/turn, captain ownership, current pool, token balance and conflicting restrictions **again immediately before commit**.
- When two interactions race, accept at most one. Retrying a successful action must show its existing result, not spend a second credit.
- For masked mode, never disclose an identity through a wildcard's error or public message.
- If an action cannot legally run (too few candidates, target already taken, expired turn), reject it **without consuming the credit**.

## Recovery and cancellation

- Store wildcard credits, power selections, temporary veto expiration turn and any successful swap as part of the draft's authoritative snapshot/history.
- If a draft is cancelled, its power effects should disappear with that draft preview; do not modify a different match's team state.
- Recovered drafts must not grant new credits. If exact remaining turns/powers cannot be trusted, pause and require organiser action.
- The normal teams-finalised confirmation should block any further wildcard action.

## Acceptance criteria

- Both captains start with exactly one credit and only legal powers appear for the current mode/turn.
- Successful action consumes one credit **once**; invalid, stale and duplicate actions do not.
- Veto lasts for exactly one specified opposing pick, cannot make the pick impossible, and never permanently removes the player.
- Switcheroo changes one existing own-team non-captain and one undrafted candidate, with no player lost or duplicated.
- Draft order, captain positions, final player counts and team-role sync remain valid.
- An organiser can inspect a short action log and understand how the roster was formed.

## Open decisions

- Should captains choose from the menu at **activation**, or lock in their one selected power before drafting? (Recommended: choose at activation, transparently.)
- Is a third universal power worth adding after v1? Avoid complicated multi-turn order changes initially.
- Should the final post-game summary show who used their wildcard and whether it paid off? (Fun optional presentation, no skill inference.)
