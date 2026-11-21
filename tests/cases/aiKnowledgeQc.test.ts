import { createHash } from "crypto";
import { lstatSync, readFileSync } from "fs";
import { resolve } from "path";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  APPROVED,
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";
import { AI_TOOLS, permittedAiTools } from "../../src/ai/AiTools";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import { CommandHandler } from "../../src/commands/CommandHandler";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type Question = {
  question: string;
  audience: "player" | "organiser";
  source: string;
  heading: string;
  tool?: string;
  needsLiveData?: boolean;
};

// These are retrieval and tool-availability probes, NOT assertions about hosted
// LLM answer accuracy. A live-data question has no proven factual answer until
// its read-only tool actually succeeds with current data.
const questions: Question[] = [
  {
    question: "How do I register for the next game?",
    audience: "player",
    source: "player-actions",
    heading: "How do I join the next game?",
  },
  {
    question: "Can I register a different Minecraft account to correct my IGN?",
    audience: "player",
    source: "player-actions",
    heading: "Can I register with a different Minecraft account",
  },
  {
    question: "How can I unregister from a game?",
    audience: "player",
    source: "player-actions",
    heading: "How do I leave a game?",
  },
  {
    question: "Who is registered and which team am I on?",
    audience: "player",
    source: "player-actions",
    heading: "Who is signed up",
  },
  {
    question: "How do I volunteer to captain?",
    audience: "player",
    source: "player-actions",
    heading: "How do I volunteer to captain?",
  },
  {
    question: "How do class bans work for captains?",
    audience: "player",
    source: "player-actions",
    heading: "How do captains ban classes?",
  },
  {
    question: "How can I vote for MVP?",
    audience: "player",
    source: "player-actions",
    heading: "How do I vote for MVP?",
  },
  {
    question: "Can I forfeit as captain?",
    audience: "player",
    source: "player-actions",
    heading: "Can a captain forfeit?",
  },
  {
    question: "How do I request a replacement with /need?",
    audience: "player",
    source: "player-actions",
    heading: "Our team needs a replacement:",
  },
  {
    question: "How do I ask to spectate a leader's voice channel?",
    audience: "player",
    source: "player-actions",
    heading: "How do I ask to spectate",
  },
  {
    question: "How do I sign up for a tournament event?",
    audience: "player",
    source: "player-community",
    heading: "How do I apply for a tournament",
  },
  {
    question: "Am I confirmed or on the reserve list for an event?",
    audience: "player",
    source: "player-community",
    heading: "Am I confirmed",
  },
  {
    question: "How can I edit or withdraw my event sign-up?",
    audience: "player",
    source: "player-community",
    heading: "How do I view, edit or withdraw",
  },
  {
    question: "How do I view someone's profile?",
    audience: "player",
    source: "player-community",
    heading: "How do I see someone's profile?",
  },
  {
    question: "How do I create my player profile?",
    audience: "player",
    source: "player-community",
    heading: "How do I create or edit my player profile?",
  },
  {
    question: "How do I create my own temporary voice channel?",
    audience: "player",
    source: "player-community",
    heading: "How do I create my own temporary voice channel?",
  },
  {
    question: "How do I lock my temporary VC and invite people?",
    audience: "player",
    source: "player-community",
    heading: "How do I lock, invite or remove",
  },
  {
    question: "What does /wrapped show for an old season?",
    audience: "player",
    source: "player-community",
    heading: "Can I get a personal end-of-season recap?",
  },
  {
    question: "How do I use /stats to view my win rate?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "/stats: player record",
  },
  {
    question: "Why is a Relaxed leaderboard not ordered by Elo?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "/leaderboards: Ranked rating",
  },
  {
    question: "How many finished games does /season view show?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "/season view: seasonal participation",
  },
  {
    question: "Why didn't my statistics update after /game end?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "Why statistics might not update yet",
  },
  {
    question: "How does double Elo affect bonuses?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "Elo bonuses and double-Elo matches",
  },
  {
    question: "Why does my historical Elo start above 1000?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "What historical Elo observations prove",
  },
  {
    question:
      "What happens when historical results are not_found or unavailable?",
    audience: "player",
    source: "player-stats-and-history",
    heading: "Reading unavailable, missing",
  },
  {
    question: "Can /ask tell me whether a game has started?",
    audience: "player",
    source: "player-ai-tools",
    heading: "get_current_game_state",
    tool: "get_current_game_state",
    needsLiveData: true,
  },
  {
    question: "Who won the last three finished games?",
    audience: "player",
    source: "player-ai-tools",
    heading: "get_recent_games",
    tool: "get_recent_games",
    needsLiveData: true,
  },
  {
    question: "What were my REST_API historical wins in season 8?",
    audience: "player",
    source: "player-ai-tools",
    heading: "get_my_historical_stats",
    tool: "get_my_historical_stats",
    needsLiveData: true,
  },
  {
    question: "What is my historical Elo in Ranked season 8?",
    audience: "player",
    source: "player-ai-tools",
    heading: "get_my_historical_elo",
    tool: "get_my_historical_elo",
    needsLiveData: true,
  },
  {
    question: "How do I announce a match using /announce start?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Announce a match:",
  },
  {
    question: "Which /team generate methods exist?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Team generation: registered choices",
  },
  {
    question: "What must be ready for draft team generation?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Team generation prerequisites",
  },
  {
    question: "How do I select captains using /captain randomise?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Captains:",
  },
  {
    question: "How do I correct a roster using /player?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Roster corrections:",
  },
  {
    question: "How do I end gameplay without saving the match?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Ending gameplay:",
  },
  {
    question: "How do I set the winner using /winner set?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Recording a winner:",
  },
  {
    question: "What does /game shutdown require before saving?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "Shutting down:",
  },
  {
    question: "Why is recovery blocked after a stuck game?",
    audience: "organiser",
    source: "organiser-guide",
    heading: "Understanding game lifecycle states",
  },
  {
    question: "How do I create a standalone event draft?",
    audience: "organiser",
    source: "organiser-events-and-admin",
    heading: "Event drafting:",
  },
  {
    question: "How can I correct a player's linked Minecraft account?",
    audience: "organiser",
    source: "organiser-events-and-admin",
    heading: "Minecraft account corrections:",
  },
  {
    question: "How do I close an event without stopping reserves?",
    audience: "organiser",
    source: "organiser-events-and-admin",
    heading: "Closing, reopening and finishing",
  },
  {
    question: "Why did event participant roles not sync?",
    audience: "organiser",
    source: "organiser-events-and-admin",
    heading: "Event role sync",
  },
  {
    question: "When does rollover happen after the first scheduled date?",
    audience: "organiser",
    source: "organiser-game-ops",
    heading: "First scheduled rollover",
  },
  {
    question: "What can organiser get_current_game_state verify now?",
    audience: "organiser",
    source: "organiser-ai-tools",
    heading: "get_current_game_state",
    tool: "get_current_game_state",
    needsLiveData: true,
  },
  {
    question: "How many season announcements are pending now?",
    audience: "organiser",
    source: "organiser-ai-tools",
    heading: "get_organiser_status",
    tool: "get_organiser_status",
    needsLiveData: true,
  },
  {
    question: "How can I tell whether a historical match count is complete?",
    audience: "organiser",
    source: "player-ai-tools",
    heading: "get_historical_season_summary",
  },
];

test("Approved AI Markdown files and exact headings exist, are small and non-symlinked", () => {
  const paths = new Set<string>();
  const chunks = buildApprovedKnowledge(root);
  for (const source of APPROVED) {
    assert(!paths.has(source.path), `Duplicate approved path ${source.path}`);
    paths.add(source.path);
    const fullPath = resolve(root, source.path);
    const stat = lstatSync(fullPath);
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 25000,
      `Unsafe source ${source.path}`
    );
    assert(
      source.path.startsWith("docs/ai/") && !source.path.includes(".."),
      `Source must remain explicitly in docs/ai: ${source.path}`
    );
    const lines = read(source.path).split(/\r?\n/);
    for (const heading of source.headings) {
      assert(
        lines.filter((line) => line === `## ${heading}`).length === 1,
        `Missing or duplicate exact heading: ${source.path}#${heading}`
      );
      assert(
        chunks.some((c) => c.source === source.path && c.heading === heading),
        `Approved heading has no safe complete chunk: ${heading}`
      );
      const start = lines.indexOf(`## ${heading}`);
      let end = start + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      // Every approved paragraph must survive intact, not just one paragraph
      // from a longer section that silently exceeded the size cap.
      const paragraphs = lines
        .slice(start + 1, end)
        .join("\n")
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      assert(
        paragraphs.every(
          (p) =>
            p.length <= 1400 &&
            chunks.some(
              (c) =>
                c.source === source.path &&
                c.heading === heading &&
                c.content === p
            )
        ),
        `Lost or partial approved paragraph: ${source.path}#${heading}`
      );
    }
  }
  for (const chunk of chunks) {
    assert(
      chunk.content.trim().length > 0 && chunk.content.length <= 1400,
      `Empty/oversize chunk: ${chunk.id}`
    );
    const lines = read(chunk.source).split(/\r?\n/);
    assert(
      lines
        .slice(chunk.startLine - 1, chunk.endLine)
        .join("\n")
        .trim() === chunk.content,
      `Incomplete or character-truncated paragraph: ${chunk.id}`
    );
    assert(
      chunk.hash ===
        createHash("sha256").update(chunk.content).digest("hex").slice(0, 12),
      "Citation hash must represent exact content"
    );
    assert(
      APPROVED.some(
        (s) =>
          s.path === chunk.source &&
          s.scope === chunk.scope &&
          s.headings.includes(chunk.heading)
      ),
      "Every chunk must be explicitly approved"
    );
  }
});

test("AI tool schemas are bounded, described, audience gated and identity safe", () => {
  const names = new Set<string>();
  for (const tool of AI_TOOLS) {
    const name = tool.function.name;
    assert(!names.has(name), `Duplicate AI tool ${name}`);
    names.add(name);
    assert(
      tool.function.description.length >= 75,
      `Insufficient tool guidance: ${name}`
    );
    assert(
      /not |no |unknown|unavailable|missing|unsupported|only|rather than/i.test(
        tool.function.description
      ),
      `Tool must state a limit or failure meaning: ${name}`
    );
    const schema = tool.function.parameters as {
      type: string;
      properties: Record<
        string,
        {
          type: string;
          minimum?: number;
          maximum?: number;
          minLength?: number;
          maxLength?: number;
        }
      >;
      required?: string[];
      additionalProperties: boolean;
    };
    assert(
      schema.type === "object" && schema.additionalProperties === false,
      `Tool schema must disallow unknown input: ${name}`
    );
    assert(
      Object.values(schema.properties).every(
        (p) =>
          (p.type === "integer" &&
            p.minimum !== undefined &&
            p.maximum !== undefined) ||
          (p.type === "string" &&
            p.minLength !== undefined &&
            p.maxLength !== undefined)
      ),
      `Unbounded AI input: ${name}`
    );
    assert(
      (schema.required ?? []).every((key) => key in schema.properties),
      `Required property missing in ${name}`
    );
    assert(
      !name.startsWith("get_my_") || !("ign" in schema.properties),
      `MY tool must not accept model-supplied identity: ${name}`
    );
  }
  assert(names.size === 16, "Review the tools inventory when it changes");
  assert(
    !permittedAiTools(false, false).some(
      (t) =>
        ["get_game_diagnostics", "get_organiser_status"].includes(
          t.function.name
        ) ||
        t.function.name.includes("historical_") ||
        t.function.name === "list_historical_seasons"
    ),
    "Player and disabled-history schema visibility must fail closed"
  );
  assert(
    permittedAiTools(false, true).some(
      (t) => t.function.name === "get_my_historical_stats"
    ),
    "History is conditional, not organiser-only"
  );
  assert(
    permittedAiTools(true, false).some(
      (t) => t.function.name === "get_game_diagnostics"
    ),
    "Verified organisers retain legacy diagnostics"
  );
});

test("Registered commands are categorized in a separate coverage manifest", () => {
  const handler = new CommandHandler();
  handler.loadCommands();
  const registered = handler.commands.map((c) => c.data.toJSON().name);
  const content = read("docs/ai/command-coverage.md");
  const entries = [
    ...content.matchAll(
      /^\|\s+`([a-z][a-z0-9-]*)`\s+\|\s+(full|brief|restricted|excluded)\s+\|/gm
    ),
  ];
  const covered = entries.map((entry) => entry[1]);
  assert(
    new Set(registered).size === registered.length,
    "Duplicate registered commands"
  );
  assert(
    new Set(covered).size === covered.length,
    "Duplicate manifest entries"
  );
  assert(
    registered.length === covered.length &&
      registered.every((name) => covered.includes(name)),
    `Unaccounted commands: ${registered.filter((name) => !covered.includes(name)).join(", ")}; stale: ${covered.filter((name) => !registered.includes(name)).join(", ")}`
  );
  assert(
    entries.filter((entry) => entry[2] === "excluded").length > 0 &&
      entries.filter((entry) => entry[2] === "restricted").length > 0,
    "Keep explicit security exclusions"
  );
  const commandShapes = new Map(
    handler.commands.map((c) => [c.data.toJSON().name, c.data.toJSON()])
  );
  // Check all slash roots, even when a writer forgets backticks. Restrict
  // subcommand validation to backtick examples to avoid prose false positives.
  for (const source of APPROVED) {
    const markdown = read(source.path);
    for (const match of markdown.matchAll(
      /(?<![a-zA-Z0-9:])\/([a-z][a-z0-9-]*)\b/g
    )) {
      assert(
        commandShapes.has(match[1]),
        `Obsolete slash command /${match[1]} in ${source.path}`
      );
    }
    for (const match of markdown.matchAll(
      /`\/([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*)(?=\s|`))?[^\n`]*`/g
    )) {
      const rootName = match[1];
      assert(
        commandShapes.has(rootName),
        `Obsolete slash command /${rootName} in ${source.path}`
      );
      const options = (commandShapes.get(rootName) as any).options ?? [];
      const subcommands = options
        .filter((o: any) => o.type === 1 || o.type === 2)
        .map((o: any) => o.name);
      if (subcommands.length && match[2]) {
        assert(
          subcommands.includes(match[2]),
          `Obsolete /${rootName} ${match[2]} in ${source.path}`
        );
      }
    }
  }
});

test("Forty-six role-aware offline question probes retrieve relevant paragraphs", () => {
  assert(questions.length >= 30, "Maintain at least 30 realistic questions");
  const chunks = buildApprovedKnowledge(root);
  for (const item of questions) {
    const organiser = item.audience === "organiser";
    const found = retrieveApprovedKnowledge(chunks, item.question, organiser);
    assert(found.length <= 4, "Context ceiling is unchanged");
    assert(
      found.every((c) =>
        APPROVED.some(
          (source) => source.path === c.source && source.scope === c.scope
        )
      ),
      `Unapproved knowledge in response: ${item.question}`
    );
    const expected = found.find(
      (c) =>
        c.source === `docs/ai/${item.source}.md` &&
        c.heading.includes(item.heading)
    );
    assert(
      Boolean(expected),
      `Relevant evidence crowded out for "${item.question}": ${found.map((c) => c.heading).join(" | ")}`
    );
    assert(
      found.indexOf(expected!) <= 2,
      `Relevant evidence ranked below three competitors: ${item.question}`
    );
    // Top four should not all be duplicate or unrelated material.
    assert(
      new Set(found.map((c) => c.hash)).size === found.length,
      `Duplicate excerpts for ${item.question}`
    );
    if (item.tool) {
      assert(
        permittedAiTools(organiser, true).some(
          (t) => t.function.name === item.tool
        ),
        `Expected read tool not available for ${item.question}`
      );
      assert(
        item.needsLiveData === true,
        "A dynamic tool response is required before asserting current facts"
      );
    } else {
      assert(
        !item.needsLiveData,
        "Document-only probe cannot verify live facts"
      );
    }
  }
});

test("Unrelated general questions may be answered without invented document citations", async () => {
  const chunks = buildApprovedKnowledge(root);
  assert(
    retrieveApprovedKnowledge(
      chunks,
      "quasar nebula gardening hyperdrive",
      false
    ).length === 0,
    "Unrelated queries should not retrieve random matches"
  );
  const result = await answerAiQuestion({
    question: "quasar nebula gardening hyperdrive",
    organiser: false,
    caller: {
      guildId: "offline",
      discordUserId: "caller",
      verifyMembership: async () => ({ member: true, organiser: false }),
    },
    knowledge: chunks,
    infer: async () => ({
      content: "That sounds like a fun science-fiction gardening idea!",
      calls: [],
    }),
  });
  assert(
    result.sources.length === 0 &&
      result.toolNames.length === 0 &&
      result.text.includes("science-fiction gardening"),
    "Ordinary conversation is welcome without falsely citing project documents"
  );
});
