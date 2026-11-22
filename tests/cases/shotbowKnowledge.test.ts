import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import {
  APPROVED,
  asksAboutFwTournament,
  asksAboutShotbow,
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";

const knowledge = buildApprovedKnowledge(process.cwd());
const shotbowSources = APPROVED.filter((source) => source.topic === "shotbow");

test("Shotbow articles are explicitly allowlisted, bounded and fully chunked", () => {
  assert(
    shotbowSources.length === 6,
    "Six small public reference guides approved"
  );
  for (const source of shotbowSources) {
    const chunks = knowledge.filter((chunk) => chunk.source === source.path);
    assert(
      source.scope === "player" && chunks.length >= source.headings.length,
      "The public wiki guides must be available to both audiences"
    );
    for (const heading of source.headings)
      assert(
        chunks.some((chunk) => chunk.heading === heading),
        `Missing reviewed Shotbow section: ${source.path}#${heading}`
      );
    assert(
      chunks.every(
        (chunk) => chunk.topic === "shotbow" && chunk.content.length <= 1400
      ),
      "Each public-game excerpt is limited and tagged"
    );
    assert(
      source.headings.every((heading) =>
        chunks.some(
          (chunk) =>
            chunk.heading === heading &&
            /https:\/\/(?:wiki\.shotbow\.net|(?:www\.)?shotbow\.net|(?:www\.)?youtube\.com)/.test(
              chunk.content
            )
        )
      ),
      "Every approved section has an official or creator source link"
    );
  }
});

test("Ordinary FW and chat questions never include Shotbow reference paragraphs", () => {
  for (const question of [
    "How do I register for the next FW match?",
    "What commands are there?",
    "What is the currently selected map for our game?",
    "Fun facts about FW",
    "Who is winning our game?",
    "Tell me a joke about cats",
    "When is the next FW clan tournament?",
  ]) {
    assert(
      !asksAboutShotbow(question),
      `Unrelated question misclassified: ${question}`
    );
    assert(
      retrieveApprovedKnowledge(knowledge, question, false).every(
        (chunk) => chunk.topic !== "shotbow"
      ),
      `Leaked unrelated public-server context: ${question}`
    );
  }
});

test("Specific Shotbow, Annihilation, class, map and patch questions retrieve the right reference", () => {
  for (const [question, expectedHeading] of [
    [
      "When was Shotbow founded and what was its first game?",
      "Shotbow founding and first games",
    ],
    [
      "Which YouTubers played MineZ back in the day?",
      "Fun facts and well-known creators",
    ],
    [
      "How do the five Annihilation phases work?",
      "Annihilation phases and resource timing",
    ],
    [
      "Name all the Annihilation classes",
      "Annihilation class roster and unlocks",
    ],
    ["What does the Scout class do?", "Mobility and infiltration classes"],
    [
      "How does the Handyman class work?",
      "Mining, building and utility classes",
    ],
    [
      "What maps are in the Annihilation rotation?",
      "Annihilation map pool and rotation",
    ],
    ["Is Coastal map a classic?", "Classic Annihilation maps and favourites"],
    ["What changed in Polished Platinum?", "Annihilation updates 2026"],
    ["What changed in Rising Radium 4.2.0?", "Annihilation updates 2025"],
    ["When was Annihilation Duel Mode released?", "Annihilation updates 2024"],
  ] as Array<[string, string]>) {
    assert(
      asksAboutShotbow(question),
      `Missed explicit Shotbow topic: ${question}`
    );
    const retrieved = retrieveApprovedKnowledge(knowledge, question, false);
    assert(
      retrieved.some((chunk) => chunk.heading === expectedHeading),
      `No relevant Shotbow evidence for ${question}: ${retrieved.map((chunk) => chunk.heading).join(", ")}`
    );
    assert(
      retrieved.length <= 4,
      "Existing prompt excerpt budget remains bounded"
    );
  }
});

test("Annihilation clan tournament questions retrieve dated winners and documented entrants", () => {
  const cases: Array<[string, string, string]> = [
    [
      "Who won the Shotbow Annihilation clan tournament 2023?",
      "Annihilation tournament champions and runners-up",
      "DDD",
    ],
    [
      "Who won the Annihilation tournament 2024 and who was runner-up?",
      "Annihilation tournament champions and runners-up",
      "NyRq",
    ],
    [
      "Which clans registered for the Annihilation tournament 2026?",
      "Annihilation Tournament 2026: registered clans",
      "AWF",
    ],
    [
      "How did the 2018 Shotbow Annihilation tournament end in 2019?",
      "Annihilation Spring 2018 tournament completed in 2019",
      "26 January 2019",
    ],
    [
      "Who won Team Nexus Annihilation clan tournaments in 2020?",
      "Other Shotbow clan tournaments and missing years",
      "TeamTurkish",
    ],
  ];
  for (const [question, heading, detail] of cases) {
    const chunks = retrieveApprovedKnowledge(knowledge, question, false);
    assert(
      chunks.some(
        (chunk) =>
          chunk.source === "docs/ai/annihilation-tournaments.md" &&
          chunk.heading === heading &&
          chunk.content.includes(detail)
      ),
      `Missing tournament reference: ${question}`
    );
  }
  assert(
    asksAboutShotbow("Who won the 2023 clan tournament?"),
    "Distinctive clan tournament phrasing can request the public history"
  );
  assert(
    !asksAboutShotbow("Who won the FW clan tournament?"),
    "Explicit FW event questions must not load Shotbow reference material"
  );
});

test("2025 Friendly Wars champion and runner-up are documented without mixing Shotbow editions", () => {
  const source = APPROVED.find(
    (entry) => entry.path === "docs/ai/friendly-wars-tournaments.md"
  );
  assert(
    source?.scope === "player" &&
      source.topic === "fw-tournament" &&
      source.headings.includes("Friendly Wars 2025 tournament results"),
    "FW community results have a separate reviewed source"
  );
  for (const question of [
    "Who won the 2025 Friendly War tournament?",
    "Was Aura or F3 the runner-up in the FW 2025 tournament?",
    "Who won the 2025 FW tournament?",
  ]) {
    assert(
      asksAboutFwTournament(question),
      `FW question not recognised: ${question}`
    );
    const chunks = retrieveApprovedKnowledge(knowledge, question, false);
    assert(
      chunks.some(
        (chunk) =>
          chunk.source === "docs/ai/friendly-wars-tournaments.md" &&
          chunk.heading === "Friendly Wars 2025 tournament results" &&
          chunk.content.includes("Aura") &&
          chunk.content.includes("F3")
      ),
      `Missing 2025 FW final in knowledge: ${question}`
    );
    assert(
      chunks.every((chunk) => chunk.topic !== "shotbow"),
      "FW-only questions must not receive public Shotbow tournament history"
    );
  }
  for (const question of [
    "Who won Shotbow's 2025 Annihilation clan tournament?",
    "Who won the Shotbow 2026 tournament?",
    "What command starts a Friendly Wars game?",
    "Who is registered for our game?",
  ]) {
    assert(
      !asksAboutFwTournament(question),
      `Unrelated FW history trigger: ${question}`
    );
    assert(
      retrieveApprovedKnowledge(knowledge, question, false).every(
        (chunk) => chunk.topic !== "fw-tournament"
      ),
      `Community results leaked into other contexts: ${question}`
    );
  }
});

test("The model receives Shotbow guides only for a specifically relevant question", async () => {
  const caller = {
    discordUserId: "reader",
    guildId: "test-guild",
    verifyMembership: async () => ({ member: true, organiser: false }),
  };
  for (const [question, expected] of [
    ["When was Shotbow founded?", true],
    ["How do I register?", false],
  ] as Array<[string, boolean]>) {
    const result = await answerAiQuestion({
      question,
      organiser: false,
      caller,
      knowledge,
      infer: async (messages) => {
        const evidence = messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n");
        assert(
          evidence.includes("docs/ai/shotbow-history.md") === expected,
          "Topical public-server context must not be sent for routine FW help"
        );
        return { content: "A short response", calls: [] };
      },
    });
    assert(
      result.sources.some((source) => source.includes("shotbow-history.md")) ===
        expected,
      "Only sources actually sent should be attributed"
    );
  }
});
