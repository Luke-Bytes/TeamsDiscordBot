# Player actions: friendly wars and match requests

## How do I join the next game? `/register`
After an organiser announces a friendly war, use `/register` in the **registration channel**. If you have not linked a Minecraft identity before, supply `ingamename` (your Minecraft username); otherwise leave it blank to reuse your linked account. The optional `discorduser` option is for organisers registering someone else.
Registration fails if there is no announcement, you are already on the roster, you have an active friendly-war ban, your Minecraft identity cannot be verified, or Discord membership cannot be checked. Check `/registered` before retrying. A registration during or after team picking is a **late sign-up** and does not guarantee a place on a team.

## Can I register with a different Minecraft account or correct my IGN?
`/register ingamename:<name>` verifies the Minecraft account; it **does not let you replace an already linked account with a different one**. `/unregister` only leaves the current game and does not unlink your Minecraft account. A changed username on the same account can still resolve to the linked identity.
If verification is temporarily unavailable, retry later with the same account. If the wrong account is linked or you need an account correction, **contact an organiser to request an identity review**; provide the currently linked and intended Minecraft usernames. Do not try to bypass the link with a different Discord account.

## How do I leave a game? `/unregister`
Use `/unregister` in the **registration channel** while a game is announced. It removes you from that game's roster; only organisers may supply `discorduser` to remove somebody else. If you were not registered or there is no announcement, nothing can be removed.
Leaving during team picking or after teams are decided may be reviewed by organisers, but a warning is not itself a punishment. If team displays or Discord roles do not update correctly, ask an organiser to check the roster.

## Who is signed up, and what team am I on? `/registered` and `/team list`
`/registered` lists Minecraft names currently signed up, with late sign-ups separately shown; it can say nobody is registered. `/team list` shows the current **red and blue** team assignments and captains where available.
These are different views: registered players can still be unassigned, so an IGN in `/registered` may not appear on either team in `/team list`. Generating or resetting teams is organiser-controlled; ask an organiser if picking has not finished.

## How do I volunteer to captain? `/captainnominate`
If you are registered for the announced game and it has not started, use `/captainnominate` with no options. It sends a nomination for an organiser to consider; **it does not appoint you captain**. You cannot nominate again if you already have an active nomination. In The People's Captains scenario, everyone registered when voting opens is eligible without nominating.
The command rejects unregistered players and nominations after the game starts. An organiser must select captains; captain changes are not available while team picking is in progress.

## How do captains ban classes? `/class ban` and `/class bans`
A team captain with the captain role can use `/class ban class:<full class name>` when class bans are enabled for the announced game. Spell out the class (for example, `scout`, not `sco`). Depending on game rules, a ban may affect both teams or a particular team.
A ban can fail when no bans are allowed, your allowance is used, your team's ban window closed, the class is unknown, or the class is already banned or protected by game rules. `/class bans` is for **viewing**, not placing bans: it may hide the names until both captains have used their bans, or show that bans take effect at a later phase. Ask an organiser when the window is closed.

## How do I vote for MVP? `/mvp vote`
After the game is marked finished, players who participated can use `/mvp vote player:<Minecraft username or Discord ID>` in **their own team's text channel**. Pick another player on your team who is **not** its captain; you cannot vote for yourself or an opponent, and each player gets one vote.
If the bot says the match is not finished, wait for the organiser to end it. If it cannot find the player, check the name and team. Voting is unavailable to non-participants or once the match has been cleaned up.

## Can a captain forfeit? `/forfeit`
Only the **current red or blue team captain** can run `/forfeit` during a started, active match. The command presents **Confirm Forfeit** and **Cancel** buttons; only the captain who opened that confirmation can use them. Confirming sets the opposing team as the winner; the organiser still completes the match's end-of-game process.
It will fail before the match starts, after it finishes, if the captain or team role is missing, or if the confirmation belongs to an old game. Check with your team before confirming, and speak to an organiser about any role mismatch.

## Our team needs a replacement: `/need`
After teams are decided, the current captain can use `/need` for their own team to post a **one-player** request. The optional `team` choice selects `Red` or `Blue` (useful when a team cannot be inferred); optional `ping` requests a game-notification-role mention. An organiser can also post or cancel a team's request.
A request needs an announced, active game with completed team picking; only one open request per team is allowed. To fill one, **first use `/register`**, remain unassigned to a team, then press **Join** on the posted request. The captain or organiser can cancel it using its button. Expired, filled, or cancelled requests cannot be joined.

## How do I format a game request for Shotbow hosts? `/game request`
Use `/game request time:<when> banned_classes:<classes or none> map:<map>` to generate a **filled-in game request template** to send to Shotbow hosts for games separate from Friendly Wars. It does not submit a request to a host, announce or schedule a match. Optional choices are `phase_5_type` (`Bleed`, `Double`, `Nothing`), `duel`, `looking_for_players` (both `Yes`/`No`), and `timezone` for natural-language times.
Choose the offered map/class suggestions where possible. A time the bot cannot parse will be rejected; specify a clearer date/time or timezone. Copy the generated request and send it to the appropriate host yourself.

## How do I ask to spectate someone's voice channel? `/spectate`
Use `/spectate action:request user:@captain` (or a clan leader). The target must currently be in a voice channel and have the captain or clan-leader role. They can accept/deny the request sent by DM; an eligible leader can also use `/spectate action:allow user:@requester` **for an existing pending request**.
Requests expire after **15 minutes**. To be moved when approved, first join **any** voice channel; approved spectators are moved to the leader's channel and server-muted/deafened. If DMs fail, ask the leader to use `action:allow`. Permission, voice-presence, or expired-request errors mean the request needs attention or restarting.

## How do I rejoin or stop spectating? `/spectate`
After approval, if you leave, join any voice channel and run `/spectate action:rejoin` while your spectate session remains active (up to **one hour**). Without an active session, ask for permission again.
To end spectating, join a voice channel if needed and use `/spectate action:stop`; this removes the spectator role and reverses the spectator mute/deafen settings. It does **not** promise to move you elsewhere. If Discord role or voice changes fail, ask an organiser to check your state.
