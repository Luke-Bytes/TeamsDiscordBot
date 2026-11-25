import { validHistoricalIgn } from "./HistoricalStatsClient";

export type MentionedPlayer = {
  status: "linked" | "unlinked" | "unavailable";
  ign?: string;
};

const MEMBER_MENTION = /<@!?(\d{17,20})>/g;
const ANY_MENTION = /<@!?\d+>|<@&\d+>|<#\d+>/g;
const PLAYER_QUESTION =
  /\b(?:compare|comparison|better|stronger|best|difference|versus|vs\.?|draft|pick|choose|stats?|statistics|record|elo|wins?|losses?|mvps?|captain|rankings?|leaderboards?|performance|game sense|more|fewer|higher|lower|minecraft|ign|username|linked)\b/i;
const COMPARISON =
  /\b(?:compare|comparison|better|stronger|difference|versus|vs\.?|draft|pick|choose|more|fewer|higher|lower)\b/i;
const SELF_PAIR =
  /\b(?:me|myself)\b.{0,25}\b(?:and|or|vs\.?|versus|than|with|to|against)\b|\b(?:and|or|vs\.?|versus|than|with|to|against)\s+(?:me|myself)\b/i;

/**
 * Resolve explicit Discord member mentions before tool selection. IDs are
 * never sent to the model; no lookup occurs for ordinary chat or jokes.
 */
export async function resolveAiPlayerReferences(
  question: string,
  callerId: string,
  caller: MentionedPlayer,
  lookup?: (discordUserId: string) => Promise<MentionedPlayer>
): Promise<{ question: string; error?: string }> {
  const playerQuestion = PLAYER_QUESTION.test(question);
  if (
    playerQuestion &&
    /(?:^|[\s(])@(?!everyone\b|here\b)[a-z][a-z0-9_.-]{1,31}\b/i.test(question)
  )
    return {
      question: "",
      error:
        "Please select the player from Discord's @mention suggestions so I can verify their linked Minecraft IGN.",
    };
  const ids = [
    ...new Set([...question.matchAll(MEMBER_MENTION)].map((match) => match[1])),
  ];
  const names = new Map<string, string>();

  if (playerQuestion && ids.length > 2)
    return {
      question: "",
      error:
        "I can look up at most two mentioned players per question. Try a smaller comparison.",
    };

  if (playerQuestion) {
    for (const id of ids) {
      let result: MentionedPlayer;
      try {
        result =
          id === callerId
            ? caller
            : lookup
              ? await lookup(id)
              : { status: "unavailable" };
      } catch {
        result = { status: "unavailable" };
      }
      if (result.status !== "linked" || !validHistoricalIgn(result.ign)) {
        return {
          question: "",
          error:
            result.status === "unlinked"
              ? "That mentioned server member has no valid linked Minecraft IGN, so I can't compare their stats."
              : "I couldn't verify the mentioned member's Minecraft link right now.",
        };
      }
      names.set(id, result.ign);
    }
  }

  let resolved = question
    .replace(
      MEMBER_MENTION,
      (_token, id: string) => names.get(id) ?? "a mentioned member"
    )
    .replace(ANY_MENTION, "a Discord mention");
  if (COMPARISON.test(resolved) && SELF_PAIR.test(resolved)) {
    if (caller.status !== "linked" || !validHistoricalIgn(caller.ign))
      return {
        question: "",
        error:
          caller.status === "unlinked"
            ? "I couldn't find your linked Minecraft IGN, so I can't compare your stats yet."
            : "I couldn't check your linked Minecraft IGN right now.",
      };
    resolved = resolved.replace(/\b(?:me|myself)\b/gi, caller.ign);
  }
  return { question: resolved };
}
