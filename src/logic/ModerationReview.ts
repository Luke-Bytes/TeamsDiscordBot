import { EmbedBuilder } from "discord.js";
import {
  EventSignup,
  GameParticipation,
  Player,
  PlayerPunishment,
} from "@prisma/client";
import { MojangAPI } from "../api/MojangAPI";
import { escapeText } from "../util/Utils";
import {
  AccountDiagnostics,
  formatAccountDiagnostics,
} from "./ModerationIssues";

type PlayerIdentity = Pick<
  Player,
  | "discordSnowflake"
  | "latestIGN"
  | "minecraftAccounts"
  | "primaryMinecraftAccount"
  | "createdAt"
>;
type PunishmentHistory = Pick<
  PlayerPunishment,
  "reasons" | "punishmentDates" | "punishmentExpiry" | "strikeCount"
>;
type SignupIdentity = Pick<
  EventSignup,
  "discordUserId" | "minecraftUUID" | "minecraftUsername"
>;
type GameIdentity = Pick<GameParticipation, "ignUsed">;
type LinkedIdentity = Pick<Player, "discordSnowflake">;

export function observedMinecraftUUIDs(
  player: PlayerIdentity,
  signups: SignupIdentity[]
): string[] {
  return [
    ...new Set(
      [player.primaryMinecraftAccount, ...signups.map((s) => s.minecraftUUID)]
        .filter(MojangAPI.validUUID)
        .map((uuid) => uuid.toLowerCase())
    ),
  ];
}

function limitedField(text: string): string {
  return text.length > 1024 ? `${text.slice(0, 1018)}…` : text || "None";
}

function stamp(date: Date | null | undefined): string {
  if (!date || !Number.isFinite(date.getTime())) return "Date unknown";
  return `<t:${Math.floor(date.getTime() / 1000)}:d>`;
}

export function buildModerationReview(
  player: PlayerIdentity,
  punishments: PunishmentHistory[],
  games: GameIdentity[],
  signups: SignupIdentity[],
  overlappingPlayers: LinkedIdentity[],
  overlappingSignups: SignupIdentity[],
  diagnostics: AccountDiagnostics = {
    issues: [],
    liveCheck: "Not checked.",
  },
  now: Date = new Date()
): EmbedBuilder {
  const uuids = observedMinecraftUUIDs(player, signups);
  const recordedNames = [
    ...new Map(
      [
        player.latestIGN,
        ...player.minecraftAccounts,
        ...games.map((g) => g.ignUsed),
        ...signups.map((s) => s.minecraftUsername),
      ]
        .filter(
          (name): name is string =>
            typeof name === "string" && MojangAPI.validateUsername(name)
        )
        .map((name) => [name.toLowerCase(), name] as const)
    ).values(),
  ];
  const namePreview = recordedNames
    .slice(0, 15)
    .map((name) => escapeText(name))
    .join(", ");
  const totalEntries = punishments.reduce(
    (sum, p) => sum + p.reasons.length,
    0
  );
  const active = punishments
    .map((p) => p.punishmentExpiry)
    .filter(
      (expiry): expiry is Date => !!expiry && expiry.getTime() > now.getTime()
    )
    .sort((a, b) => b.getTime() - a.getTime());

  const entries = punishments
    .flatMap((p) =>
      p.reasons.map((reason, index) => ({
        reason: reason.replace(/[\r\n]+/g, " "),
        date: p.punishmentDates[index] ?? null,
      }))
    )
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  const recent = entries.slice(0, 7).map((entry) => {
    const reason = escapeText(entry.reason.slice(0, 110));
    return `• ${stamp(entry.date)} — ${reason}`;
  });

  const overlaps = new Map<string, Set<string>>();
  for (const other of overlappingPlayers) {
    if (other.discordSnowflake === player.discordSnowflake) continue;
    const sources = overlaps.get(other.discordSnowflake) ?? new Set<string>();
    sources.add("player link");
    overlaps.set(other.discordSnowflake, sources);
  }
  for (const other of overlappingSignups) {
    if (other.discordUserId === player.discordSnowflake) continue;
    const sources = overlaps.get(other.discordUserId) ?? new Set<string>();
    sources.add("event signup");
    overlaps.set(other.discordUserId, sources);
  }
  const overlapLines = [...overlaps.entries()]
    .slice(0, 8)
    .map(
      ([id, sources]) => `• \`${escapeText(id)}\` (${[...sources].join(", ")})`
    );

  return new EmbedBuilder()
    .setTitle(
      `Moderation review: ${(player.latestIGN ?? player.discordSnowflake).slice(0, 80)}`
    )
    .setDescription(
      "Organiser-only, read-only review. Account overlap is a lead for manual review, not proof of an alt."
    )
    .addFields(
      {
        name: "Identity",
        value: limitedField(
          `Discord ID: \`${escapeText(player.discordSnowflake)}\`\n` +
            `Current IGN: ${player.latestIGN ? escapeText(player.latestIGN) : "Unknown"}\n` +
            `Primary Minecraft UUID: ${MojangAPI.validUUID(player.primaryMinecraftAccount) ? `\`${player.primaryMinecraftAccount}\`` : "Not verified/recorded"}\n` +
            `Player record created: ${stamp(player.createdAt)}`
        ),
      },
      {
        name: "Account consistency",
        value: limitedField(formatAccountDiagnostics(diagnostics)),
      },
      {
        name: "Punishments",
        value: limitedField(
          `${totalEntries} recorded entr${totalEntries === 1 ? "y" : "ies"}; ${punishments.reduce((n, p) => n + p.strikeCount, 0)} stored strikes.\n` +
            `Active expiry: ${active.length ? stamp(active[0]) : "None recorded"}` +
            (recent.length
              ? `\n${recent.join("\n")}`
              : "\nNo punishment history found.") +
            (entries.length > recent.length
              ? `\n…and ${entries.length - recent.length} earlier entries.`
              : "")
        ),
      },
      {
        name: "Recorded Minecraft names",
        value: limitedField(
          `${recordedNames.length} distinct IGN${recordedNames.length === 1 ? "" : "s"} from player, game and event records.\n` +
            (namePreview || "No names recorded.") +
            (recordedNames.length > 15
              ? ` …and ${recordedNames.length - 15} more.`
              : "") +
            "\nNames do not establish separate Minecraft accounts or the number of name changes."
        ),
      },
      {
        name: "Minecraft account changes",
        value: limitedField(
          `${uuids.length} distinct valid UUID${uuids.length === 1 ? "" : "s"} observed (current link and this server's event signups).\n` +
            (uuids.length > 1
              ? `${uuids.length - 1} other account identit${uuids.length === 2 ? "y" : "ies"} observed in the record. `
              : "") +
            "Exact switch count unknown; no complete UUID-change audit exists."
        ),
      },
      {
        name: "Possible alt-account overlap",
        value: limitedField(
          overlapLines.length
            ? `Same Minecraft UUID appears under ${overlaps.size} other Discord ID${overlaps.size === 1 ? "" : "s"}:\n${overlapLines.join("\n")}${overlaps.size > 8 ? "\n…more omitted." : ""}\nReview manually; shared use or a moved account can also explain this.`
            : "No shared UUID found under another Discord ID in the checked player links or this server's event signups. Alt status remains unknown."
        ),
      }
    )
    .setFooter({
      text: "Recorded names are not verified Mojang name history. Absence of overlap does not rule out alts.",
    });
}
