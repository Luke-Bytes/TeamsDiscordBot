/**
 * Conservative, server-chosen lookups for questions where a small model may
 * otherwise skip a vital read. Inputs are fixed/bounded and still pass through
 * executeAiTool's fresh membership checks and Prisma selectors.
 */
/** Only historical match/recording requests trigger local archive reads. */
export function asksForTournamentMatchArchive(question: string): boolean {
  const q = question.trim();
  const archiveCue =
    /\b(?:tournaments?|historical|archive|recordings?|recorded|streams?|streamed|videos?|quarter[ -]?finals?|semi[ -]?finals?|grand finals?|remember)\b/i.test(
      q
    );
  const matchCue =
    /\b(?:matches?|games?|rounds?|recordings?|streams?|videos?|played|play|beat|vs|versus|finals?|quarter[ -]?finals?|semi[ -]?finals?)\b/i.test(
      q
    );
  const duel =
    /\b(?:mrk|f3|nyrq|rawr|aura|annl|ddd|agency|poiuYT|grim|apl|awf)\b/i.test(
      q
    ) && /\b(?:vs|versus|beat|played|matches?|games?)\b/i.test(q);
  const mapHistory =
    /\b(?:which|what|find|show|list)\s+(?:recorded\s+)?matches?\b.{0,60}\b(?:coastal|canyon|andorra|skylands|hamlet)\b/i.test(
      q
    );
  return (archiveCue && matchCue) || duel || mapHistory;
}

export function autoReadsForAsk(
  question: string,
  organiser = false
): Array<{ name: string; arguments: string }> {
  const q = question.trim();
  if (asksForTournamentMatchArchive(q))
    return [
      {
        name: "search_tournament_matches",
        arguments: JSON.stringify({ text: q.slice(0, 240).trim() }),
      },
    ];
  // Organiser operational intent is selected by the server, not by the model.
  // Avoid all external checks for timeless command help or general chat.
  const gameTopic =
    /\b(?:games?|matches?|announc(?:e|ement)|register(?:ed|ing)?|registration|signups?|teams?|rosters?|drafts?|pick(?:ing|ed)?|captains?|classes?|bans?|polls?|maps?|minerush|timers?|players?|roles?|voice|vcs?|start(?:ing)?|end(?:ed|ing)?|shutdown|winner|mvp|results?|sav(?:e|ed|ing)|cleanup|discord|recovery)\b/i.test(
      q
    );
  const operationalCue =
    /\b(?:current|this|our|we|we've|we're|now|today|tonight|next|left|ready|already|still|stuck|broken|fail(?:ed|s|ure)?|errors?|errored|timed?\s*out|timeout|missing|didn't|doesn't|isn't|hasn't|haven't|can't|cannot|won't|never|unexpected|wrong|unresponsive|issue|paused|recovered|restart(?:ed)?|retry|lost|finish|complete|before|after|actually|automatic|ago|ages)\b/i.test(
      q
    ) ||
    /\b(?:what(?:'s| is)? (?:left|next)|what (?:do|should) (?:we|i) do next|why can't|safe to (?:retry|start))\b/i.test(
      q
    );
  const nextStep =
    /\b(?:what(?:'s| is)? (?:left|next)|what (?:do|should) (?:we|i) do next|can (?:we|i) start)\b/i.test(
      q
    );
  if (organiser && (gameTopic || nextStep) && (operationalCue || nextStep)) {
    const reads = [{ name: "get_current_game_state", arguments: "{}" }];
    const persistence =
      /\b(?:shutdown|persist(?:ed|ence)?|database|committ?ed|saved|save|result|cleanup|duplicate)\b/i.test(
        q
      );
    if (persistence)
      reads.push({ name: "get_game_persistence", arguments: "{}" });
    const discordFocus = /\b(?:poll|minerush|map vote)\b/i.test(q)
      ? "polls"
      : /\b(?:announcement|announced|published)\b/i.test(q) &&
          /\b(?:message|post|publish|appear|missing|didn't|never|not)\b/i.test(
            q
          )
        ? "announcement"
        : /\b(?:voice|vc|roles?|moved?|discord|disconnect|failed?\s+start|start\s+failed|start\s+errored|start\b.{0,25}\berrored|partial)\b/i.test(
              q
            )
          ? "players"
          : null;
    if (discordFocus)
      reads.push({
        name: "get_game_discord_state",
        arguments: JSON.stringify({ focus: discordFocus }),
      });
    if (
      /\b(?:teams?|rosters?|drafts?|pick(?:ing|ed)?|captains?|classes?|bans?|players?|register(?:ed|ing)?|registration|replacement|winner|mvp|ready|next|left|start)\b/i.test(
        q
      ) &&
      reads.length < 3
    )
      reads.push({ name: "get_game_roster", arguments: "{}" });
    return reads.slice(0, 3);
  }
  if (
    /^(?:what|which|list|show|name|tell me)\b/i.test(q) &&
    /\b(?:commands?|slash commands?)\b/i.test(q) &&
    !/\b(?:can you|tools?|scripts?|non.read.only|actions?)\b/i.test(q)
  )
    return [{ name: "get_command_catalog", arguments: "{}" }];
  if (
    /\b(?:who|name|list|which)\b/i.test(q) &&
    /\b(?:organisers?|organizers?)\b/i.test(q) &&
    /\b(?:all|the|fw|friendly wars|who)\b/i.test(q)
  )
    return [{ name: "list_organisers", arguments: "{}" }];
  // Preload both named career records for head-to-head draft comparisons.
  const comparison =
    /\b(?:pick|choose|draft|compare|between|versus|vs)\b.{0,90}?\b([a-z0-9_]{3,16})\s+(?:or|and|vs\.?|versus)\s+([a-z0-9_]{3,16})\b/i.exec(
      q
    );
  if (comparison && comparison[1].toLowerCase() !== comparison[2].toLowerCase())
    return [comparison[1], comparison[2]].map((ign) => ({
      name: "get_player_all_time_stats",
      arguments: JSON.stringify({ ign }),
    }));
  // Explicit season/Elo standings are factual rankings, not draft advice.
  const standingQuestion =
    /\b(?:ranked|elo|leaderboards?|standings?|season\s+\d+|this season|current season)\b/i.test(
      q
    ) &&
    /\b(?:top|best|highest|leaders?|rank|players?|who|standings?|leaderboards?)\b/i.test(
      q
    ) &&
    !/\b(?:pick|draft|choose|recommend|suggest|my|mine)\b/i.test(q) &&
    !/\b(?:all[- ]time|career|most wins?)\b/i.test(q);
  if (standingQuestion) {
    const requested = /\bseason\s+(\d{1,4})\b/i.exec(q);
    return [
      {
        name: "get_leaderboard",
        arguments: JSON.stringify({
          limit: 10,
          ...(requested ? { season: Number(requested[1]) } : {}),
        }),
      },
    ];
  }
  // Wins-only records are valid, but should never stand in for "best player".
  const specificallyWins =
    /\b(?:most|total|cumulative|highest)\s+(?:saved\s+)?wins?\b|\bwins?\s+(?:leaderboard|ranking|totals?|count)\b|\b(?:top|best)\b.{0,35}\bby wins\b/i.test(
      q
    );
  if (
    !specificallyWins &&
    (/\b(?:best|greatest|strongest|top)\b.{0,45}\b(?:players?|picks?|fw|friendly wars|all[- ]time)\b/i.test(
      q
    ) ||
      /\b(?:players?|picks?)\b.{0,45}\b(?:best|greatest|strongest)\b/i.test(
        q
      ) ||
      /\b(?:who|whom|which)\b.{0,45}\b(?:pick|draft|choose)\b/i.test(q) ||
      /\b(?:first|early)\s+pick\b/i.test(q) ||
      /\b(?:recommend|suggest)\b.{0,45}\b(?:players?|picks?)\b/i.test(q))
  )
    return [{ name: "get_player_performance_shortlist", arguments: "{}" }];
  if (specificallyWins && !/\b(?:this|current|season)\b/i.test(q))
    return [{ name: "get_all_time_leaderboard", arguments: "{}" }];
  const careerScope =
    /\b(?:all[- ]time|lifetime|career|across (?:all|every) seasons?|ever)\b/i.test(
      q
    );
  const careerMetric =
    /\b(?:stats?|statistics|record|wins?|losses?|win rate|games?|mvps?|captain|streaks?|elo|rating|performance)\b/i.test(
      q
    );
  if (careerScope && careerMetric) {
    if (/\b(?:my|mine|i|me)\b/i.test(q))
      return [{ name: "get_my_all_time_stats", arguments: "{}" }];
    const named =
      /\b(?:stats?|statistics|record|wins?|losses?|games?|mvps?|of|for|has|did)\s+(?:of\s+|for\s+)?([a-z0-9_]{3,16})\b/i.exec(
        q
      ) ??
      /^([a-z0-9_]{3,16})\s+(?:all[- ]time|career|lifetime)\b/i.exec(q) ??
      /\b([a-z0-9_]{3,16})['’]s\s+(?:all[- ]time|career|lifetime)\b/i.exec(q);
    if (
      named &&
      !/^(?:the|all|this|that|ever|every|many|my|team|record|season|stats|games|wins|losses|captain|time)$/i.test(
        named[1]
      )
    )
      return [
        {
          name: "get_player_all_time_stats",
          arguments: JSON.stringify({ ign: named[1] }),
        },
      ];
  }
  if (
    /\b(?:all[- ]time|ever|historically)\b/i.test(q) &&
    /\b(?:best|top|greatest|leader|players?|wins?)\b/i.test(q)
  )
    return [{ name: "get_all_time_leaderboard", arguments: "{}" }];
  if (
    /\b(?:leaderboards?|rankings?|standings?)\b/i.test(q) &&
    /\b(?:who|where|what|position|place|rank|top|first|second|third|fourth|fifth|\d+(?:st|nd|rd|th))\b/i.test(
      q
    )
  )
    return [{ name: "get_leaderboard", arguments: '{"limit":10}' }];
  const namedStats =
    /\b(?:analy[sz]e|analysis of|review|explain|describe)\s+(?:the\s+)?stats?\s+(?:of|for)\s+([a-z0-9_]{3,16})\b/i.exec(
      q
    );
  if (
    namedStats &&
    !/^(?:myself|mine|this|their|someone)$/i.test(namedStats[1])
  )
    return [
      {
        name: "get_player_stats",
        arguments: JSON.stringify({ ign: namedStats[1] }),
      },
      ...(/\bseason\s+\d+\b/i.test(q)
        ? []
        : [
            {
              name: "get_player_all_time_stats",
              arguments: JSON.stringify({ ign: namedStats[1] }),
            },
          ]),
    ];
  if (
    /\b(?:fun|interesting|surprising)\s+facts?\b/i.test(q) &&
    /\b(?:fw|friendly wars|season|server)\b/i.test(q)
  )
    return [
      { name: "get_season_summary", arguments: "{}" },
      { name: "get_recent_games", arguments: "{}" },
    ];
  return [];
}
