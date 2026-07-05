import { CommunityAnswer, FilteredCommunityNotes } from "./types";
import { PLAYSTYLE_LABELS, ROLE_LABELS } from "../../util/ProfileUtil";

const DIRECT_TIER_COMMAND =
  /\b(put|place|rank|make)\s+(them|him|her|this player)?\s*(in\s*)?[sabcde]\s*(tier)?\b/i;
const INSULTS = /\b(trash|garbage|useless|dogshit|shit|idiot|clown)\b/i;
const MEME_ONLY = /^(lol|lmao|xd|w|l|mid|goat|fraud|based|meme)+[.!?\s]*$/i;
const ROLE_TERMS = Object.values(ROLE_LABELS);
const PLAYSTYLE_TERMS = [
  "Team-first",
  "Shotcaller",
  "Proactive",
  "Defensive",
  "Gap Dropper",
  "Supporter",
  "Flexible",
  "Strategist",
  "Clutch",
  "Invis Opportunist",
];
const VALUE_TERMS = [
  "shotcalling",
  "shotcall",
  "comms",
  "comm",
  "pressure",
  "defence",
  "defense",
  "support",
  "clutch",
  "consistency",
  "consistent",
  "morale",
  "specialist",
  "flex",
  "both",
  "rush",
  "defend",
  "mine rush",
  "grief",
  "sky tp",
  "farm",
  "gold",
];
const CAVEAT_TERMS = [
  "inconsistent",
  "quiet comms",
  "role-limited",
  "role limited",
  "needs support",
  "risky plays",
  "rusty",
  "unknown",
];
const SUMMARY_TERMS = [
  ...ROLE_TERMS,
  ...Object.values(PLAYSTYLE_LABELS),
  ...VALUE_TERMS,
  ...CAVEAT_TERMS,
];
const SIGNAL_TERMS = [
  ...ROLE_TERMS,
  ...PLAYSTYLE_TERMS,
  ...VALUE_TERMS,
  ...CAVEAT_TERMS,
  "playstyle",
  "value",
  "team",
  "captain",
  "comparable",
  "similar",
  "leader",
  "mechanic",
  "fight",
  "pvp",
  "macro",
  "role",
];

export function filterCommunityAnswers(
  answers: CommunityAnswer[],
  maxAccepted = 5
): FilteredCommunityNotes {
  const accepted: string[] = [];
  const rejected: { content: string; reason: string }[] = [];
  const seenUsers = new Set<string>();
  const seenNormalized = new Set<string>();

  for (const answer of answers) {
    const content = normalizeWhitespace(answer.content);
    const normalized = content.toLowerCase();

    if (seenUsers.has(answer.userId)) {
      rejected.push({ content, reason: "duplicate user" });
      continue;
    }
    if (seenNormalized.has(normalized)) {
      rejected.push({ content, reason: "duplicate answer" });
      continue;
    }
    if (DIRECT_TIER_COMMAND.test(content)) {
      rejected.push({ content, reason: "direct tier command" });
      continue;
    }
    if (content.length < 18 && !hasKnownOptionSignal(content)) {
      rejected.push({ content, reason: "too short" });
      continue;
    }
    if (INSULTS.test(content) || MEME_ONLY.test(content)) {
      rejected.push({ content, reason: "low relevance or insult" });
      continue;
    }
    if (!hasRelevantSignal(content)) {
      rejected.push({ content, reason: "no playstyle or team-value signal" });
      continue;
    }

    accepted.push(content);
    seenUsers.add(answer.userId);
    seenNormalized.add(normalized);
    if (accepted.length >= maxAccepted) break;
  }

  return {
    accepted,
    rejected,
    summary: accepted.length ? summarizeCommunityNotes(accepted) : null,
  };
}

function summarizeCommunityNotes(answers: string[]) {
  const roleWords = countMatches(answers, SUMMARY_TERMS);
  const themes = Object.entries(roleWords)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);

  const themeText = themes.length
    ? `Common subjective themes: ${themes.join(", ")}.`
    : "Community notes were subjective and varied.";

  return `${themeText} Accepted notes: ${answers.join(" | ")}`;
}

function countMatches(answers: string[], terms: string[]) {
  const counts: Record<string, number> = {};
  for (const term of terms) counts[normalizeTerm(term)] = 0;
  for (const answer of answers) {
    const lower = normalizeTerm(answer);
    for (const term of terms) {
      const normalizedTerm = normalizeTerm(term);
      if (lower.includes(normalizedTerm)) counts[normalizedTerm] += 1;
    }
  }
  return counts;
}

function hasRelevantSignal(content: string) {
  return (
    hasKnownOptionSignal(content) ||
    /\b(playstyle|value|team|support|captain|shotcall|defen[cs]e?|rush|mid|farm|miner|flex|clutch|consistent|comparable|similar|comm|leader|mechanic|fight|pvp|macro|role)\b/i.test(
      content
    )
  );
}

function normalizeWhitespace(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function hasKnownOptionSignal(content: string) {
  const normalized = normalizeTerm(content);
  return SIGNAL_TERMS.some((term) => normalized.includes(normalizeTerm(term)));
}

function normalizeTerm(content: string) {
  return content
    .toLowerCase()
    .replace(/[-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
