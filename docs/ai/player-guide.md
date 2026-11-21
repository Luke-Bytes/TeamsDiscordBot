# Player AI knowledge guide

This is the short player overview for Friendly Wars. The focused guides cover registration, teams and captains in `player-actions.md`, events and Discord features in `player-community.md`, and statistics in `player-stats-and-history.md`. They describe ordinary commands, not permissions for the assistant to act.

## Getting help with commands

Use `/help` or Discord's slash-command picker to find available options. For games, start with `/register`, `/registered` and `/team list`; for statistics, use `/stats`, `/leaderboards` and `/season view`. Tournament `/sign up` is separate from friendly-war `/register`. Some commands require a particular channel, captain role, organiser role or game stage. Ask an organiser if a permission or game-state check blocks you.

## FW game process: announce, register, start, finish

A Friendly War (FW) is a community-run competitive match in Shotbow's Minecraft Annihilation. An organiser previews an announcement with the scheduled time, map, class bans and any modifiers, then confirms it to publish the game. Players register; organisers arrange teams and captains, and relevant map votes or captain class bans are completed before starting. The teams play the match, then organisers record that gameplay ended, confirm the winning team and finalise the result. MVP voting and saved statistics follow the end-of-game workflow. A game being marked ended does **not** mean its winner or saved result has been confirmed. For a question about the _current_ match, check live data instead of assuming a stage.

## AI assistant privacy and limitations

`/ask` can explain approved player instructions and, when enabled, read limited public stats, historical records and a role-filtered current-game snapshot. A current-process `finished` flag does not prove that a result was saved; a missing historical record does not mean zero wins. It cannot change your Minecraft link, grant roles, save a game or read private event answers, logs, secrets or raw database records. Replies in the configured server command channel are public; direct messages to the bot remain private to the conversation. A hosted provider still receives the question and selected approved context. Never paste passwords, personal form answers or tokens into a question. If `/ask` is unavailable, ordinary commands still work.
