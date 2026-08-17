# Friendly Wars Bot

A Discord bot to manage and create teams automatically.

Open source and open to community contributions.

## How to run

Compatible with all OSs.

Rename env.sample to .env and add your credentials

Optionally, add your testing discord server ID to GuildId in config.json and enable dev mode to work on commands efficiently.

Rename config.sample.json to config.json and add your role and channel IDs.

Build first with:
-npm run build

Start with:
-npm run dev
or
-npm run prod

## Features

- Create random or draft teams
- Set team and organiser roles
- Manage announcements and polls
- Record game and player data into a database
- Run Ranked and Relaxed seasons with automatic game/month rollovers

## Season management

Seasons are stored entirely in MongoDB; `config.json` has no season selector.
Use `/season start` only to bootstrap when no season is active, `/season
configure` to set game/month limits and type policy, `/season status` to inspect
progress, and confirmed `/season end` for a manual rollover. A successor is
activated even if Discord announcements fail; recap, title, and new-season
blocks are persisted and retried after restart.

Ranked seasons update Elo and award placement titles. Relaxed seasons retain
games, records, streaks, captains, and MVPs but never change Elo, write Elo
history, or produce ranked leaderboards. Successor types alternate unless an
organiser sets a one-time override.

## Known Issues

-
