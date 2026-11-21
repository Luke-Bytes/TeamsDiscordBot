import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { relative, resolve, sep } from "path";

export type KnowledgeScope = "player" | "organiser";
export type KnowledgeChunk = {
  id: string;
  content: string;
  source: string;
  heading: string;
  startLine: number;
  endLine: number;
  hash: string;
  scope: KnowledgeScope;
};

export type ApprovedSource = {
  path: string;
  scope: KnowledgeScope;
  headings: readonly string[];
};

/**
 * Only reviewed plain-English guides are eligible for the hosted model.
 * Adding more content requires deliberate approval, not a directory scan.
 */
export const APPROVED: readonly ApprovedSource[] = [
  {
    path: "docs/ai/player-guide.md",
    scope: "player",
    headings: [
      "Getting help with commands",
      "FW game process: announce, register, start, finish",
      "AI assistant privacy and limitations",
    ],
  },
  {
    path: "docs/ai/player-actions.md",
    scope: "player",
    headings: [
      "How do I join the next game? `/register`",
      "Can I register with a different Minecraft account or correct my IGN?",
      "How do I leave a game? `/unregister`",
      "Who is signed up, and what team am I on? `/registered` and `/team list`",
      "How do I volunteer to captain? `/captainnominate`",
      "How do captains ban classes? `/class ban` and `/class bans`",
      "How do I vote for MVP? `/mvp vote`",
      "Can a captain forfeit? `/forfeit`",
      "Our team needs a replacement: `/need`",
      "How do I propose a special game? `/game request`",
      "How do I ask to spectate someone's voice channel? `/spectate`",
      "How do I rejoin or stop spectating? `/spectate`",
    ],
  },
  {
    path: "docs/ai/player-community.md",
    scope: "player",
    headings: [
      "How do I apply for a tournament or standalone event? `/sign up`",
      "Am I confirmed or on the reserve list for an event?",
      "How do I view, edit or withdraw my event sign-up?",
      "How do I see someone's profile? `/profile`",
      "How do I create or edit my player profile? `/profilecreate`",
      "What titles can I earn or show? `/titles`",
      "How can I change my Discord nickname to my IGN? `/nickname`",
      "How do I create my own temporary voice channel? `/vc create`",
      "How do I lock, invite or remove people from my temporary VC?",
      "How do I check or delete my temporary VC? `/vc info` and `/vc delete`",
      "Can I get a personal end-of-season recap? `/wrapped`",
      "Where can I find maps, wiki links or a command list?",
      "How do I make a Discord timestamp? `/timestamp`",
    ],
  },
  {
    path: "docs/ai/player-stats-and-history.md",
    scope: "player",
    headings: [
      "/stats: player record and options",
      "/leaderboards: Ranked rating or Relaxed activity",
      "/season view: seasonal participation",
      "Ranked and Relaxed seasons",
      "Which matches change Elo?",
      "How a Ranked Elo change is worked out",
      "Elo bonuses and double-Elo matches",
      "Why statistics might not update yet",
      "Current bot records versus REST_API history",
      "What historical Elo observations prove",
      "Comparing two historical seasons",
      "Reading unavailable, missing and unsupported results",
    ],
  },
  {
    path: "docs/ai/player-ai-tools.md",
    scope: "player",
    headings: [
      "Choosing current, historical or in-progress evidence",
      "get_current_game_state — one public game snapshot",
      "get_recent_games — recently saved results",
      "Historical tools — conditional access and outcomes",
      "get_historical_season_summary — archived season activity",
      "get_my_historical_stats — authenticated old record",
      "get_my_historical_elo — my Ranked Elo timeline",
      "What /ask cannot conclude or do",
    ],
  },
  {
    path: "docs/ai/organiser-guide.md",
    scope: "organiser",
    headings: [
      "How the bot works behind the scenes",
      "Understanding game lifecycle states",
      "Historical questions versus the live game",
      "Organiser privacy and AI boundaries",
    ],
  },
  {
    path: "docs/ai/organiser-game-ops.md",
    scope: "organiser",
    headings: [
      "Announce a match: `/announce start`",
      "Announcement confirmation and edits",
      "Team generation: registered choices",
      "Team generation prerequisites",
      "Team review, reset and cancellation",
      "Captains: `/captain set` and `/captain randomise`",
      "Roster corrections: `/player`",
      "Starting a match is not ending or saving it",
      "Ending gameplay: `/game end`",
      "Recording a winner: `/winner set`",
      "Shutting down: `/game shutdown`",
      "Shutdown uncertainty: stop and verify",
      "Cancel an announcement: `/announce cancel`",
      "Diagnostics: what is observed",
      "Season status and authority",
      "First scheduled rollover versus ordinary rollover",
      "Deferred rollover and pending announcements",
    ],
  },
  {
    path: "docs/ai/organiser-events-and-admin.md",
    scope: "organiser",
    headings: [
      "Event drafting: `/event create` and `/event edit`",
      "Draft questions: `/event question`",
      "Event opening and validation",
      "Event navigation and privacy",
      "Capacity, deadlines and reserves",
      "Closing, reopening and finishing events",
      "Event role sync and delivery failures",
      "Punishments: `/punish add` and `/punish remove`",
      "Reading punishment status: `/punished`",
      "Player titles: `/title`",
      "Minecraft account corrections: `/username update`",
    ],
  },
  {
    path: "docs/ai/organiser-ai-tools.md",
    scope: "organiser",
    headings: [
      "get_current_game_state — organiser snapshot",
      "get_game_diagnostics — same operational snapshot",
      "get_organiser_status — saved season and announcement queue",
      "Recovery, finishing and persistent state",
    ],
  },
];

function safeRead(root: string, path: string): string | null {
  try {
    const base = realpathSync(root);
    const file = resolve(base, path);
    if (!file.startsWith(base + sep) || relative(base, file).startsWith(".."))
      return null;
    let current = base;
    for (const component of relative(base, file).split(sep)) {
      if (component === ".." || component === ".") return null;
      current = resolve(current, component);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return null;
    }
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.size > 25_000) return null;
    const content = readFileSync(file, "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:sk-|AIza)[A-Za-z0-9_-]{24,}/.test(
        content
      )
    )
      return null;
    return content;
  } catch {
    return null;
  }
}

function makeChunk(
  source: ApprovedSource,
  heading: string,
  start: number,
  end: number,
  content: string
): KnowledgeChunk {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return {
    id: `${source.path}:${start}-${end}:${hash}`,
    source: source.path,
    scope: source.scope,
    heading,
    startLine: start,
    endLine: end,
    content,
    hash,
  };
}

export function buildApprovedKnowledge(root: string): KnowledgeChunk[] {
  const result: KnowledgeChunk[] = [];
  for (const source of APPROVED) {
    const content = safeRead(root, source.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const heading of source.headings) {
      const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
      if (start < 0) continue;
      let end = start + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      // Preserve complete paragraphs instead of cutting a sentence after nine
      // lines or 1,400 characters. Oversize paragraphs fail closed.
      let paragraphStart = start + 1;
      for (let n = start + 1; n <= end; n++) {
        if (n < end && lines[n].trim()) continue;
        const text = lines.slice(paragraphStart, n).join("\n").trim();
        if (text && text.length <= 1400)
          result.push(makeChunk(source, heading, paragraphStart + 1, n, text));
        paragraphStart = n + 1;
      }
    }
  }
  return result;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "what",
  "how",
  "are",
  "does",
  "with",
  "this",
  "that",
  "from",
  "when",
  "who",
  "can",
  "about",
  "please",
  "tell",
  "have",
  "where",
  "your",
  "there",
  "doesn't",
  "do",
  "i",
  "my",
  "is",
  "to",
  "it",
  "of",
  "in",
  "a",
  "an",
]);
function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
      // Preserve identifier matches while also finding words inside tool names
      // such as get_my_historical_stats.
      .flatMap((word) => [word, ...word.split("_")])
      .map((word) =>
        /^(registered|registering|registration|registrations)$/.test(word)
          ? "register"
          : /^(win|wins|loss|losses|streak|streaks)$/.test(word)
            ? "stat"
            : /^(teams|captains|seasons|games|events|players|stats|tools|accounts)$/.test(
                  word
                )
              ? word.replace(/s$/, "")
              : word
      )
      .filter((word) => !STOP.has(word))
  );
}

function commands(text: string): Set<string> {
  return new Set(
    (
      text.toLowerCase().match(/\/[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?/g) ??
      []
    ).map((command) => command.replace(/\s+/g, " ").trim())
  );
}

/**
 * All explicitly approved workflow guides are community-readable. The
 * 'organiser' scope labels who normally performs an operation, not who may
 * learn how it works. Live organiser-only tools still enforce Discord roles.
 */
export function retrieveApprovedKnowledge(
  chunks: readonly KnowledgeChunk[],
  question: string,
  _organiser: boolean,
  limit = 4
): KnowledgeChunk[] {
  const queryTerms = terms(question);
  if (!queryTerms.size) return [];
  const queryCommands = commands(question);
  const selfQuestion = /\b(my|mine)\b/i.test(question);
  const scored = chunks.map((chunk) => {
      const body = terms(chunk.content);
      const title = terms(chunk.heading);
      const titleCommands = commands(chunk.heading);
      const bodyCommands = commands(chunk.content);
      let score = 0;
      let matchingTerms = 0;
      for (const token of queryTerms) {
        if (body.has(token)) score += 2;
        if (title.has(token)) score += 5;
        if (body.has(token) || title.has(token)) matchingTerms++;
      }
      for (const command of queryCommands) {
        if (titleCommands.has(command)) score += 14;
        else if (bodyCommands.has(command)) score += 8;
      }
      // When people ask about "my" archived stats, prefer the documented
      // server-bound self tool over generic historical comparisons.
      if (selfQuestion && chunk.heading.startsWith("get_my_")) score += 7;
      return { chunk, score, matchingTerms };
    })
    .filter(
      ({ score, matchingTerms }) =>
        score >= 5 &&
        (queryTerms.size === 1 || matchingTerms >= 2 || score >= 14)
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        // When relevance ties, ordinary player guidance comes first unless
        // the question itself is better matched by an organiser guide.
        (a.chunk.scope === b.chunk.scope
          ? 0
          : a.chunk.scope === "player"
            ? -1
            : 1) ||
        a.chunk.source.localeCompare(b.chunk.source) ||
        a.chunk.startLine - b.chunk.startLine
    );
  const result: KnowledgeChunk[] = [];
  const seen = new Set<string>();
  const headings = new Map<string, number>();
  for (const { chunk } of scored) {
    const fingerprint = chunk.content.toLowerCase().replace(/\s+/g, " ").trim();
    const section = `${chunk.source}#${chunk.heading}`;
    if (seen.has(fingerprint) || (headings.get(section) ?? 0) >= 2) continue;
    seen.add(fingerprint);
    headings.set(section, (headings.get(section) ?? 0) + 1);
    result.push(chunk);
    if (result.length === Math.min(limit, 4)) break;
  }
  return result;
}
