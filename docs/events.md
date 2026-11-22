# Standalone events

Standalone events provide tournament and other one-off sign-ups separately from friendly-war games. Signing up never registers someone for a game or changes Elo, seasons, or team roles. Each server has one current event; previous events and their applications remain in the database.

## Server setup

Create a text channel such as `tournament-sign-ups` and a participant role. Add their IDs to `config.json`:

```json
{
  "channels": { "eventSignUps": "SIGN_UP_CHANNEL_ID" },
  "roles": { "eventParticipantRole": "PARTICIPANT_ROLE_ID" }
}
```

Merge these keys into your existing channel and role objects. The keys are optional for installations that do not use events. The bot needs access to the sign-up channel and Manage Roles; its highest role must be above the participant role. Existing `organiserRole` members manage events and inspect answers. Answers, review screens, and exports are private.

## Organiser workflow

1. Create a draft with `/event create title:... description:... terms:...`. Set optional `starts-at`, `deadline`, and `capacity` options. Dates use ISO format with a time zone, such as `2030-06-01T19:00:00Z`. Use `capacity:0` for unlimited capacity and `deadline:none` to clear a deadline when editing. Save the returned event ID: drafts are not current events, so supply `event:<ID>` when configuring or opening them. To permanently discard an unused draft, use `/event delete event:<ID>` and confirm the private prompt. Only never-opened drafts without sign-ups can be deleted; opened and finished events are protected.
2. Build the form with `/event question add`, `edit`, `remove`, and `move`. Set `label`, `type`, and optional `required` (default true); separate choice `options` with `|`. Editing/removing uses a 1-based `number`; moving also uses a 1-based `position`. Questions can be required or optional short text, long text, single choice, or multiple choice. Preview with `/event preview`. Questions can also be edited again while an opened event is **CLOSED**.
3. Open the event with `/event open`. This makes it the current event. Questions are frozen while **OPEN**, but organisers can use `/event close`, change questions, check `/event preview`, then `/event reopen`. Terms remain frozen after the first opening. A question edit cannot invalidate existing confirmed/reserve answers (for example, changing choice options or adding a required question). Existing answers are preserved, and any in-progress forms must be restarted after a change. Metadata, capacity, and the deadline can still be corrected. Capacity cannot be reduced below the confirmed player count.
4. Inspect the private roster with `/event roster`, read an application with `/event response`, or download `/event export`. Exports contain submitted answers and may contain personal information; share them only with the intended organisers.
5. Use `/event close` to stop regular admission manually and `/event reopen` to allow it again, subject to capacity and deadline. **Closing still permits reserve sign-ups and existing sign-up edits**, so avoid making conflicting form changes while these are in progress. Use `/event finish` only when the event is finished: it stops all player changes and promotions and removes participant roles.
6. Create a new draft for the next event. Finish the current event before opening another. Use `/event list` and `/event view` to find historical events without replacing their records.

The form supports up to 20 questions, up to 25 options per choice question, and up to 1,000 characters per text answer. Forms, terms, and answer reviews are paginated where needed.

## Player workflow

In the configured sign-up channel, use `/sign up` (with `minecraft-username` if needed). Existing players reuse their stored Minecraft identity. Newcomers must supply a valid Minecraft username; a failed identity lookup requires retrying and does not register them for a game. Event sign-up cannot overwrite an existing linked player's current IGN.

The /sign command responds publicly so people can see sign-up activity. The questionnaire, answers, terms review and `/sign view` details are sent only to the applicant in private Discord responses. A successful submission posts a public confirmed/reserve status without revealing answers. Complete the questions, review the answers and terms, and explicitly agree to submit. An abandoned form does not create an application or replace previously saved answers. Private form sessions expire after 30 minutes and must then be started again.

Use `/sign view` to see your application, `/sign edit` to correct it, and `/sign withdraw` if you cannot attend. Confirmed players and reserves can edit or withdraw until the event is marked finished. Editing keeps your reserve position; withdrawing and rejoining puts you at the end of the queue. Active sign-ups display the player's current linked Minecraft account, and `/username update` changes active sign-up account fields alongside the main player identity. Withdrawn applications and finished events retain the IGN and UUID saved in their historical records. An in-progress sign-up form must be restarted if its linked account changes.

## Capacity, closure, and reserves

An application is confirmed while regular admission is open, the deadline has not passed, and there is capacity. Otherwise the player can apply as a reserve. Capacity and deadline closure are automatic. Manual closure also stops regular admission, even when places remain.

When a confirmed player withdraws, the earliest reserve is automatically promoted before a new applicant can take the place. Promotions continue after the regular deadline and manual closure until the organiser finishes the event. Reserve applications also remain available until finishing. The event start date itself does not stop applications or promotions.

Only confirmed players receive the participant role. Promotion attempts a private notification; disabled DMs do not undo a promotion. Roles are removed after withdrawal or finishing. A member who leaves and later rejoins is checked again for their current participant role. Discord failures are retried every minute and after restart using database state, so the saved application status remains authoritative.

Without a configured capacity there is no player limit. If such an event is manually closed or past its deadline, reserves remain queued: each confirmed withdrawal promotes only one reserve. Reopening before the deadline admits all queued reserves. Without a deadline, regular admission has no time limit. Changing the deadline or capacity can make regular admission available again, unless the event was manually closed.

## Records and deployment

The additive Prisma models are `StandaloneEvent`, `EventSignup`, and `EventGuildState`. Applications are unique per event and Discord user. Withdrawn applications retain their last submitted answers; editing replaces answers rather than storing a full answer revision history. Acceptance timestamps and form revision are retained. The current event is server-specific and historical events remain accessible to organisers.

Before deployment, review the schema changes and follow your normal backed-up MongoDB schema deployment process. Generate the Prisma client with `npm run build`. Deploy the additive collections/indexes using the normal reviewed Prisma/MongoDB process, including the unique indexes on `(eventId, discordUserId)` and `guildId`, before opening an event. MongoDB transactions require a replica set, as do the existing transactional bot flows. No production database update is performed by building or by the offline tests.

Register the new slash commands through the bot's normal startup process. Prefer a development guild for initial validation; global commands may take time to appear. Verify a complete draft/open/signup/withdraw/promote/finish cycle with a test event before announcing the first real event. Do not use maintenance scripts to deploy this feature.

On restart, incomplete private forms must be restarted. Persisted events, applications, and pending role synchronisation survive. If role updates fail, check Manage Roles, role hierarchy, channel access, and whether the member still belongs to the server. Do not repeatedly re-submit an application to repair a role.
