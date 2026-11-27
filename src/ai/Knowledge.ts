import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { relative, resolve, sep } from "path";
import { scenarioMetadata } from "../logic/scenarios/ScenarioMetadata";
import { scenarioQuestionHeadings } from "./ScenarioKnowledge";

export type KnowledgeScope = "player" | "organiser";
export type KnowledgeChunk = {
  id: string;
  topic?: "shotbow" | "fw-tournament" | "fw-vocabulary" | "fw-scenario";
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
  topic?: "shotbow" | "fw-tournament" | "fw-vocabulary" | "fw-scenario";
  headings: readonly string[];
};

/**
 * Only reviewed plain-English guides are eligible for the hosted model.
 * Adding more content requires deliberate approval, not a directory scan.
 */
export const APPROVED: readonly ApprovedSource[] = [
  {
    path: "docs/ai/player-scenarios.md",
    scope: "player",
    topic: "fw-scenario",
    headings: [
      "Friendly Wars scenarios - guide, registration and private prompts",
      ...Object.values(scenarioMetadata).map((scenario) => scenario.name),
    ],
  },
  {
    path: "docs/ai/organiser-scenarios.md",
    scope: "organiser",
    topic: "fw-scenario",
    headings: [
      "Announce and prepare a scenario game",
      "Scenario status, reminders and resend prompts",
      "Scenario game start, team selection and Cursed Classes pool",
      "Scenario recovery, manual start, resume and cancel",
      "Scenario privacy and live questions",
    ],
  },
  {
    path: "docs/ai/player-guide.md",
    scope: "player",
    headings: [
      "Getting help with commands",
      "How do I play a Friendly War?",
      "Accurate FW facts and member questions",
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
      "How do I format a game request for Shotbow hosts? `/game request`",
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
      "Can I check Minecraft username history? `/name history`",
      "Is Shotbow online? Server status and player count `/shotbow`",
      "How do I make a Discord timestamp? `/timestamp`",
    ],
  },
  {
    path: "docs/ai/player-stats-and-history.md",
    scope: "player",
    headings: [
      "Lifetime versus seasonal player statistics",
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
      "Caller identity and organiser names",
      "Live slash-command catalog",
      "get_all_time_leaderboard — all saved-season wins",
      "get_player_performance_shortlist — multi-metric draft candidates",
      "get_my_all_time_stats and get_player_all_time_stats — lifetime records",
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
      "Organise a game from start to finish",
      "Announce a match: `/announce start`",
      "Announcement confirmation and edits",
      "Team generation: registered choices",
      "Team generation prerequisites",
      "Team review, reset and cancellation",
      "Captains: `/captain set` and `/captain randomise`",
      "Roster corrections: `/player`",
      "A player leaves after teams are picked",
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
    path: "docs/ai/organiser-troubleshooting.md",
    scope: "organiser",
    headings: [
      "Announcement preview exists but was not published",
      "Registration or signups fail",
      "A registered player cannot be assigned to a team",
      "Wrong game settings were selected",
      "Team generation fails or the preview looks wrong",
      "Draft stuck or captain stops picking",
      "Captain selection fails",
      "Player leaves after teams were picked",
      "Replacement needs to be added",
      "Incorrect Discord team roles before start",
      "Map poll never appears or does not finish",
      "Class bans incomplete or deadline appears stuck",
      "Automatic start or pregame scheduling does not happen",
      "/game start fails",
      "Game remains in starting",
      "Some players moved to voice but others did not",
      "Discord team roles disagree with rosters",
      "Captain or player disconnects during play",
      "Organiser needs a live roster correction",
      "Bot restarts during an announced or active game",
      "Recovered game misses some workflow",
      "Previously scheduled action never resumes",
      "External Discord operation partially succeeds",
      "/game end fails or appears to do nothing",
      "Minecraft match finished but bot is at an earlier stage",
      "MVP voting does not open or finish",
      "Wrong winner selected before confirmation",
      "Winner confirmation fails or times out",
      "/game shutdown fails partway through",
      "Match result may already have been saved",
      "Database persistence succeeds but Discord cleanup fails",
      "Recovery gate prevents further actions",
      "Organiser wants the next game but cleanup is incomplete",
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
      "get_game_roster — current rosters, captains, class bans and draft",
      "get_game_discord_state — targeted external Discord inspection",
      "get_game_persistence — exact current match checkpoint",
      "get_organiser_status — saved season and announcement queue",
      "Recovery, finishing and persistent state",
    ],
  },
  {
    path: "docs/ai/fw-community-terms.md",
    scope: "player",
    topic: "fw-vocabulary",
    headings: [
      "Gap drop and leather scouting — FW memes",
      "Deppies and prot12 — FW gearing memes",
      "TP, rift, suc and 6 HP — FW class shorthand",
      "Organiser, admin and host — community role distinctions",
    ],
  },
  {
    path: "docs/ai/shotbow-history.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Shotbow founding and first games",
      "Fun facts and well-known creators",
      "Public Shotbow knowledge versus Friendly Wars",
    ],
  },
  {
    path: "docs/ai/annihilation-gameplay.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Annihilation objective and teams",
      "Annihilation phases and resource timing",
      "Annihilation economy, bosses and preparation",
      "FW combat calls: rushing, defending and kits",
      "FW map calls: mid and mid blocks",
      "FW economy roles: bunker, farmer, gold miner and gearer",
      "Annihilation advice and version caveats",
    ],
  },
  {
    path: "docs/ai/annihilation-classes.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Annihilation class roster and unlocks",
      "Mobility and infiltration classes",
      "Mining, building and utility classes",
      "Ranged, combat and control classes",
      "Choosing Annihilation classes in a team",
    ],
  },
  {
    path: "docs/ai/annihilation-maps.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Annihilation map pool and rotation",
      "Classic Annihilation maps and favourites",
      "Other Annihilation maps in the catalog",
      "Annihilation duel maps",
      "Seasonal and special event maps",
      "Notable Annihilation map details",
    ],
  },
  {
    path: "docs/ai/annihilation-updates.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Annihilation updates 2026",
      "Annihilation updates 2025",
      "Annihilation updates 2024",
      "Annihilation updates 2023",
      "Annihilation updates 2022",
      "Annihilation updates 2021 and 2020",
      "Earlier Annihilation update milestones",
      "Answering Annihilation changelog questions",
    ],
  },
  {
    path: "docs/ai/annihilation-tournaments.md",
    scope: "player",
    topic: "shotbow",
    headings: [
      "Annihilation tournament champions and runners-up",
      "Annihilation Clan Tournament 2023: entrants and format",
      "Annihilation Clan Tournament 2024: entrants and format",
      "Annihilation Tournament 2026: format and confirmed finalists",
      "Annihilation Tournament 2026: registered clans",
      "Annihilation Spring 2018 tournament completed in 2019",
      "Other Shotbow clan tournaments and missing years",
      "Answering questions about clan tournament records",
    ],
  },
  {
    path: "docs/ai/friendly-wars-tournaments.md",
    scope: "player",
    topic: "fw-tournament",
    headings: [
      "Friendly Wars 2025 tournament results",
      "Friendly Wars tournaments versus Shotbow clan tournaments",
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
    topic: source.topic,
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
    (
      text
        .toLowerCase()
        .replace(/\bprot[\s-]+12\b/g, "prot12")
        .replace(/\b6[\s-]*hp\b/g, "6hp")
        .match(/\b(?:tp|[a-z0-9_]{3,})\b/g) ?? []
    )
      // Preserve identifier matches while also finding words inside tool names
      // such as get_my_historical_stats.
      .flatMap((word) => [word, ...word.split("_")])
      .map((word) =>
        /^(registered|registering|registration|registrations)$/.test(word)
          ? "register"
          : /^(win|wins|loss|losses|streak|streaks)$/.test(word)
            ? "stat"
            : /^(rush|rushing|rushes|rusher|rushers|rushed)$/.test(word)
              ? "rush"
              : /^(defend|defending|defender|defenders|defense|defence|defensive)$/.test(
                    word
                  )
                ? "defend"
                : /^(kits?|classes?)$/.test(word)
                  ? "class"
                  : /^(farmers?|farming)$/.test(word)
                    ? "farmer"
                    : /^(gearers?|gearing)$/.test(word)
                      ? "gearer"
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
    ).map((command) =>
      command
        .replace(/\s+/g, " ")
        .trim()
        // In "use /stats to..." the word "to" is not a subcommand.
        .replace(/\s+(?:to|for|with|on|in|of|and|is|can|does)$/, "")
    )
  );
}

/**
 * Public Shotbow reference is opt-in for questions naming Shotbow, its games,
 * Annihilation terminology, or unmistakable class/map/update names. Ordinary
 * FW questions must not receive these extra paragraphs.
 */
function asksAboutAnnihilationShorthand(question: string): boolean {
  const combat =
    /\b(?:rush(?:ing|ers?|es|ed)?|defend(?:ing|ers?|s|ed)?|defen[sc]e)\b/i.test(
      question
    );
  const combatContext =
    /\b(?:kits?|classes?|nexuses?|annihilation|anni|fw|friendly wars|what(?:'s| is)|means?|best|strategy|role|build|tactics?)\b/i.test(
      question
    );
  const communityRole =
    /\b(?:mid blocks?|gold miners?|gearers?|gapples?)\b/i.test(question) ||
    (/\b(?:bunker|farmer|mid)\b/i.test(question) &&
      /\b(?:fw|annihilation|anni|nexus|apples?|diamonds?|gold|minecraft|class|role|what(?:'s| is)|mean|where|why)\b/i.test(
        question
      ));
  return (combat && combatContext) || communityRole;
}

export function asksAboutShotbow(question: string): boolean {
  // People often ask "Scout or Acrobat?" without saying "Annihilation class".
  // Recognise a class purchase/comparison without opening Shotbow guides for
  // unrelated FW questions about a single generic word such as "scout".
  const classNames = new Set(
    question
      .toLowerCase()
      .match(
        /\b(?:acrobat|scout|transporter|swapper|handyman|immobilizer|scorpio|bloodmage|alchemist|enchanter|rift walker|warrior|miner|pyro|assassin|berserker|farmer|defender|builder|healer)\b/g
      ) ?? []
  );
  const classChoice =
    (classNames.size >= 2 &&
      /\b(?:or|vs\.?|versus|compare|between|better|choose|pick|buy)\b/i.test(
        question
      )) ||
    (classNames.size > 0 && /\b(?:buy|unlock|purchase|rent)\b/i.test(question));
  return (
    classChoice ||
    asksAboutAnnihilationShorthand(question) ||
    /\b(?:shotbow|annihilation|anni|minez|hcfactions|ghostcraft|smash|nexus|nexuses)\b/i.test(
      question
    ) ||
    (!/\b(?:fw|friendly wars)\b/i.test(question) &&
      /\bclan\s+(?:war\s+)?tournaments?\b/i.test(question)) ||
    /\b(?:polished platinum|rising radium|chunky arsenic|weary xenon|ambitious europium|duel mode|crispy cobalt|obvious osmium)\b/i.test(
      question
    ) ||
    /\b(?:5\.1\.0|5\.0\.0|4\.2\.0|4\.1\.0|3\.3\.0)\b/.test(question) ||
    (/\b(?:class|kit|ability|abilities)\b/i.test(question) &&
      /\b(?:acrobat|scout|transporter|swapper|handyman|immobilizer|scorpio|bloodmage|alchemist|enchanter|rift walker|warrior|miner|pyro|assassin|berserker|farmer|defender|builder|healer)\b/i.test(
        question
      )) ||
    (/\b(?:map|rotation)\b/i.test(question) &&
      /\b(?:coastal|andorra|hamlet|skylands|yggdrasil|aftermath|cherokee|villages|willowmere|ironvale|anniZ|duelstal)\b/i.test(
        question
      ))
  );
}

/** User-supplied FW slang is not a source of general Shotbow rules. */
export function asksAboutFwVocabulary(question: string): boolean {
  const specific =
    /\b(?:depp(?:ies|y)|prot[\s-]*12|leather[\s-]*scout(?:ing)?|gap[\s-]*drop(?:ping|ped|s)?|suc(?:c(?:ed|ing)?)?|6[\s-]*hp)\b/i.test(
      question
    );
  const tp =
    /\btp\b/i.test(question) &&
    (/\b(?:fw|annihilation|anni|class|transporter|portal|nexus|what|means?|using|use|rushing)\b/i.test(
      question
    ) ||
      /^tp\??$/i.test(question.trim()));
  const rift =
    /\brift\b/i.test(question) &&
    !/\b(?:tectonic|geology|geological|valley|fantasy novel)\b/i.test(
      question
    ) &&
    (/\b(?:fw|annihilation|anni|class|riftwalker|nexus|what|means?|using|use)\b/i.test(
      question
    ) ||
      /^rift\??$/i.test(question.trim()));
  const fwRole =
    /\b(?:organis(?:ers?|ing|ation)|organiz(?:ers?|ing|ation)|admins?|hosts?|staff)\b/i.test(
      question
    ) &&
    /\b(?:fw|friendly wars|shotbow|annihilation|organis(?:ers?|ing)|organiz(?:ers?|ing)|staff)\b/i.test(
      question
    );
  return specific || tp || rift || fwRole;
}

/** Keep FW community tournament history separate from Shotbow staff events. */
export function asksAboutFwTournament(question: string): boolean {
  return (
    /\b(?:fw|friendly wars?)\b/i.test(question) &&
    (/\b(?:tournaments?|championships?)\b/i.test(question) ||
      (/\b2025\b/.test(question) &&
        /\b(?:aura|f3|winner|won|runner.up|placed|first|second)\b/i.test(
          question
        )))
  );
}

/** A timeless walkthrough does not require a snapshot of anyone's live game. */
export function asksForOrganiserWalkthrough(question: string): boolean {
  const q = question.trim();
  const game = /\b(?:games?|matches?|friendly wars?|fw)\b/i.test(q);
  const organise =
    /\b(?:organis(?:e|ing|er|ation)|organiz(?:e|ing|er|ation)|run(?:ning)?|host(?:ing)?)\b/i.test(
      q
    );
  const requestingGuide =
    /\b(?:start to finish|beginning to end|step[- ]by[- ]step|full (?:guide|process|workflow)|complete (?:guide|process|workflow)|all (?:the )?steps)\b/i.test(
      q
    ) ||
    /^(?:how (?:do|can|should) (?:i|we) |how to |(?:please )?(?:explain|outline|describe|walk (?:me|us) through )|can you walk (?:me|us) through |what are the steps )/i.test(
      q
    );
  // Do not suppress diagnostic tools for an actual match, even when the caller
  // also asks for generic steps or uses "start to finish" in the question.
  const liveProblem =
    /\b(?:my|our|this|current|today|tonight|now|currently|already|still|next|ongoing|stuck|broken|fail(?:ed|ing|ure)?|errors?|timed?\s*out|missing|partial|recovered|registered|announced|in progress)\b/i.test(
      q
    );
  return game && organise && requestingGuide && !liveProblem;
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
  const shotbowQuestion = asksAboutShotbow(question);
  const shotbowStatusQuestion =
    (/\bshotbow\b/i.test(question) &&
      /\b(?:online|offline|down|up|status|reachable|unreachable|player count|how many players)\b/i.test(
        question
      )) ||
    /\b(?:minecraft )?server status\b/i.test(question);
  const fwTournamentQuestion = asksAboutFwTournament(question);
  const fwVocabularyQuestion = asksAboutFwVocabulary(question);
  const scenarioHeadings = scenarioQuestionHeadings(question);
  const tournamentResultsQuestion =
    shotbowQuestion &&
    /\b(?:tournaments?|clans?)\b/i.test(question) &&
    /\b(?:won|winner|champions?|first|second|runner-?up|placed|finished)\b/i.test(
      question
    ) &&
    !/\bteam nexus\b/i.test(question);
  const selfQuestion = /\b(my|mine)\b/i.test(question);
  const organiserWalkthrough = asksForOrganiserWalkthrough(question);
  const tacticalClassQuestion =
    /\b(?:kits?|classes?|builds?)\b/i.test(question) &&
    /\b(?:rush(?:ing|ers?|es|ed)?|defend(?:ing|ers?|s|ed)?|defen[sc]e)\b/i.test(
      question
    );
  const organiserTopic =
    /\b(?:organis(?:er|ers|e|ing|ation)|admin|announce|recover|shutdown|diagnos(?:e|is|tics)|punish(?:ment|ments)?|rollover|draft|captain|moderation|pending|announcements?)\b|\/(?:announce|punish|event|recover-game|game diagnostics)/i.test(
      question
    );
  const scored = chunks
    .filter(
      (chunk) =>
        (chunk.topic !== "shotbow" || shotbowQuestion) &&
        (chunk.topic !== "fw-tournament" || fwTournamentQuestion) &&
        (chunk.topic !== "fw-vocabulary" || fwVocabularyQuestion) &&
        (chunk.topic !== "fw-scenario" || scenarioHeadings.has(chunk.heading))
    )
    .map((chunk) => {
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
        // Exact command headings must outrank generic tool prose mentioning
        // similar terms (e.g. /stats versus all-time stats).
        if (titleCommands.has(command)) score += 35;
        else if (bodyCommands.has(command)) score += 8;
      }
      // Live status questions need the command, not historical wiki excerpts.
      if (
        shotbowStatusQuestion &&
        chunk.heading === "Is Shotbow online? Server status and player count `/shotbow`"
      )
        score += 40;
      // Scenario-specific rules take priority over ordinary draft and registration guides.
      if (chunk.topic === "fw-scenario") score += 40;
      // Public-game excerpts should rank when explicitly requested, but never
      // drown out precise FW command documentation in mixed questions.
      if (shotbowQuestion && chunk.topic === "shotbow" && matchingTerms)
        score += 8;
      if (
        fwTournamentQuestion &&
        chunk.topic === "fw-tournament" &&
        matchingTerms
      )
        score += 8;
      // Exact community slang needs to outrank generic game paragraphs,
      // but should never be injected into unrelated conversations.
      if (
        fwVocabularyQuestion &&
        chunk.topic === "fw-vocabulary" &&
        matchingTerms
      )
        score += 16;
      // Years recur in registration paragraphs. Explicit winners/runner-up
      // questions should lead with the confirmed podium, not sign-up rosters.
      if (
        tournamentResultsQuestion &&
        chunk.heading === "Annihilation tournament champions and runners-up"
      )
        score += 35;
      // Generic end-to-end questions should lead with the complete approved
      // workflow, not unrelated fragments mentioning "game" or "start".
      if (
        organiserWalkthrough &&
        chunk.heading === "Organise a game from start to finish"
      )
        score += 35;
      // "Best kit for rushing" should reach reviewed Annihilation classes,
      // rather than a generic or unrelated meaning of "kit".
      if (
        tacticalClassQuestion &&
        chunk.heading === "Choosing Annihilation classes in a team"
      )
        score += 24;
      // When people ask about "my" archived stats, prefer the documented
      // server-bound self tool over generic historical comparisons.
      if (selfQuestion && chunk.heading.startsWith("get_my_")) score += 7;
      // Ordinary questions should not get swamped by organiser procedure
      // paragraphs now that these reviewed guides are community-readable.
      // Explicit organiser topics still compete by full relevance score.
      if (chunk.scope === "player" && !organiserTopic && score > 0) score += 5;
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
