# Player AI knowledge guide

This is the short player overview for Friendly Wars. The focused guides cover registration, teams and captains in `player-actions.md`, events and Discord features in `player-community.md`, and statistics in `player-stats-and-history.md`. They describe ordinary commands, not permissions for the assistant to act.

## Getting help with commands

Use `/help` or Discord's slash-command picker to find available options. For games, start with `/register`, `/registered` and `/team list`; for statistics, use `/stats`, `/leaderboards` and `/season view`. Tournament `/sign up` is separate from friendly-war `/register`. Some commands require a particular channel, captain role, organiser role or game stage. Ask an organiser if a permission or game-state check blocks you.

## How do I play a Friendly War?

As a **player**, join the Friendly Wars Discord server and wait for an announced game. Use `/register` in the registration channel (supply `ingamename` if you have not linked a Minecraft account), then check `/registered` and `/team list` for your assignment. Join your team's voice channel when organisers are ready, follow its captain, and play the announced match on Shotbow's Minecraft **Annihilation** mode. After the game, you can vote for your team's MVP when voting opens. If you mean **how to play Annihilation itself** rather than how to join FW, ask for the Minecraft gameplay rules; those are different from organiser setup commands.

## FW game process: announce, register, start, finish

A Friendly War (FW) is a community-run competitive match in Shotbow's Minecraft Annihilation. An organiser previews an announcement with the scheduled time, map, class bans and any modifiers, then confirms it to publish the game. Players register; organisers arrange teams and captains, and relevant map votes or captain class bans are completed before starting. The teams play the match, then organisers record that gameplay ended, confirm the winning team and finalise the result. MVP voting and saved statistics follow the end-of-game workflow. A game being marked ended does **not** mean its winner or saved result has been confirmed. For a question about the _current_ match, check live data instead of assuming a stage.

## Accurate FW facts and member questions

For "fun facts" about FW, use verifiable details: matches use Shotbow Annihilation; the bot tracks saved season results and Ranked Elo; seasons may be Ranked or Relaxed; captains can nominate and ban classes when allowed. For **current** facts such as active season type or recent winning teams, check the relevant read-only tools first. Do not invent community memes, polls, chat habits, monthly rollover dates, or claims about who is the best player. There is no objective all-time best: the saved all-time leaderboard ranks cumulative wins across seasons, including Relaxed, which is a different measure from current Ranked Elo.

For a question like "who am I?" the caller's organiser status and linked latest Minecraft IGN come from verified server context, not their question. To identify all organisers, use the live public role lookup; if it cannot check the whole roster, do not guess names or claim a complete list. `/ask` can explain what it can **read**; it has no tools to execute bot commands, scripts, database writes or Discord changes.

## AI assistant privacy and limitations

`/ask` can explain approved player instructions and, when enabled, read limited public stats, historical records and a role-filtered current-game snapshot. A current-process `finished` flag does not prove that a result was saved; a missing historical record does not mean zero wins. It cannot change your Minecraft link, grant roles, save a game or read private event answers, logs, secrets or raw database records. Replies in the configured server command channel are public; direct messages to the bot remain private to the conversation. A hosted provider still receives the question and selected approved context. Never paste passwords, personal form answers or tokens into a question. If `/ask` is unavailable, ordinary commands still work.
