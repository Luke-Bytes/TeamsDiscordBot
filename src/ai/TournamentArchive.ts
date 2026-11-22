import rawArchive from "./TournamentArchive.json";

/** Fixed, reviewed local source; never accept a model-selected file path or URL. */
export type ArchiveEvidence = {
  url: string;
  kind:
    | "official-video"
    | "official-video-title"
    | "official-video-description"
    | "official-result"
    | "community-report";
};
export type ArchivedMatch = {
  id: string;
  tournamentId: string;
  teams: [string, string];
  stage?: string;
  map?: string;
  playedOn?: string;
  winner?: string;
  score?: string;
  status: "confirmed" | "partial" | "uncertain";
  sources: ArchiveEvidence[];
};
export type ArchiveSegment = {
  matchId: string;
  status: "confirmed" | "partial" | "uncertain";
  evidence: string;
  startSeconds?: number;
  endSeconds?: number;
};
export type ArchivedRecording = {
  id: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  type: string;
  origin: "official" | "community" | "unverified";
  uploadedOn?: string;
  segments: ArchiveSegment[];
};
export type ArchivedTournament = {
  id: string;
  name: string;
  organiser: string;
  year: number | null;
  format?: string;
  participants: string[];
  participantBasis: string;
  placements: Array<{ team: string; position: number }>;
  sources: string[];
  coverage: string;
  gaps: string[];
  note?: string;
};
export type TournamentArchive = {
  reviewedOn: string;
  tournaments: ArchivedTournament[];
  matches: ArchivedMatch[];
  recordings: ArchivedRecording[];
  aliases: Array<{ name: string; aliases: string[]; evidence: string }>;
};

export const TOURNAMENT_ARCHIVE: TournamentArchive =
  rawArchive as TournamentArchive;

const SAFE_SOURCE =
  /^https:\/\/(?:www\.)?(?:shotbow\.net\/forum\/|youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}(?:&t=\d+s)?$)/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Full referential and safety checks; also exercised with tampered fixtures offline. */
export function validateTournamentArchive(
  archive: TournamentArchive
): string[] {
  const errors: string[] = [];
  if (
    archive.tournaments.length > 80 ||
    archive.matches.length > 1200 ||
    archive.recordings.length > 1200 ||
    archive.aliases.length > 250
  )
    errors.push("archive exceeds bounded size");
  const unique = (label: string, values: string[]) => {
    if (new Set(values).size !== values.length)
      errors.push(`duplicate ${label} ID`);
    if (values.some((id) => !/^[a-z0-9-]{3,75}$/.test(id)))
      errors.push(`invalid ${label} ID`);
  };
  unique(
    "tournament",
    archive.tournaments.map((t) => t.id)
  );
  unique(
    "match",
    archive.matches.map((m) => m.id)
  );
  unique(
    "recording",
    archive.recordings.map((r) => r.id)
  );
  const tournaments = new Set(archive.tournaments.map((t) => t.id));
  const matches = new Map(archive.matches.map((m) => [m.id, m]));
  for (const t of archive.tournaments) {
    if (
      t.participants.length > 100 ||
      t.sources.some((s) => !SAFE_SOURCE.test(s))
    )
      errors.push(`invalid tournament sources/size: ${t.id}`);
    if (
      t.placements.some((p) => p.position < 1 || !Number.isInteger(p.position))
    )
      errors.push(`invalid placement: ${t.id}`);
  }
  for (const m of archive.matches) {
    if (
      !tournaments.has(m.tournamentId) ||
      m.teams.length !== 2 ||
      m.teams.some((t) => !t || t.length > 60) ||
      (m.winner && !m.teams.includes(m.winner)) ||
      !m.sources.length ||
      m.sources.length > 8 ||
      m.sources.some((s) => !SAFE_SOURCE.test(s.url))
    )
      errors.push(`invalid match: ${m.id}`);
  }
  for (const r of archive.recordings) {
    if (!VIDEO_ID.test(r.videoId) || r.segments.length > 30)
      errors.push(`invalid recording: ${r.id}`);
    const seen = new Set<string>();
    for (const segment of r.segments) {
      if (
        seen.has(segment.matchId) ||
        !matches.has(segment.matchId) ||
        !SAFE_SOURCE.test(segment.evidence) ||
        (segment.startSeconds !== undefined &&
          (!Number.isInteger(segment.startSeconds) ||
            segment.startSeconds < 0 ||
            segment.startSeconds > 86400)) ||
        (segment.endSeconds !== undefined &&
          (segment.startSeconds === undefined ||
            !Number.isInteger(segment.endSeconds) ||
            segment.endSeconds <= segment.startSeconds ||
            segment.endSeconds > 86400))
      )
        errors.push(`invalid segment: ${r.id}`);
      seen.add(segment.matchId);
    }
    if (r.origin === "unverified" && r.segments.length)
      errors.push(`unverified recording has match claims: ${r.id}`);
  }
  for (const alias of archive.aliases) {
    if (!SAFE_SOURCE.test(alias.evidence) || alias.aliases.length > 12)
      errors.push(`invalid alias: ${alias.name}`);
  }
  return errors;
}
