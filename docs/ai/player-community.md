# Player community: events, profiles and Discord utilities

## How do I apply for a tournament or standalone event? `/sign up`
Use `/sign up` in the server's **event sign-up channel** for its current event. If you do not already have a linked Minecraft account, supply `minecraft-username`; existing players can reuse their linked identity. This is **separate from `/register` for friendly wars** and does not put you into a match.
Answer the form's required questions, review the pages and terms, then press **Agree & submit**. Starting or abandoning the private form does not submit an application. Forms expire after **30 minutes**; if yours expires, run `/sign up` again. A missing event, wrong channel, unverified username, conflicting Minecraft link or finished event can prevent submission.

## Am I confirmed or on the reserve list for an event?
After `/sign up` finishes, the response says **CONFIRMED** or **RESERVE**; check again with `/sign view`. Regular applications are confirmed only while the event is open, before its sign-up deadline, and while places remain. Otherwise an open or manually closed event can still accept **reserve** applications, unless the event is finished.
When a confirmed entrant withdraws, the earliest reserve is promoted first. Promotions can continue after the deadline or manual closure until the event is finished; a scheduled event start time alone does not close applications. Only confirmed entrants get the event participant role. If a role or notification looks wrong, check `/sign view` and contact an organiser rather than submitting a second application.

## How do I view, edit or withdraw my event sign-up?
In the **event sign-up channel**, `/sign view` privately shows your current application, answers and status. Use `/sign edit` to reopen the form and replace your answers; review and submit again. Editing keeps your place on the reserve list. Use `/sign withdraw` if you cannot attend.
Editing or withdrawing works for active confirmed/reserve applications while the event is open or closed, **not after it is finished**. A withdrawn player can use `/sign up` again, but joins the end of the queue. If the bot says you have not applied, start with `/sign up`; if an edit conflicts with a newer submission or expires, restart it. Your answers are not exposed through `/ask`.

## How do I see someone's profile? `/profile`
Use `/profile` for your own profile, or `/profile name:<latest Minecraft IGN, Discord mention or ID>` for another player. It can show a chosen name, title, pronouns, languages, region, rank, preferred roles and playstyle when set.
A missing-player error means the bot has no matching player record. Profiles may be mostly empty until their owner uses `/profilecreate`; `/profile` is a viewer, not an editor.

## How do I create or edit my player profile? `/profilecreate`
Use `/profilecreate` in the **bot commands channel** (or in a DM where supported). You need an existing player record: if told to register first, use `/register` during an announced game. The interactive menu lets you choose a preferred name, title, pronouns, languages, region, rank, roles and playstyles; use **Clear** to remove a field and **Finish** to close the menu.
If you already have a profile menu open, use that one instead of starting another. Custom names must pass input checks. Only titles you have unlocked appear as selectable; editing your profile does not unlock titles.

## What titles can I earn or show? `/titles`
Use `/titles` to see the server's available titles and their stated earning reasons. To display an **already unlocked** title on your profile, open `/profilecreate`, select **Title**, and choose it.
If the title picker says none are available, you have no selectable titles yet; `/titles` is informational and cannot grant them. Title awards are managed by organisers, not through a player self-award command.

## How can I change my Discord nickname to my IGN? `/nickname`
Use `/nickname action:ign` to set your server nickname to your latest stored Minecraft IGN, or `/nickname action:clear` to reset it. These are **Discord server nicknames**, not Minecraft account changes. The optional `user` target is only for organisers changing someone else's nickname.
You must be in the server. Setting to IGN needs a stored Minecraft name, and both actions require the bot to have enough Discord nickname permissions; ask an organiser if a permission error appears.

## How do I create my own temporary voice channel? `/vc create`
In the **bot commands channel**, use `/vc create name:<channel name>`. Optional `user-limit` is 0–99 (0 means no limit), `private:true` starts with connections restricted to you and invited users, and `auto-lock-minutes` (1–720) locks it later. The bot normalises the name and provides the channel to join.
You can own **one temporary voice channel at a time**, which expires after **12 hours**. If creation says one already exists, use `/vc info` or delete it first. An invalid name, missing temporary-voice setup or missing Discord permissions can also prevent creation.

## How do I lock, invite or remove people from my temporary VC?
In the **bot commands channel**, use `/vc lock` to block general connections and `/vc unlock` to restore normal connection permissions. Use `/vc add users:<space-separated mentions, Discord IDs or latest IGNs>` to permit people into your channel, or `/vc remove users:<...>` to block them; removing someone currently inside can disconnect them.
Use `/vc limit user-limit:<0–99>` to change its capacity. These commands manage **your own** temporary VC; if you have none, first use `/vc create`. When a username cannot be resolved, try a Discord mention, and ask an organiser about permission failures. Locking does not cancel permissions explicitly granted to invited people.

## How do I check or delete my temporary VC? `/vc info` and `/vc delete`
Use `/vc info` in the **bot commands channel** to view your temporary channel, owner, locked state, capacity, invitation count and expiration. Use `/vc delete` when finished instead of waiting for expiry.
If no channel is found, there is nothing to manage. The optional `user` option on `/vc info` and `/vc delete` is **organiser-only** when targeting another person's channel.

## Can I get a personal end-of-season recap? `/wrapped`
Use `/wrapped` for your most recently completed season, or `/wrapped season:<number>` for another **completed** season. You need an existing player record; it does not work for the current active season.
If it says no wrapped data was found for that season, try a completed season you participated in. `/wrapped` displays a recap; it does not alter a game or your record.

## Where can I find maps, wiki links or a command list?
`/maps` lists the bot's known Annihilation maps. `/wiki` links to the Shotbow wiki home page; to get a specific article, supply **both** `type:map` or `type:class` and `name:<map/class name>` (autocomplete helps). Unknown names are rejected.
`/help` lists general slash commands. A command showing up in help is not proof you can use it: some commands have channel, role or game-state requirements. Check the specific command's reply or ask an organiser.

## How do I make a Discord timestamp? `/timestamp`
Use `/timestamp time:<date or time>` to make a timestamp Discord readers see in their own local time. Optional `timezone` helps with phrases such as `tomorrow 7pm`; `format` chooses **Date & Time**, **Countdown**, **Time Only**, or **Date Only**. `echo` controls whether the bot also tries to post the raw timestamp code (default true, in supported channels or DMs).
If the time cannot be parsed, try a clearer date or specify a timezone. This formats a time for sharing; it does not schedule an event or send reminders.
