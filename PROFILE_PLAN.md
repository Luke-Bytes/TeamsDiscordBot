# /profile Feature Plan

## Goals

- Add `/profile` (view) and `/profilecreate` (self-only) with fixed-option fields.
- Profiles are expressive but concise; only filled fields are shown.
- Use interactive components (select menus/buttons) in the channel where the command is run.
- Only allow `/profilecreate` in bot commands channel when used in a server; disallow in DMs.
- Allow `/profile [name]` to accept Discord user ID/mention or latest IGN.
- Store profile data in Prisma with clear schema and easy querying.

## User-Facing Fields (All Optional)

- **Preferred name**: fixed list? (suggested options: keep as a short list or omit if not desired)
- **Pronouns**: `he/him`, `she/her`, `they/them`, `any`, `ask`.
- **Languages**: `English`, `Spanish`, `Japanese`, `Dutch`, `German`, `Turkish`, `Other`.
- **Region**: `NA`, `SA`, `EU`, `JP`, `AS`, `AF`, `AU`.
- **Rank**: `Novice`, `Silver`, `Gold`, `Master`, `Grandmaster I`, `Grandmaster II`, `Grandmaster III`, `Annihilator`.
- **Roles (multi-select)**:
  - **Preferred roles**
  - **Proficient at**
  - **Looking to improve**
  - Roles list: `Rusher`, `Mid`, `Flex`, `Griefer`, `Minerusher`, `Defender`, `Sky TP`, `Wall Builder`, `Bunker`, `Farmer`, `Gold Miner`.
- **Playstyle tags** (multi-select, adds flair):
  - `Team-first`, `Shotcaller`, `Proactive`, `Defensive`, `Gap Dropper`, `Supporter`, `Flexible`, `Strategist`, `Supportive`,
    `Clutch`, `Chill`, `Egoist`, `Whimsical`, `Adaptable`, `Invis Opportunist` .

> Only fields set by the user appear on the profile output.

## Command Behavior

### `/profile [name]`

- If `name` omitted: show caller’s profile.
- If `name` provided:
  - Accept Discord ID, mention, or latest IGN.
  - Use `PrismaUtils.findPlayer(name)` to resolve player.
  - If not found, show error.
- Embed output:
  - Title: `Profile — <Discord Tag or latestIGN>`
  - Always show `latestIGN` if available.
  - Show only fields with values.

### `/profilecreate`

- Only usable by self.
- Must be in bot commands channel if used in server.
- Ephemeral response with interactive UI (select menus + buttons).
- Flow:
  1) Show current values (if any) + buttons to edit sections.
  2) Each section uses select menus (multi-select where applicable).
  3) “Save” writes to DB; “Clear” removes that section; “Cancel” exits.
- Interaction security: only the command invoker can use the components.

## Prisma Schema

Add a new `Profile` model.

Example:

```
model Profile {
  id            String   @id @default(auto()) @map("_id") @db.ObjectId
  playerId      String   @unique @db.ObjectId
  player        Player   @relation(fields: [playerId], references: [id])

  preferredName String?
  pronouns      Pronouns?
  languages     Language[]
  region        Region?
  rank          PlayerRank?

  preferredRoles Role[]
  proficientAtRoles    Role[]
  improveRoles   Role[]

  playstyles     Playstyle[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

enum Pronouns {
  HE_HIM
  SHE_HER
  THEY_THEM
  ANY
  ASK
}

enum Language {
  ENGLISH
  SPANISH
  JAPANESE
  DUTCH
  GERMAN
  TURKISH
  OTHER
}

enum Region {
  NA
  SA
  EU
  JP
  AS
  AF
  AU
}

enum PlayerRank {
  NOVICE
  SILVER
  GOLD
  MASTER
  GRANDMASTER_I
  GRANDMASTER_II
  GRANDMASTER_III
  ANNIHILATOR
}

enum Role {
  RUSHER
  MID
  FLEX
  GRIEFER
  MINERUSHER
  DEFENDER
  SKY_TP
  WALL_BUILDER
  BUNKER
  FARMER
  GOLD_MINER
}

enum Playstyle {
  TEAM_FIRST
  SHOTCALLER
  PROACTIVE
  DEFENSIVE
  GAP_DROPPER
  SUPPORTER
  FLEXIBLE
  STRATEGIST
  SUPPORTIVE
  CLUTCH
  CHILL
  EGOIST
  WHIMSICAL
  ADAPTABLE
  INVIS_OPPORTUNIST
}
```

## Storage/Update Logic

- On `/profilecreate`, upsert Profile by `playerId`.
- Fields set to empty via “Clear” remove values (set to null/empty array).
- Store enum arrays for multi-selects.

## UI/UX Details (Discord Components)

- Use `StringSelectMenuBuilder` for enums and multi-select roles.
- Sections:
  - Pronouns
  - Languages
  - Region
  - Rank
  - Roles (Preferred / Good at / Improve)
  - Playstyles
- Each section has: `Save`, `Clear`, `Back`.
- “Save All” available on main screen.
- Interaction timeouts handled gracefully (disable components after timeout).

## Tests

- `/profile` resolves self by default and shows latestIGN.
- `/profile <IGN>` resolves by latest IGN.
- `/profile <mention>` resolves by Discord ID.
- `/profilecreate` denied outside bot commands channel.
- `/profilecreate` denied in DMs.
- Selection + save persists in Prisma stub; subsequent `/profile` shows saved fields.
- Clear removes values.

## Notes / Future

- Add optional local assets (icons) for roles/ranks in embeds.
- Consider per-field display ordering for consistent output.
