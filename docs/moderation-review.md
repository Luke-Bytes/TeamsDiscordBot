# Organiser moderation lookup

Use `/modcheck player:<current IGN, Discord mention or ID>` in the server to review a player's moderation and Minecraft identity information in one place. Only members with the configured organiser role may run it. The bot checks that role before accessing records, and both denials and successful results are **ephemeral** (visible only to the requester). The command does not change any data.

The embed includes recorded punishment reasons, dates, strike totals, and current active expiry; the player's Discord link and current IGN; distinct names seen in player records, game participation, and event signups; and the number of distinct valid Minecraft UUIDs observed in the current link plus historical signups **for that server**.

## Combined Minecraft name history

The review also attempts a shared history lookup for the stored primary UUID, not the potentially stale IGN, combining external providers with UUID-linked database records. This is separate from player-wide local records that may span multiple accounts. It reports the current resolved username, visible previous names and provider coverage; a provider outage or absent history is not evidence of an alt. See [Minecraft name history](minecraft-name-history.md) for configuration and privacy. The lookup never changes the account link or moderation assessment.

## Account consistency flags

The **Account consistency** field separates issues **needing attention** from things to **review**. It checks:

- Missing or invalid primary Minecraft UUID, missing/invalid current IGN, and malformed legacy entries in the recorded name list.
- A duplicate current IGN across player records, or another player record claiming the same primary UUID.
- **Confirmed/reserve applications to currently OPEN or CLOSED events** whose UUID disagrees with the player link or whose IGN appears stale. Finished and withdrawn event applications intentionally retain historical snapshots; differences there are not treated as broken sync.
- Multiple punishment records for one player, mismatched punishment reasons/dates, or strike totals that disagree with reason counts.
- When a valid primary UUID and IGN exist, a read-only live Minecraft username lookup: an IGN resolving to a **different UUID** is a strong identity conflict; a missing name is a review item, and a temporary lookup outage is reported as **unverified**, not a problem with the player.

Flags describe stored-data discrepancies or possible technical issues, **not cheating or misconduct**. They are read-only diagnostics; organisers must validate before making changes. They do not repair account links or rewrite punishment records.

## Reading identity and alt-account signals

- `minecraftAccounts` contains stored usernames, **not an authoritative Minecraft UUID or name-change history**. Several usernames may belong to one Minecraft account.
- Current player records keep only the primary UUID. A `/username update` replaces it and does not retain a dedicated update log. Historical event signups can show additional UUIDs, but a complete lifetime account-switch count is **not available**. The review reports how many distinct UUIDs were actually observed, not an invented number of switches.
- If the same UUID is recorded against another Discord ID in a player link or this server's event signups, the embed shows that specific overlap as a **possible** alt indicator. This can also reflect a transferred or shared Minecraft account. A lack of overlaps is not evidence that someone has no alternate account.
- An observed overlap is **not proof of the same person**. Organisers should review the context and underlying records before any disciplinary action; do not infer an alt from usernames alone.

The command reads local records and performs a read-only Minecraft username verification when the account has a valid IGN and primary UUID. It does not access another server's event signups. It intentionally does not expose sign-up answers. Results are confidential moderation material; do not post screenshots or copy them into public channels or AI prompts.
