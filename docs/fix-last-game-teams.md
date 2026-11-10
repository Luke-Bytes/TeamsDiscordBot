# Correct teams in the latest saved game

After `/game shutdown` completes, run this between games from the project root.
It uses the database configured in `.env`; no bot restart is needed. Preview first:

```bash
npx tsx scripts/fix-last-game-teams.ts --move Alice=RED --move Bob=BLUE
```

Use one `--move Player=TEAM` per correction. To remove someone who did not play,
use `--remove Player`; repeat it for multiple players or combine it with moves:

```bash
npx tsx scripts/fix-last-game-teams.ts --remove Cara --remove Dan --move Alice=RED
```

Players must already be in the saved game; unchanged players keep their teams.
Identifiers can be the recorded IGN, current IGN, Discord ID, or player ID.
Unknown or ambiguous names, duplicate players (even under different identifiers),
and move/remove conflicts are rejected. Both teams must remain nonempty.
Removing an awarded MVP is rejected so the existing MVP awards stay intact.

To preview and apply in one run, include `--apply`, review the displayed game and
changes, then answer `yes`. The latest game is selected automatically; no game ID
lookup or typing is needed. Any answer other than `yes` or `y` cancels:

```bash
npx tsx scripts/fix-last-game-teams.ts --move Alice=RED --move Bob=BLUE --apply
```

The default is the active season's latest finished game. If a new season has no
saved games, the script stops rather than silently selecting an older season.
Add `--season 3` to select a season explicitly. Closing/closed seasons are rejected
because changing their results can invalidate already awarded titles and recaps.
Stored double-Elo and rated/unrated flags are used;
for older rated games without a stored double-Elo flag, specify `--double-elo yes`
or `--double-elo no` based on how that game was played. Calculations use the
current Elo rules and bonuses in `config.json`, with final Elo rounded to an integer.
Historical configuration is not stored with games, so the script cannot recover
older bonus values automatically. For legacy games with neither a rated flag nor
Elo history, it stops because rated/unrated status cannot be safely inferred.

The script reconstructs pre-game stats and recalculates Elo, wins, losses, and
streaks using the corrected team averages. Removed players' stats are restored
to before this game; only their participation and this game's Elo history are
deleted, and their names are removed from the game's participant display list.
Their player accounts and other games are kept. Remaining players retain their
MVP awards, voting/captain flags, record IDs, and Elo history timestamps. The
winner and other game details stay unchanged. Unrated games keep Elo unchanged.
Saved records do not contain individual MVP ballot choices; no MVP recount is
performed. Existing Discord result messages and roles are not edited.

The preview writes nothing. Apply rechecks the source records and Elo configuration,
then commits all changes in one MongoDB transaction. There is no nontransactional
fallback. MongoDB must support transactions (replica set/sharded deployment).

The script stops on invalid player identities, mismatched participant lists,
incomplete or orphaned history, duplicate history, ambiguous legacy rating,
pending cleanup, invalid dates, or integer overflow. It also rejects participants
with equally/later dated or unfinished games, and earlier games with tied timestamps
that prevent reliable streak reconstruction. Current player stats must match the
saved game/history before correction; manual stat changes or missing records are
not silently overwritten. Resolve the reported inconsistency before retrying.

Removed players appear as `REMOVED` in the preview, including their restored stats.
There are no automatic retries. A repeated removal or a move to the already saved
team is rejected. If the connection drops during apply, the transaction may have
committed even though the script could not confirm it: run a fresh preview
**without `--apply`** and inspect the database before deciding whether to retry.

Run between games, before announcing/registering the next game so the bot does not
retain old player stats. A separate script cannot inspect an unsaved game held in
the running bot's memory. Do not run another result-correction tool concurrently.
Tests use an offline database stand-in; the script is not automatically executed
against your database as part of validation.
