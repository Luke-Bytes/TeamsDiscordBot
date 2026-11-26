# Cursed Classes

**Status:** Design proposal, not implemented. **Type:** gameplay restriction overlay **after teams are final**, before the match starts. Read [shared rules](./shared-design.md).

## Fantasy / promise

The bot randomly draws **three awkward, off-meta Annihilation classes**. Each captain then gets to inflict those three classes on **three different enemy players**. They can target the opposing team's strongest rusher, best defender or even the captain to force unusual strategies.

The reveal should be funny and tactical, not a claim that the selected players themselves are bad. The internal scenario ID remains `class-hex`.

## Exact proposed v1 rules

1. Both teams and both captains are already **finalised**. There must be at least **three players per team**, with all intended participants registered and verified.
2. The bot randomly selects **three different classes**, A/B/C, from an organiser-maintained **"off-meta / awkward classes"** pool. **The same three drawn classes apply to both teams** to keep the restrictions symmetric.
3. Each captain privately assigns **one distinct player on the opposing team to A, one to B, and one to C**. This uses exactly **three different enemy players per captain**. A player may not receive two hexes; each drawn class is used exactly once against each team.
4. **Captains are eligible to be targeted** unless organisers explicitly publish a different house rule before the match. Selecting the strongest player to hinder is the intended tactical point.
5. Both captains submit independently. Do **not** reveal the other captain's selections until both assignments are locked or the deadline passes.
6. The bot reveals **six assignments total** (three RED players chosen by BLUE's captain, three BLUE players chosen by RED's captain), with each player's required class.
7. For the **whole match**, each assigned player agrees to play their imposed class, including after death/respawn and during later phases, when class selection is available. Other players retain normal permitted class choice, subject to announced bans/modifiers.
8. The bot announces the rule; **it cannot set or verify Minecraft classes inside Shotbow**. This must be an explicit honour rule, monitored and fairly administered by organisers/host. No automatic punishments or Elo conclusions are inferred from alleged violations.

## Why the pool must be curated

The Prisma `AnniClass` enum lists class identifiers; it does **not** rank how good they are. What's "bad" changes with Shotbow updates, match context, map and player skill. The bot should **never** randomly draw from every class assuming some are weak.

Start with an **organiser-reviewed, configurable pool** of awkward/off-meta-but-playable classes. As *examples for review only*, candidates might include `CIVILIAN`, `HANDYMAN`, `FARMER`, `BUILDER` or `TINKERER`. Their actual strength, availability, cost and legality must be checked against current Shotbow rules before any official pool is published. Do **not** ship those examples blindly as hardcoded "bad" classes.

Pool requirements:
- At least **three different eligible classes** after exclusions.
- Class must be allowed by Shotbow, selectable by the intended participants, and not contradicted by a current organiser ban, shared captain ban or applicable per-team restriction.
- Prefer a standard/publicly accessible pool or a pre-match **availability confirmation**. The bot currently does not know which Minecraft classes each person owns/unlocks.
- Freeze the eligible pool *before the draw*, and store the exact chosen classes. A reroll should be a deliberate organiser preview action with a reason, not a repeatable way to fish for "worse" classes.
- Existing `Class Bans`, `Unique Classes Only`, `Class Changing in Portal` and other modifiers require a compatibility check. **A mandatory class must never also be banned for that affected team.**

## Worked example

Suppose the approved draw is **Civilian, Farmer, Tinkerer**.

| Selecting captain | Enemy player | Class they must play |
| --- | --- | --- |
| RED captain | BLUE's strongest rusher | Civilian |
| RED captain | BLUE's defender | Farmer |
| RED captain | BLUE's captain | Tinkerer |
| BLUE captain | RED's strongest fighter | Farmer |
| BLUE captain | RED's captain | Civilian |
| BLUE captain | RED's miner | Tinkerer |

The captain chooses **which enemy gets which class**; they do not choose new classes or change the global draw. That is where the tactical decision lies. All six assigned players are bound to their specified class during the match, to the extent voluntarily enforceable.

## Discord interaction sketch

- Organiser preview: "Cursed Classes selected. Eligible pool: N classes. Draw: A, B, C. Check current bans and class access. [Confirm Draw] [Cancel]."
- Private captain editor: three rows, one per class; for each row select an eligible **opposing-team player**. Already-selected targets disappear or become disabled. **Review → Submit**.
- Private player notice: after final reveal, each affected player receives their required class and a clear reminder that this is a voluntary community match rule; provide a way to flag **cannot access this class** before game start.
- Public reveal, only when both captains finish: "RED curses BLUE: Alex → Civilian; Blake → Farmer; Casey → Tinkerer. BLUE curses RED: Dana → Farmer; Emi → Civilian; Fin → Tinkerer."
- Countdown/reminder: "Hex assignments are locked. Affected players: verify class access before the match starts."
- In-game role change cannot be verified by the Discord bot; organisers must not describe these as automated class locks.

## Interactions with team formats

Cursed Classes is a **post-team overlay** and can follow ordinary teams, Mystery Dungeon, Partners in Crime, People's Captains + draft, Masked Draft or Draft Roulette. It **must not** run before anonymous drafting finishes; revealing target names while a Masked Draft is live would defeat the mask.

If another setting already forces a player onto a conflicting class or bans their assigned class, the scenario must be rejected or adjusted **before assignments are locked**. A class restriction applying to all members of an enemy team is *not* the same as a captain targeting three individual players; don't implement this via existing class-ban modifiers alone.

## Special situations / enforcement

- **A target cannot access the class:** stop final confirmation, verify class availability and rerun the draw or ask organisers to select a valid class/pool before the start. Do not quietly replace just one side's class with a stronger/weaker option.
- **A player leaves before the start:** invalidate the affected assignment and let that team's opposing captain choose a replacement from remaining eligible targets; if roster/team identity changes substantially, pause and rebuild both sets for fairness.
- **A player leaves during the match:** follow normal roster replacement procedures. Decide whether their hex transfers to a replacement *only through an organiser-confirmed, publicly documented ruling*; v1 should **not** auto-curse a new player without consent.
- **Captain does not respond:** prompt them before the deadline; an organiser may complete valid picks using the same frozen draw, or cancel the overlay and run a normal match. Do not silently start while only one side is cursed.
- **Team has fewer than three players:** do not activate this scenario, even if a low-player ordinary match could otherwise proceed.
- **Changing classes accidentally:** the rules should say what to do if Shotbow temporarily changes class or doesn't allow an instant switch. Suggested policy: restore the assigned class as soon as legally available; host decides disputes, without bot-invented automated penalties.
- **Strategic targeting / player experience:** targeting high-skilled players is explicitly part of the game. However, repeated personalised harassment, taunts or coercion are not. Advertise the rule **before registration** so players understand they may be targeted.
- **Ratings:** recommend **unrated/exhibition** by default because the match artificially handicaps six targeted players. This requires explicit implementation; the current Elo system does **not** infer unrated status from Cursed Classes.

## Acceptance criteria

- Draw is exactly three distinct classes from the frozen approved and compatible pool; no forbidden/unavailable class silently slips in.
- Each captain can assign exactly one enemy player to each class, with no repeated target.
- Both teams receive the **same multiset of three classes**, with exactly three affected players each; captains can be targeted.
- Submissions are private until both are locked; no one can submit for the other captain.
- Changes to class bans, team roster, player availability or match lifecycle invalidate stale confirmations rather than preserving contradictory assignments.
- At game start, show a complete six-person mapping, with no missing targets, and state unambiguously that this is **organiser-enforced**.
- No code claims it controls the actual Minecraft class, auto-detects violations, or penalises a player on unverified evidence.
- The saved match can identify the chosen class set and who received each assignment if scenario reporting is added.

## Open decisions

- Which exact classes are currently awkward *and* reliably available to all participants? (Needs organiser input and current Shotbow verification.)
- Do all players need to acknowledge access before the draw, or only the six people targeted afterward?
- Should the captain have to **use all three** classes, as recommended here, or could they choose any three assignments from a larger draw? (V1: all three once each.)
- What is the community-agreed procedure when a player cannot follow a mandatory class for technical reasons mid-game?
