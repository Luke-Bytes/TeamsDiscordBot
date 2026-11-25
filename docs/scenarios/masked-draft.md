# The Masked Draft

**Status:** Design proposal, not implemented. **Type:** alternate captain draft. Read [shared rules](./shared-design.md).

## Fantasy / promise

Captains draft **mystery players** without seeing their names. Every undecided registered player becomes a numbered card with a few **non-identifying gameplay clues**. Captains must build teams by judging useful roles and general skill bands rather than instantly choosing their friends or the most recognisable names. When every pick is locked, the masks come off.

This is **identity-blind drafting**, not a promise of perfect anonymity; members may already know who registered or recognise a rare profile.

## Proposed v1 rules

1. Choose two willing captains via normal appointment/nomination or [The People's Captains](./peoples-captains.md). Captains are publicly identified and begin on opposite teams.
2. Freeze the other registered players **before any cards are generated**. Each remaining player is assigned exactly one **random stable card ID** for this draft (e.g., M01, M02).
3. Build an intentionally coarse card:
   - An **Elo band** (e.g., `1000–1099`, not exact Elo), when enough rating information exists.
   - One **player-declared playstyle/role preference**, such as defence, support, attacker or flexible, if available and explicitly opted in.
   - Optional harmless flavour icon/descriptor from a small shared set.
4. **Do not expose** IGN, Discord mention/avatar, profile title, exact Elo, exact draft history, registration order, or other identifiers in a card. Do not invent role expertise from a short profile if no grounded preference exists.
5. Captains alternate selecting cards with the existing standard or snake draft order; recommend **snake** for v1. A picked card moves to a team in the preview, still masked.
6. After all cards are assigned and the organiser confirms final teams, reveal a single mapping of **card ID → real player and team**, and only then publish normal rosters / sync team roles.
7. The normal match begins after role/roster verification. The scenario changes **how people are chosen**, not how they play.

## Illustrative draft screen

```text
MASKED DRAFT — BLUE TO PICK
BLUE: Captain Alex, M02, M07
RED:  Captain Emi, M04

Available:
M01 — Elo 1000–1099 • Defender
M03 — Elo 1100–1199 • Flexible
M05 — Elo 1000–1099 • Support
M06 — Rating not available • Attacker

[Pick M01] [Pick M03] [More cards]
```

After confirmation:

```text
THE MASKS ARE OFF!
M01 was Fin → BLUE
M03 was Blake → RED
M05 was Dana → BLUE
...
```

These names, scores and card IDs are illustrative only.

## Private versus public information

- Cards and team card lists may be public; **card-to-identity mapping stays server-side** until final reveal. Even organisers need a troubleshooting view that is private and not casually shared.
- If a player has a rare profile, the bot should withhold distinctive hints. Use broad role options and rating bands, not a distinctive free-text biography.
- If a player declines to share a preference, show **Flexible / Not provided** rather than inferring it. Ratings below a privacy-sensitive cohort size may be bucketed more broadly or omitted.
- A final roster must be available to the bot for identity-bound role updates; do **not** mask internal identity objects or invent dummy Discord IDs.
- The existing roster commands and player statistics may permit people to infer card identities; document that this is a fun draft limitation, not an actual privacy guarantee.

## Draft mechanics and fairness

- Reuse the normal **captain eligibility, even undecided count, turn timers, autopick and final confirmation** rules unless explicitly changed.
- A card is unique and becomes unavailable once picked; prevent double-picks and use the current session/lifecycle token for button validation.
- A timeout automatically picks one eligible remaining **card**, not an unrelated real-name lookup. Show "Auto-picked M07" until the reveal.
- The other captain should not learn a card's identity merely by clicking it; their action should show the card's publicly permitted traits and confirmation only.
- When one card remains, allocate it to the appropriate side as the existing draft does, while keeping it masked until reveal.
- All normal draft writes, embeds, logs intended for Discord and team feeds must avoid leaking names. The original `DraftTeamPickingSession` publicly announces picks by IGN, so masking **requires changes to its presentation path**, not just wrapping card names in another message.

## Roster changes / recovery

- Late signups after card generation: **do not silently extend** the deck. Suggested v1: late signups stay undecided for organiser review or the draft is cancelled and regenerated **before locks**.
- Player unregisters during the draft: invalidate that card. If this breaks draft parity or a completed pick, pause and require an organiser-controlled rebuild; never reveal identity as an error fallback.
- Discord role assignment: do not pre-assign team roles on a card pick because those roles may leak team membership or make partial results appear final.
- Interrupted draft or restart: restore the exact stable mapping and picked-card state only if a trusted, validated snapshot exists; otherwise pause/fail closed. **Never draw a new mapping under an old message.**
- If final confirmation/role sync fails, provide an organiser reconciliation path without public partial identity leaks.

## Acceptance criteria

- One stable anonymous card per eligible undecided player; exactly one real identity per card.
- Captains can pick legal cards without seeing real identities through the scenario UI.
- Expired/stale buttons never make picks; autopicks respect the same pool and order.
- No duplicate cards, missing players or cross-team duplicates at finalisation.
- Roster changes cannot silently remap cards; recovery preserves or deliberately invalidates mappings.
- The reveal occurs **once**, only after the draft is confirmed; team role sync follows the authoritative final roster.
- After reveal, regular team lists / captain plan / start flow still work.

## Open decisions

- Exactly which non-identifying hints are both fun and available from verified player data?
- Should players explicitly choose a public masked-card playstyle at registration?
- Could too few players per Elo band make the hints effectively identifying? (Recommended: dynamically widen bands or omit them.)
- Should the reveal happen all at once or card by card for suspense? (Recommend **one atomic reveal message** for v1.)
