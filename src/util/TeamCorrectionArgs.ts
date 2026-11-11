import { Team } from "@prisma/client";
import type {
  CorrectionOptions,
  TeamMove,
} from "../database/LastGameTeamCorrection";

/** Pure CLI parsing, so invalid requests can be tested without executing a script. */
export function parseTeamCorrectionArgs(args: string[]) {
  const moves: TeamMove[] = [];
  const options: CorrectionOptions = { removePlayers: [], addPlayers: [] };
  const seen = new Set<string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (
      ![
        "--move",
        "--add",
        "--remove",
        "--season",
        "--double-elo",
        "--apply",
      ].includes(flag)
    ) {
      throw new Error(`Unknown option ${flag}.`);
    }
    if (
      flag !== "--move" &&
      flag !== "--add" &&
      flag !== "--remove" &&
      seen.has(flag)
    ) {
      throw new Error(`Option ${flag} specified more than once.`);
    }
    seen.add(flag);
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    const value = args[++i]?.trim();
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}.`);
    if (flag === "--move" || flag === "--add") {
      const match = /^([^=]+)=(RED|BLUE)$/i.exec(value);
      if (!match || !match[1].trim())
        throw new Error(
          `Use ${flag} PlayerName=RED or ${flag} PlayerName=BLUE.`
        );
      (flag === "--add" ? options.addPlayers! : moves).push({
        identifier: match[1].trim(),
        team: match[2].toUpperCase() as Team,
      });
    } else if (flag === "--remove") {
      options.removePlayers!.push(value);
    } else if (flag === "--season") {
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
        throw new Error("Season must be a positive safe integer.");
      }
      options.seasonNumber = number;
    } else if (flag === "--double-elo") {
      if (value !== "yes" && value !== "no")
        throw new Error("Use --double-elo yes|no.");
      options.legacyDoubleElo = value === "yes";
    }
  }
  if (
    !moves.length &&
    !options.removePlayers!.length &&
    !options.addPlayers!.length
  ) {
    throw new Error(
      "Specify at least one --move Player=TEAM or --add Player=TEAM or --remove Player."
    );
  }
  return { moves, options, apply };
}
