import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import {
  AiCaller,
  AiToolDenied,
  executeAiTool,
  permittedAiTools,
} from "../../src/ai/AiTools";
import {
  asksForTournamentMatchArchive,
  autoReadsForAsk,
} from "../../src/ai/AiAutoReads";
import {
  TournamentArchive,
  TOURNAMENT_ARCHIVE,
  validateTournamentArchive,
} from "../../src/ai/TournamentArchive";
import {
  searchTournamentMatches,
  validTournamentSearchQuery,
} from "../../src/ai/TournamentMatchSearch";

function fixture(): TournamentArchive {
  return JSON.parse(JSON.stringify(TOURNAMENT_ARCHIVE)) as TournamentArchive;
}
const caller: AiCaller = {
  guildId: "guild",
  discordUserId: "user",
  verifyMembership: async () => ({ member: true, organiser: false }),
};
const official = (id: string) => ({
  url: `https://www.youtube.com/watch?v=${id}`,
  kind: "official-video-title" as const,
});

test("Approved tournament catalog has safe unique IDs, resolved links and no unverified clip claims", () => {
  assert(
    validateTournamentArchive(TOURNAMENT_ARCHIVE).length === 0,
    "Reviewed local archive must pass integrity checks"
  );
  assert(
    TOURNAMENT_ARCHIVE.tournaments.length >= 8,
    "Distinct 2018, 2020, FW and Shotbow tournament editions"
  );
  assert(
    TOURNAMENT_ARCHIVE.matches.length >= 36,
    "Individually traceable match records"
  );
  assert(
    TOURNAMENT_ARCHIVE.recordings.length >= 33,
    "Video metadata catalog includes the two unverified user seeds"
  );
  assert(
    TOURNAMENT_ARCHIVE.recordings
      .filter((r) => r.origin === "unverified")
      .every((r) => !r.segments.length && r.title === null),
    "Inaccessible seeds have no invented title or match"
  );
  const ids = new Set(TOURNAMENT_ARCHIVE.tournaments.map((t) => t.id));
  assert(
    ids.has("fw-2025") &&
      ids.has("shotbow-2023") &&
      ids.has("shotbow-2024") &&
      ids.has("shotbow-2026") &&
      ids.has("shotbow-spring-2018") &&
      ids.has("team-nexus-mushroom"),
    "Separate organisers, years and unknown dates"
  );
  assert(
    TOURNAMENT_ARCHIVE.tournaments
      .find((t) => t.id === "fw-2025")
      ?.note?.includes("community"),
    "2025 result must keep community attribution"
  );
  assert(
    !TOURNAMENT_ARCHIVE.matches.some((m) => m.tournamentId === "fw-2025"),
    "Champion and runner-up alone do not prove a head-to-head final occurred"
  );
});

test("Tampered archives, relationships, duplicate IDs and unsafe sources fail closed", () => {
  for (const mutate of [
    (a: TournamentArchive) => a.matches.push({ ...a.matches[0] }),
    (a: TournamentArchive) => {
      a.matches[0].tournamentId = "not-real";
    },
    (a: TournamentArchive) => {
      a.recordings.push({ ...a.recordings[0], id: "new-id" });
    },
    (a: TournamentArchive) => {
      a.matches[0].teams = ["DDD", "DDD"];
    },
    (a: TournamentArchive) => {
      a.recordings[0].segments[0].matchId = "not-real";
    },
    (a: TournamentArchive) => {
      a.recordings[0].segments[0].startSeconds = -1;
    },
    (a: TournamentArchive) => {
      a.matches[0].sources[0].url = "file:///etc/passwd";
    },
    (a: TournamentArchive) => {
      a.recordings
        .find((r) => r.origin === "unverified")!
        .segments.push({
          matchId: "s24-final",
          status: "confirmed",
          evidence: "https://www.youtube.com/watch?v=En6xfvoBlSQ",
        });
    },
  ]) {
    const a = fixture();
    mutate(a);
    assert(
      validateTournamentArchive(a).length > 0,
      "Tampered archive rejected"
    );
    assert(
      searchTournamentMatches({ team: "NyRq" }, a).status ===
        "archive_unavailable",
      "Never serve invalid source data"
    );
  }
  assert(
    !validTournamentSearchQuery({
      text: "match",
      url: "https://arbitrary.example",
    }) &&
      !validTournamentSearchQuery({ team: "F3", limit: 1000 }) &&
      !validTournamentSearchQuery({ text: "x".repeat(241) }) &&
      !validTournamentSearchQuery({ fromYear: 2026, toYear: 2024 }),
    "Narrow filters and bounded inputs"
  );
});

test("Seed recordings preserve two games per stream, with no invented timestamps", () => {
  const combined = TOURNAMENT_ARCHIVE.recordings.find(
    (r) => r.videoId === "LT_HJV_3kJ0"
  )!;
  assert(
    combined.segments.length === 2 &&
      new Set(combined.segments.map((s) => s.matchId)).size === 2,
    "Two distinct 2026 fixtures in one upload"
  );
  const result = searchTournamentMatches({ year: 2026, team: "F3" });
  assert(
    result.status === "ok" &&
      result.matches.some((m) => m.matchId === "s26-annl-f3"),
    "Public query finds second fixture within the broadcast"
  );
  const match = result.matches.find((m) => m.matchId === "s26-annl-f3")!;
  assert(
    match.recordings.some(
      (r) =>
        r.url === "https://www.youtube.com/watch?v=LT_HJV_3kJ0" &&
        r.segmentStartSeconds === null
    ),
    "Full-video link until precise segment is independently verified"
  );
});

test("Ranking tolerates approximate memory and does not invent MRK vs F3 on Canyon", () => {
  const question = "Remember that MRK vs F3 game? I think it was on Canyon.";
  const result = searchTournamentMatches({ text: question });
  assert(result.status === "ok", "Return plausible one-team candidates");
  assert(
    result.query?.map?.toLowerCase() === "canyon",
    "Map inferred from user recollection, not asserted as fact"
  );
  assert(
    result.identifiedPairInArchive === false &&
      result.matches.every((m) => !m.bothTeamsMatched),
    "No invented head-to-head"
  );
  assert(
    result.matches.every((m) => m.map === null && m.winner === null),
    "Unknown map/winners remain unknown"
  );
  assert(
    result.matches.some((m) => m.matchId === "s26-annl-f3") &&
      result.matches.some((m) => m.matchId === "s24-qf4"),
    "Find F3 recordings even when map is unsupported"
  );
});

test("Confirmed pair outweighs an incorrect optional map; same-map pair ranks higher when verified", () => {
  const a = fixture();
  a.matches.push({
    id: "fixture-mrk-f3-coastal",
    tournamentId: "shotbow-2024",
    teams: ["F3", "MRK"],
    map: "Coastal",
    stage: "Semifinal",
    status: "partial",
    sources: [official("oMISKDkIYdM")],
  });
  a.recordings.push({
    id: "fixture-mrk-f3-rec",
    videoId: "TSTrec00001",
    title: "Deterministic test-only clip",
    channel: "Shotbow",
    type: "match",
    origin: "official",
    segments: [
      {
        matchId: "fixture-mrk-f3-coastal",
        status: "partial",
        evidence: "https://www.youtube.com/watch?v=oMISKDkIYdM",
      },
    ],
  });
  const q = { text: "Remember that MRK vs F3 game? I think it was on Canyon." };
  let result = searchTournamentMatches(q, a);
  assert(
    result.matches[0].matchId === "fixture-mrk-f3-coastal" &&
      result.matches[0].reasons.some((r) => r.includes("differs")),
    "Two teams outrank one-team Canyon alternatives"
  );
  assert(
    result.identifiedPairInArchive,
    "Pair found regardless of team ordering"
  );
  a.matches.push({
    id: "fixture-mrk-f3-canyon",
    tournamentId: "shotbow-2026",
    teams: ["MRK", "F3"],
    map: "Canyon",
    status: "confirmed",
    sources: [official("LT_HJV_3kJ0")],
  });
  result = searchTournamentMatches(q, a);
  assert(
    result.matches[0].matchId === "fixture-mrk-f3-canyon" &&
      result.matches[0].reasons.some((r) => r === "Recorded map matches"),
    "Verified map breaks pair tie"
  );
});

test("Aliases, case-insensitivity, spelling tolerance and similar-but-distinct tags", () => {
  const final = searchTournamentMatches({
    text: "show 2026 finals ANNL vs AURA",
  });
  assert(
    final.matches[0]?.matchId === "s26-final" &&
      final.matches[0].winner === "Aura",
    "Official alias for DONTCOMEANNI resolves"
  );
  const qf = searchTournamentMatches({
    text: "nYrQ vs f3 in 2024 quarterfinal",
  });
  assert(
    qf.matches[0]?.matchId === "s24-qf4",
    "Case insensitive, two teams order independent"
  );
  const typo = searchTournamentMatches({ team: "NyRq", opponent: "PoiuYt" });
  assert(
    typo.matches[0]?.matchId === "s24-sf1",
    "Unambiguous label case correction"
  );
  const slight = searchTournamentMatches({ team: "Nyrp", opponent: "F3" });
  assert(
    slight.matches[0]?.matchId === "s24-qf4",
    "One-character typo matched conservatively"
  );
  const shortTag = searchTournamentMatches({
    text: "Find the game where NyRq beat Rawr",
  });
  assert(
    shortTag.matches[0]?.matchId === "s24-final" &&
      shortTag.matches[0].reasons.some((r) =>
        r.includes("not a verified same organisation")
      ),
    "Rawr alone not silently equated with Rawr v2"
  );
  assert(
    !TOURNAMENT_ARCHIVE.aliases.some(
      (a) => a.name === "F3" && a.aliases.includes("F3 Entity")
    ),
    "No unverified cross-year clan merge"
  );
});

test("Absent map/date/score, multi-recording games, timestamped links and incomplete evidence", () => {
  const a = fixture();
  const m = a.matches.find((m) => m.id === "s24-qf4")!;
  assert(
    !m.winner && !m.map && !m.playedOn && !m.score,
    "Title alone does not establish winner, map, date or score"
  );
  a.recordings.push({
    id: "fixture-second-perspective",
    videoId: "TSTrec00002",
    title: "Fixture perspective",
    channel: "lPirlo",
    type: "livestream",
    origin: "community",
    segments: [
      {
        matchId: "s24-qf4",
        status: "partial",
        startSeconds: 740,
        endSeconds: 1350,
        evidence: "https://www.youtube.com/watch?v=oMISKDkIYdM",
      },
      {
        matchId: "s24-qf3",
        status: "partial",
        startSeconds: 1390,
        evidence: "https://www.youtube.com/watch?v=oMISKDkIYdM",
      },
    ],
  });
  const result = searchTournamentMatches({ team: "F3", uploader: "Pirlo" }, a);
  const qf = result.matches.find(
    (candidate) => candidate.matchId === "s24-qf4"
  )!;
  assert(
    qf.recordings.length === 2 &&
      qf.recordings.some(
        (r) => r.url.endsWith("&t=740s") && r.segmentEndSeconds === 1350
      ) &&
      qf.recordings.some((r) => r.segmentStartSeconds === null),
    "Multiple perspectives and per-match deep link"
  );
  assert(
    result.matches[0].matchId === "s24-qf4" &&
      qf.reasons.includes("Uploader matches"),
    "Pirlo channel handle matches common uploader name, without inventing match facts"
  );
  const noMap = searchTournamentMatches({ map: "Coastal" });
  assert(
    noMap.status === "no_indexed_matches" && noMap.matches.length === 0,
    "Unknown maps cannot be reported as Coastal"
  );
});

test("2020 Team Nexus four-clan events stay single real fixtures, not six invented pairings", () => {
  const events = TOURNAMENT_ARCHIVE.matches.filter(
    (m) => m.tournamentId === "team-nexus-spring-2020"
  );
  assert(events.length === 9, "Nine recorded results in the organiser's post");
  assert(
    events.every((m) => m.teams.length === 4 && !!m.winner),
    "All original four sides and reported winners survive"
  );
  const hit = searchTournamentMatches({
    team: "Oblivion",
    opponent: "Mizu",
    year: 2020,
  });
  assert(
    hit.matches[0]?.matchId === "tn20-spring-03" &&
      hit.matches[0].bothTeamsMatched &&
      hit.matches[0].teams.length === 4,
    "Search recognises opponents occupying any two positions in one multi-clan event"
  );
  const second = searchTournamentMatches({
    team: "Team Turkish",
    opponent: "LUD",
  });
  assert(
    second.matches[0]?.matchId === "tn20-spring-06",
    "Organiser-attested space variant resolves without claiming unrelated TT aliases"
  );
});

test("The same 2026 quarterfinal has multiple distinct official stream perspectives", () => {
  const target = "s26-qf-annl-sfj";
  const sources = TOURNAMENT_ARCHIVE.recordings.filter((r) =>
    r.segments.some((s) => s.matchId === target)
  );
  assert(
    sources.length === 2 &&
      sources.some((r) => r.videoId === "giZfDpHPY2E") &&
      sources.some((r) => r.videoId === "aPm_WNvS8mQ"),
    "English and Japanese official streams associate to one fixture"
  );
  const result = searchTournamentMatches({
    team: "ANNL",
    opponent: "SFJ",
    year: 2026,
  });
  assert(
    result.matches[0]?.matchId === target &&
      result.matches[0].recordings.length === 2 &&
      result.matches[0].recordings.every((r) => r.segmentStartSeconds === null),
    "No guessed time offsets for either stream"
  );
  for (const id of [
    "jQIIe5rVFUI",
    "SdwPHjJbCsQ",
    "N9TTVzHOQ78",
    "1izlnN61wJo",
  ]) {
    const lead = TOURNAMENT_ARCHIVE.recordings.find((r) => r.videoId === id);
    assert(
      !!lead && lead.segments.length === 0,
      "Real videos lacking proof of all opponents remain unassociated: " + id
    );
  }
});

test("Trusted AnniArchive footage identifies the 2023 YALE–AGENCY quarterfinal", () => {
  const candidate = searchTournamentMatches({
    team: "YALE",
    opponent: "AGENCY",
    year: 2023,
  });
  assert(
    candidate.matches[0]?.matchId === "s23-qf-yale-agency" &&
      candidate.matches[0].bothTeamsMatched &&
      candidate.matches[0].stage === "Quarterfinal",
    "Reviewed footage source supports two opponents and the quarterfinal round"
  );
  assert(
    candidate.matches[0].map === null &&
      candidate.matches[0].winner === null &&
      candidate.matches[0].playedOn === null,
    "Source footage does not imply a result, map or play date"
  );
  const source = TOURNAMENT_ARCHIVE.recordings.find(
    (r) => r.videoId === "1Nu_Db28r5s"
  );
  assert(
    source?.segments.length === 1 &&
      source.segments[0].matchId === "s23-qf-yale-agency" &&
      source.segments[0].startSeconds === undefined,
    "Previously unresolved community upload now correctly associates, without a guessed start time"
  );
});

test("Large catalog paging is stable, bounded and never silently drops matches", () => {
  const a = fixture();
  for (let i = 0; i < 75; i++)
    a.matches.push({
      id: `fixture-extra-${i}`,
      tournamentId: "shotbow-2026",
      teams: ["MRK", `Test Clan ${i}`],
      status: "partial",
      sources: [official("giZfDpHPY2E")],
    });
  assert(
    validateTournamentArchive(a).length === 0,
    "Large safe catalog validates"
  );
  let offset = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const page = searchTournamentMatches({ team: "MRK", limit: 3, offset }, a);
    assert(
      JSON.stringify(page).length <= 4000,
      "Every page fits the existing 4 KB tool-response budget"
    );
    assert(page.status === "ok", "Paging returns results before exhaustion");
    for (const m of page.matches) {
      assert(!seen.has(m.matchId), "No duplicates across page offsets");
      seen.add(m.matchId);
    }
    if (page.nextOffset === null) {
      assert(!page.truncatedCandidates, "No hidden matches remain");
      break;
    }
    assert(page.nextOffset > offset, "Continuation always advances");
    offset = page.nextOffset;
  }
  assert(seen.size >= 75, "Every synthetic fixture is reachable by pagination");
  const laterPage = searchTournamentMatches(
    { team: "MRK", opponent: "Test Clan 1", limit: 1, offset: 5 },
    a
  );
  assert(
    laterPage.identifiedPairInArchive &&
      laterPage.matches.every((m) => m.matchId !== "fixture-extra-1"),
    "An exact known pairing remains identified when pagination hides its result"
  );
  assert(
    !validTournamentSearchQuery({ text: "MRK", offset: 1001 }) &&
      !validTournamentSearchQuery({ text: "MRK", offset: -1 }),
    "Pagination remains bounded"
  );
});

test("Unmatched searches acknowledge catalog incompleteness; 2025 FW result remains community-reported", () => {
  const unknown = searchTournamentMatches({
    team: "NothingClan123",
    opponent: "NotAClan",
  });
  assert(unknown.status === "no_indexed_matches", "Never manufacture matches");
  const fw = searchTournamentMatches({
    year: 2025,
    team: "Aura",
    opponent: "F3",
  });
  assert(
    !fw.matches.some((m) => m.tournamentId === "fw-2025") &&
      fw.tournaments?.some(
        (t) => t.id === "fw-2025" && t.note?.includes("community")
      ),
    "Only placements, not fictional FW match video"
  );
  const yearResults = searchTournamentMatches({ year: 2026 });
  assert(
    yearResults.matches.every((m) => m.tournamentId === "shotbow-2026"),
    "Year filtering favours relevant tournament"
  );
  assert(
    JSON.stringify(yearResults).length <= 4000,
    `The complete year search response fits Navi’s tool-result budget: ${JSON.stringify(yearResults).length}`
  );
  assert(
    searchTournamentMatches({ year: 2024, stage: "Final" }).matches[0]
      .matchId === "s24-final",
    "Final ranked before non-finals"
  );
});

test("Tournament archive is public, member-gated, bounded, and never triggers unrelated live FW questions", async () => {
  assert(
    permittedAiTools(false, false).some(
      (t) => t.function.name === "search_tournament_matches"
    ),
    "Public irrespective of organiser or external historical API"
  );
  const normalQuestions = [
    "How do I register for our FW match?",
    "What is our current map?",
    "Who won the 2025 FW tournament?",
    "Can we start the draft now?",
    "What commands are available?",
  ];
  for (const question of normalQuestions)
    assert(
      !asksForTournamentMatchArchive(question) &&
        !autoReadsForAsk(question, false).some(
          (r) => r.name === "search_tournament_matches"
        ),
      "No historical prefetch for live FW questions: " + question
    );
  for (const question of [
    "Remember that MRK vs F3 game? I think it was on Canyon.",
    "Find the game where NyRq beat Rawr.",
    "Who streamed the semifinals?",
    "Which matches were played on Coastal?",
  ])
    assert(
      asksForTournamentMatchArchive(question),
      "Historical match request detected: " + question
    );
  const result = await executeAiTool(
    "search_tournament_matches",
    '{"text":"2024 NyRq vs F3"}',
    caller
  );
  assert(
    (result as { status: string }).status === "ok",
    "Normal member can access approved archive"
  );
  for (const payload of [
    '{"text":"x","url":"https://bad.example"}',
    '{"text":"x","limit":500}',
    "{}",
  ])
    try {
      await executeAiTool("search_tournament_matches", payload, caller);
      assert(false, "Unexpected allowance for invalid query");
    } catch (error) {
      assert(
        error instanceof AiToolDenied,
        "Reject invalid inputs before access"
      );
    }
  try {
    await executeAiTool("search_tournament_matches", '{"text":"F3"}', {
      ...caller,
      verifyMembership: async () => ({ member: false, organiser: false }),
    });
    assert(false, "Revoked caller must not read");
  } catch (error) {
    assert(error instanceof AiToolDenied, "Fresh membership required");
  }
});

test("Navi preloads archive records for historical games without dumping catalog into unrelated prompts", async () => {
  const original = prismaClient.player.findUnique;
  try {
    (prismaClient.player as any).findUnique = async () => null;
    let lookedUp = false;
    const response = await answerAiQuestion({
      question: "Remember that MRK vs F3 game? I think it was on Canyon.",
      caller,
      organiser: false,
      knowledge: [],
      infer: async (messages) => {
        const evidence = messages.map((m) => m.content ?? "").join(" ");
        lookedUp =
          evidence.includes("s24-qf4") &&
          evidence.includes("Partial reviewed public archive");
        assert(
          !evidence.includes('"videoId":"icpcNFnAbsU"'),
          "Only small ranked records, no complete catalog"
        );
        return {
          content: "I found some possible games, but not that precise pairing.",
          calls: [],
        };
      },
    });
    assert(
      lookedUp && response.toolNames.includes("search_tournament_matches"),
      "Server-side bounded prefetch accessible to /ask and shared mention path"
    );
    await answerAiQuestion({
      question: "How do I register for our FW match?",
      caller,
      organiser: false,
      knowledge: [],
      infer: async (messages) => {
        assert(
          !messages
            .map((m) => m.content ?? "")
            .join(" ")
            .includes("s24-qf4"),
          "No tournament archive in routine FW prompt"
        );
        return { content: "Use /register.", calls: [] };
      },
    });
  } finally {
    prismaClient.player.findUnique = original;
  }
});
