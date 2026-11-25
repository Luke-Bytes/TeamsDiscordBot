import { Player, PlayerPunishment, EventSignup } from "@prisma/client";
import { MinecraftNameLookup, MojangAPI } from "../api/MojangAPI";

type Identity = Pick<
  Player,
  | "discordSnowflake"
  | "latestIGN"
  | "primaryMinecraftAccount"
  | "minecraftAccounts"
>;
type Punishment = Pick<
  PlayerPunishment,
  "reasons" | "punishmentDates" | "strikeCount"
>;
type ActiveSignup = Pick<EventSignup, "minecraftUUID" | "minecraftUsername">;
type OtherLink = Pick<Player, "discordSnowflake"> &
  Partial<Pick<Player, "primaryMinecraftAccount" | "minecraftAccounts">>;

export type AccountIssue = {
  severity: "action" | "review";
  explanation: string;
};

export type AccountDiagnostics = {
  issues: AccountIssue[];
  liveCheck: string;
};

export function inspectAccountConsistency(
  player: Identity,
  punishments: Punishment[],
  activeSignups: ActiveSignup[],
  otherLinks: OtherLink[],
  duplicateIgnOwners: Pick<Player, "discordSnowflake">[],
  lookup?: MinecraftNameLookup
): AccountDiagnostics {
  const issues: AccountIssue[] = [];
  const report = (severity: AccountIssue["severity"], explanation: string) =>
    issues.push({ severity, explanation });
  const uuid = player.primaryMinecraftAccount?.toLowerCase();
  const validPrimary = MojangAPI.validUUID(uuid);
  const validIGN =
    !!player.latestIGN && MojangAPI.validateUsername(player.latestIGN);

  if (!validPrimary) {
    report(
      "action",
      player.primaryMinecraftAccount
        ? "Stored primary Minecraft link is not a valid UUID; verification and registration may fail."
        : "No primary Minecraft UUID is linked; registration may require a fresh verified IGN."
    );
  }
  if (!validIGN) {
    report(
      "action",
      "Current Minecraft IGN is missing or invalid; identity lookups may fail."
    );
  }
  const malformed = player.minecraftAccounts.filter(
    (entry) => !MojangAPI.validateUsername(entry)
  ).length;
  if (malformed) {
    report(
      "review",
      `${malformed} stored Minecraft name entr${malformed === 1 ? "y is" : "ies are"} malformed (possibly legacy data).`
    );
  }
  if (
    duplicateIgnOwners.some(
      (p) => p.discordSnowflake !== player.discordSnowflake
    )
  ) {
    report(
      "action",
      "Current IGN is assigned to another player record; name-based lookups may select the wrong person."
    );
  }
  if (
    validPrimary &&
    otherLinks.some(
      (p) =>
        p.discordSnowflake !== player.discordSnowflake &&
        p.primaryMinecraftAccount?.toLowerCase() === uuid
    )
  ) {
    report(
      "action",
      "Another player record claims the same primary Minecraft UUID; ownership must be reviewed."
    );
  }
  if (
    validPrimary &&
    otherLinks.some(
      (p) =>
        p.discordSnowflake !== player.discordSnowflake &&
        p.minecraftAccounts?.some((name) => name.toLowerCase() === uuid)
    )
  ) {
    report(
      "review",
      "Primary UUID also appears in another player's stored account names (possible legacy link)."
    );
  }

  const badSignups = activeSignups.filter(
    (signup) => !MojangAPI.validUUID(signup.minecraftUUID)
  ).length;
  if (badSignups) {
    report(
      "action",
      `${badSignups} active event signup${badSignups === 1 ? " has" : "s have"} an invalid Minecraft UUID.`
    );
  }
  if (validPrimary) {
    const mismatched = activeSignups.filter(
      (signup) =>
        MojangAPI.validUUID(signup.minecraftUUID) &&
        signup.minecraftUUID.toLowerCase() !== uuid
    ).length;
    if (mismatched) {
      report(
        "action",
        `${mismatched} active event signup${mismatched === 1 ? " uses" : "s use"} a different UUID from the current player link; identity sync may be out of date.`
      );
    }
    if (validIGN) {
      const staleNames = activeSignups.filter(
        (signup) =>
          signup.minecraftUUID.toLowerCase() === uuid &&
          signup.minecraftUsername.toLowerCase() !==
            player.latestIGN?.toLowerCase()
      ).length;
      if (staleNames) {
        report(
          "review",
          `${staleNames} active event signup${staleNames === 1 ? " has" : "s have"} a different IGN; check for a rename or unsynced display name.`
        );
      }
    }
  }

  if (punishments.length > 1) {
    report(
      "action",
      "Multiple punishment records exist; updates may affect only one record."
    );
  }
  if (
    punishments.some(
      (entry) => entry.reasons.length !== entry.punishmentDates.length
    )
  ) {
    report(
      "action",
      "Punishment reasons and dates have different counts; history may be incomplete."
    );
  }
  if (punishments.some((entry) => entry.strikeCount !== entry.reasons.length)) {
    report(
      "action",
      "Stored punishment strike count does not match the recorded reasons."
    );
  }

  let liveCheck = "Not checked (missing valid current IGN or primary UUID).";
  if (validPrimary && validIGN) {
    if (!lookup || lookup.status === "unavailable") {
      liveCheck = "Minecraft lookup unavailable; no live mismatch conclusion.";
    } else if (lookup.status === "found") {
      if (lookup.uuid.toLowerCase() !== uuid) {
        report(
          "action",
          "Current IGN resolves to a different Minecraft UUID than the stored primary link."
        );
        liveCheck = "Mismatch confirmed by Minecraft username lookup.";
      } else {
        liveCheck = "Current IGN resolves to the stored primary UUID.";
      }
    } else if (lookup.status === "notFound") {
      report(
        "review",
        "Current IGN was not found by the Minecraft identity service; it may have been renamed."
      );
      liveCheck = "Stored IGN not found; current account name unverified.";
    } else {
      liveCheck = "Current IGN could not be verified.";
    }
  }
  return { issues, liveCheck };
}

export function formatAccountDiagnostics(
  diagnostics: AccountDiagnostics
): string {
  const { issues, liveCheck } = diagnostics;
  const action = issues.filter((item) => item.severity === "action").length;
  const review = issues.length - action;
  const heading = issues.length
    ? `${action} attention needed · ${review} to review`
    : "No inconsistencies found in the available records.";
  const lines = issues
    .slice(0, 5)
    .map(
      (item) =>
        `${item.severity === "action" ? "⚠️" : "ℹ️"} ${item.explanation}`
    );
  if (issues.length > 5)
    lines.push(`…${issues.length - 5} more issue(s) omitted.`);
  return [heading, ...lines, `Live check: ${liveCheck}`].join("\n");
}
