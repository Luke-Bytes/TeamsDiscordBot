export type TeamPlanSource = "DM" | "CHANNEL" | "MIXED" | "NONE";

export type TeamPlanRecord = {
  midBlocks: string | null;
  gamePlan: string | null;
  raw?: string | null;
  source: TeamPlanSource;
  capturedAt: Date;
};

type ParsedPlan = {
  midBlocks: string | null;
  gamePlan: string | null;
  confidence: "full" | "partial" | "none";
  raw: string | null;
};

const MID_HEADER = /(^|\n)\s*\**\s*mid\s*blocks\s*plan\s*\**/i;
const GAME_HEADER = /(^|\n)\s*\**\s*game\s*plan\s*\**/i;
const ANY_HEADER = /(^|\n)\s*\**\s*(mid\s*blocks\s*plan|game\s*plan)\s*\**/i;

function extractSection(text: string, header: RegExp): string | null {
  const match = header.exec(text);
  if (!match) return null;

  const after = text.slice(match.index + match[0].length);
  const codeBlock = /```([\s\S]*?)```/m.exec(after);
  if (codeBlock && codeBlock[1].trim()) {
    return codeBlock[1].trim();
  }

  const lines = after.split("\n");
  const collected: string[] = [];
  for (const line of lines) {
    if (ANY_HEADER.test(line)) break;
    collected.push(line);
    if (collected.length >= 10) break;
  }
  const cleaned = collected.join("\n").trim();
  return cleaned.length ? cleaned : null;
}

export function parsePlanText(text: string): ParsedPlan {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { midBlocks: null, gamePlan: null, confidence: "none", raw: null };
  }

  const midBlocks = extractSection(trimmed, MID_HEADER);
  const gamePlan = extractSection(trimmed, GAME_HEADER);
  const confidence =
    midBlocks && gamePlan ? "full" : midBlocks || gamePlan ? "partial" : "none";

  const raw = confidence === "none" ? null : trimmed;

  return {
    midBlocks: midBlocks ?? null,
    gamePlan: gamePlan ?? null,
    confidence,
    raw,
  };
}

export function buildTeamPlanRecord(
  text: string,
  source: TeamPlanSource
): TeamPlanRecord | null {
  const parsed = parsePlanText(text);
  if (parsed.confidence === "none" && !parsed.raw) return null;
  return {
    midBlocks: parsed.midBlocks,
    gamePlan: parsed.gamePlan,
    raw: parsed.confidence === "full" ? null : parsed.raw,
    source,
    capturedAt: new Date(),
  };
}
