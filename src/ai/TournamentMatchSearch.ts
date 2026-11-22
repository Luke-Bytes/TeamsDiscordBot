import {
  ArchivedMatch,
  TournamentArchive,
  TOURNAMENT_ARCHIVE,
  validateTournamentArchive,
} from "./TournamentArchive";

export type TournamentSearchQuery = {
  text?: string;
  team?: string;
  opponent?: string;
  map?: string;
  tournament?: string;
  stage?: string;
  uploader?: string;
  year?: number;
  fromYear?: number;
  toYear?: number;
  limit?: number;
  offset?: number;
};

const SEARCH_TEXT = [
  "text",
  "team",
  "opponent",
  "map",
  "tournament",
  "stage",
  "uploader",
] as const;
const YEARS = ["year", "fromYear", "toYear"] as const;
const MAPS = [
  "canyon",
  "coastal",
  "andorra",
  "hamlet",
  "skylands",
  "cherokee",
  "villages",
  "aftermath",
  "yggdrasil",
  "willowmere",
  "ironvale",
];

export function validTournamentSearchQuery(
  value: Record<string, unknown>
): boolean {
  if (
    Object.keys(value).some(
      (key) =>
        !([...SEARCH_TEXT, ...YEARS, "limit", "offset"] as string[]).includes(
          key
        )
    )
  )
    return false;
  if (
    SEARCH_TEXT.some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "string" ||
          !value[key] ||
          value[key].length > (key === "text" ? 240 : 64) ||
          Array.from(value[key] as string).some(
            (char) => char.charCodeAt(0) < 32
          ))
    )
  )
    return false;
  if (
    YEARS.some(
      (key) =>
        value[key] !== undefined &&
        (!Number.isInteger(value[key]) ||
          Number(value[key]) < 2010 ||
          Number(value[key]) > 2100)
    )
  )
    return false;
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) ||
      Number(value.limit) < 1 ||
      Number(value.limit) > 6)
  )
    return false;
  if (
    value.offset !== undefined &&
    (!Number.isInteger(value.offset) ||
      Number(value.offset) < 0 ||
      Number(value.offset) > 1000)
  )
    return false;
  if (
    value.fromYear !== undefined &&
    value.toYear !== undefined &&
    Number(value.fromYear) > Number(value.toYear)
  )
    return false;
  return (
    SEARCH_TEXT.some((key) => value[key] !== undefined) ||
    YEARS.some((key) => value[key] !== undefined)
  );
}

function normal(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function contains(text: string, part: string): boolean {
  return Boolean(part && ` ${normal(text)} `.includes(` ${normal(part)} `));
}
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    prev = next;
  }
  return prev[b.length];
}

function labels(name: string, archive: TournamentArchive): string[] {
  const alias = archive.aliases.find(
    (entry) => normal(entry.name) === normal(name)
  );
  return [name, ...(alias?.aliases ?? [])];
}

/** A partial tag is an alternative candidate, never asserted to be the same clan. */
function matchLabel(
  query: string,
  actual: string,
  archive: TournamentArchive
): "exact" | "fuzzy" | "partial" | "none" {
  const q = normal(query);
  const possible = labels(actual, archive).map(normal);
  if (possible.includes(q)) return "exact";
  if (q.length >= 4 && possible.some((p) => distance(q, p) === 1))
    return "fuzzy";
  if (q.length >= 4 && possible.some((p) => p.startsWith(q + " ")))
    return "partial";
  return "none";
}

function mentionedTeams(text: string, archive: TournamentArchive): string[] {
  const names = [
    ...new Set(
      archive.tournaments
        .flatMap((t) => t.participants)
        .concat(archive.matches.flatMap((m) => m.teams))
    ),
  ];
  const choices = names
    .flatMap((name) => labels(name, archive).map((label) => ({ name, label })))
    .sort((a, b) => b.label.length - a.label.length);
  const mentioned: string[] = [];
  let remaining = ` ${normal(text)} `;
  for (const entry of choices) {
    const token = ` ${normal(entry.label)} `;
    if (remaining.includes(token)) {
      remaining = remaining.replace(token, " ".repeat(token.length));
      if (!mentioned.includes(entry.name)) mentioned.push(entry.name);
    }
  }
  // Spelling tolerance for single-word tags (never collapse unknown organisations).
  if (!mentioned.length) {
    for (const word of normal(text).split(" ")) {
      if (word.length < 4) continue;
      const candidate = names.find(
        (name) => matchLabel(word, name, archive) === "fuzzy"
      );
      if (candidate && !mentioned.includes(candidate))
        mentioned.push(candidate);
      if (mentioned.length >= 2) break;
    }
  }
  return mentioned.slice(0, 2);
}

function inferQuery(
  input: TournamentSearchQuery,
  archive: TournamentArchive
): TournamentSearchQuery {
  const text = input.text ?? "";
  const found = mentionedTeams(text, archive);
  const year = /\b(20[12]\d)\b/.exec(text);
  const map = MAPS.find((candidate) => contains(text, candidate));
  const stage = /quarter[ -]?final/i.test(text)
    ? "quarterfinal"
    : /semi[ -]?final/i.test(text)
      ? "semifinal"
      : /\bfinals?\b/i.test(text)
        ? "final"
        : undefined;
  const uploader = /\b(?:pirlo|lpirlo)\b/i.test(text)
    ? "lPirlo"
    : /\b(?:streamed|uploaded|recorded)\s+(?:by\s+)?shotbow\b/i.test(text)
      ? "Shotbow"
      : undefined;
  return {
    ...input,
    team: input.team ?? found[0],
    opponent: input.opponent ?? found[1],
    year: input.year ?? (year ? Number(year[1]) : undefined),
    map: input.map ?? map,
    stage: input.stage ?? stage,
    uploader: input.uploader ?? uploader,
  };
}

function recordingsForMatch(id: string, archive: TournamentArchive) {
  return archive.recordings
    .flatMap((recording) =>
      recording.segments
        .filter((segment) => segment.matchId === id)
        .map((segment) => ({
          id: recording.id,
          title: recording.title,
          channel: recording.channel,
          origin: recording.origin,
          type: recording.type,
          publishedOn: recording.uploadedOn ?? null,
          verification: segment.status,
          url: `https://www.youtube.com/watch?v=${recording.videoId}${segment.startSeconds !== undefined ? `&t=${segment.startSeconds}s` : ""}`,
          segmentStartSeconds: segment.startSeconds ?? null,
          segmentEndSeconds: segment.endSeconds ?? null,
          timestampStatus:
            segment.startSeconds === undefined
              ? "unverified; link opens full recording"
              : "verified segment start",
        }))
    )
    .slice(0, 4);
}

function scoreMatch(
  match: ArchivedMatch,
  archive: TournamentArchive,
  query: TournamentSearchQuery,
  recordings: ReturnType<typeof recordingsForMatch>
) {
  const tournament = archive.tournaments.find(
    (t) => t.id === match.tournamentId
  )!;
  let score = 0;
  const reasons: string[] = [];
  const names = [query.team, query.opponent].filter((v): v is string =>
    Boolean(v)
  );
  const matched = names.map((name) => ({
    name,
    strengths: match.teams.map((team) => matchLabel(name, team, archive)),
  }));
  const exactTeams = matched.filter(({ strengths }) =>
    strengths.includes("exact")
  ).length;
  for (const m of matched) {
    const quality = m.strengths.includes("exact")
      ? "exact"
      : m.strengths.includes("fuzzy")
        ? "fuzzy"
        : m.strengths.includes("partial")
          ? "partial"
          : "none";
    score +=
      quality === "exact"
        ? 12
        : quality === "fuzzy"
          ? 7
          : quality === "partial"
            ? 4
            : -9;
    if (quality === "fuzzy")
      reasons.push(`Approximate clan spelling for ${m.name}; verify the tag`);
    if (quality === "partial")
      reasons.push(
        `Similar tag to ${m.name}, not a verified same organisation`
      );
  }
  const bothTeams =
    names.length === 2 &&
    exactTeams === 2 &&
    match.teams.some(
      (team, first) =>
        matchLabel(names[0], team, archive) === "exact" &&
        match.teams.some(
          (other, second) =>
            first !== second && matchLabel(names[1], other, archive) === "exact"
        )
    );
  if (bothTeams) {
    score += 14;
    reasons.push("Both clans match, in either order");
  } else if (exactTeams) reasons.push("One named clan matches");
  if (query.map) {
    if (!match.map) reasons.push("Map not documented");
    else if (contains(match.map, query.map) || contains(query.map, match.map)) {
      score += 5;
      reasons.push("Recorded map matches");
    } else {
      score -= 3;
      reasons.push(`Recorded map differs: ${match.map}`);
    }
  }
  if (
    query.year !== undefined ||
    query.fromYear !== undefined ||
    query.toYear !== undefined
  ) {
    const inRange =
      tournament.year !== null &&
      (query.year === undefined || tournament.year === query.year) &&
      (query.fromYear === undefined || tournament.year >= query.fromYear) &&
      (query.toYear === undefined || tournament.year <= query.toYear);
    if (inRange) {
      score += 9;
      reasons.push("Tournament year matches");
    } else {
      score -= 5;
      reasons.push("Tournament year differs or unknown");
    }
  }
  if (query.stage) {
    if (match.stage && contains(match.stage, query.stage)) {
      score += 8;
      reasons.push("Stage matches");
    } else score -= match.stage ? 3 : 1;
  }
  if (query.tournament) {
    if (
      contains(tournament.name, query.tournament) ||
      normal(tournament.id) === normal(query.tournament)
    )
      score += 8;
    else score -= 5;
  }
  if (query.uploader) {
    if (
      recordings.some(
        (r) =>
          r.channel &&
          (contains(r.channel, query.uploader!) ||
            (normal(r.channel) === "lpirlo" &&
              normal(query.uploader!) === "pirlo"))
      )
    ) {
      score += 7;
      reasons.push("Uploader matches");
    } else {
      score -= 4;
      reasons.push("No indexed recording from requested uploader");
    }
  }
  if (
    names.length === 0 &&
    !query.year &&
    !query.fromYear &&
    !query.toYear &&
    !query.stage &&
    !query.map &&
    !query.tournament &&
    !query.uploader
  ) {
    const meaningful = normal(query.text ?? "")
      .split(" ")
      .filter((term) => term.length >= 4);
    score +=
      meaningful.filter((term) =>
        contains(
          `${tournament.name} ${match.teams.join(" ")} ${match.stage ?? ""}`,
          term
        )
      ).length * 3;
  }
  if (recordings.length && score > 0) score += 1;
  return { score, reasons, bothTeams };
}

/** No browsing, DB query, Discord read or media download occurs in this search. */
export function searchTournamentMatches(
  input: TournamentSearchQuery,
  archive: TournamentArchive = TOURNAMENT_ARCHIVE
) {
  const empty = {
    matches: [],
    tournaments: [],
    query: null,
    identifiedPairInArchive: false,
    candidateCount: 0,
    truncatedCandidates: false,
    pageOffset: 0,
    nextOffset: null as number | null,
  };
  if (!validTournamentSearchQuery(input as Record<string, unknown>))
    return { status: "invalid_query", ...empty };
  if (validateTournamentArchive(archive).length)
    return { status: "archive_unavailable", ...empty };
  const query = inferQuery(input, archive);
  const ranked = archive.matches
    .map((match) => {
      const recordings = recordingsForMatch(match.id, archive);
      return {
        match,
        recordings,
        ...scoreMatch(match, archive, query, recordings),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.match.id.localeCompare(b.match.id));
  // Don't return map-unknown entries for map-only searches; unknown is not a confirmed hit.
  const pageOffset = input.offset ?? 0;
  const matches = ranked
    .slice(pageOffset, pageOffset + (input.limit ?? 4))
    .map(({ match, recordings, reasons, score, bothTeams }) => {
      const tournament = archive.tournaments.find(
        (t) => t.id === match.tournamentId
      )!;
      return {
        matchId: match.id,
        tournament: tournament.name,
        tournamentId: tournament.id,
        organiser: tournament.organiser,
        year: tournament.year,
        teams: match.teams,
        stage: match.stage ?? null,
        map: match.map ?? null,
        playedOn: match.playedOn ?? null,
        winner: match.winner ?? null,
        score: match.score ?? null,
        verification: match.status,
        sources: match.sources,
        recordings,
        relevance: score,
        bothTeamsMatched: bothTeams,
        reasons,
      };
    });
  const tournamentSummaries = archive.tournaments
    .filter(
      (t) =>
        (query.year !== undefined && t.year === query.year) ||
        (query.tournament &&
          (contains(t.name, query.tournament) ||
            normal(t.id) === normal(query.tournament)))
    )
    .slice(0, 3)
    .map((t) => ({
      id: t.id,
      name: t.name,
      organiser: t.organiser,
      year: t.year,
      coverage: t.coverage,
      placements: t.placements,
      note: t.note ?? null,
      gaps: t.gaps.slice(0, 3),
      sources: t.sources.slice(0, 3),
    }));
  const response = {
    status: matches.length ? "ok" : "no_indexed_matches",
    reviewedOn: archive.reviewedOn,
    catalogScope: "Partial reviewed public archive, not all matches or streams",
    identifiedPairInArchive: Boolean(
      query.team &&
        query.opponent &&
        ranked.some((candidate) => candidate.bothTeams)
    ),
    matchCountIndexed: archive.matches.length,
    pageOffset,
    query: {
      team: query.team ?? null,
      opponent: query.opponent ?? null,
      map: query.map ?? null,
      year: query.year ?? null,
      stage: query.stage ?? null,
      uploader: query.uploader ?? null,
    },
    matches,
    tournaments: tournamentSummaries,
  };
  // Navi enforces a 4 KB tool observation limit. Return useful candidates
  // instead of a result_too_large placeholder, marking partial lists.
  while (response.matches.length > 1 && JSON.stringify(response).length > 3850)
    response.matches.pop();
  return {
    ...response,
    candidateCount: ranked.length,
    truncatedCandidates: pageOffset + response.matches.length < ranked.length,
    nextOffset:
      pageOffset + response.matches.length < ranked.length
        ? pageOffset + response.matches.length
        : null,
  };
}
