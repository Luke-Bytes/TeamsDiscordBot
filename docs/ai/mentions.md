# Navi: /ask and @mention

Navi answers stateless questions through the same read-only AI assistant whether you use `/ask question:...` or include an **explicit @Navi mention** in a normal server message, e.g. `@Navi what are my stats?`, `Hey @Navi, how do I register?` or `@Navi what's happening with the current game?`. Messages must contain a real Discord bot mention, not the plain word “Navi”. A reply to Navi without an explicit new mention is **not** a follow-up request. Attachments, embeds, referenced messages and channel history are never included.

In the configured Friendly Wars home server, both **/ask and @Navi mentions work in all supported text channels and threads except blacklisted channels**. The three built-in exclusions are the configured `channels.teamPickingChat`, `channels.announcements` and `channels.gameFeed` IDs, including threads under those channels. `botCommands` is a home-guild anchor, **not a whitelist for either entry point**. Additional exclusions are configured in `config.json`:

```json
{
  "ai": {
    "enabled": true,
    "mentionEnabled": true,
    "mentionExcludedChannels": ["123456789012345678"]
  }
}
```

The built-in exclusions apply to both entry points even when `mentionExcludedChannels` is omitted or empty. All additional entries must be Discord channel IDs (not names). `mentionEnabled` defaults to true _when_ `ai.enabled` is true; set it to false to disable mentions without disabling `/ask`. Setting `ai.enabled` to false disables **both** entry points. Configure the `channels.botCommands` ID, which is used to resolve the trusted home server; development mode additionally restricts both entry points to `dev.guildId`.

**Privacy and limits:** Mention answers and server `/ask` answers are **public replies** in the channel or thread where the question was posted. `/ask` in bot DMs remains private. Ordinary DM messages and DM mentions do not invoke Navi; existing captain-plan DMs continue separately. Both methods share the same process-local per-user 5-second cooldown, 5 requests per rolling minute, per-user in-flight limit, maximum 2 concurrent requests, and daily request budget (300 by default). A rejected mention may get a brief throttled explanation. Navi rechecks home-server membership and organiser roles from Discord and uses only approved, read-only tools; **neither method can perform game operations**. Live organiser-only diagnostics remain role-gated, but an organiser's requested answer is still publicly visible if asked in a server channel. Do not post secrets or sensitive questions publicly.

Navi requires Discord's Guild Messages, Message Content and Guild Members intents, plus permissions to view the target channel, send messages, send replies and send typing indicators. If replies are unavailable, Navi does not send fallback messages elsewhere. Mentions in excluded channels are silently ignored; `/ask` there returns a private (ephemeral) explanation.
