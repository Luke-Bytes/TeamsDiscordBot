import { MatchCleanupState } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { prismaClient } from "../database/prismaClient";

/** Exact-match, bounded read using the bot-owned game ID. Never use model-provided filters. */
export async function getGamePersistenceDiagnostics() {
  const game = CurrentGameManager.getCurrentGame();
  const token = game.getLifecycleToken();
  const id = game.gameId;
  if (!id)
    return {
      status: "unverified",
      source: "persisted database",
      reason: "No current match identity remains in process memory",
      warning: "This does not establish whether an earlier match was saved.",
    };
  try {
    const record = await prismaClient.game.findUnique({
      where: { id },
      select: {
        finished: true,
        cleanupState: true,
        cleanupCompletedAt: true,
        persistenceFingerprint: true,
      },
    });
    if (game.getLifecycleToken() !== token || game.gameId !== id)
      return {
        status: "unverified",
        reason: "Game changed during database read",
      };
    if (!record)
      return {
        status: "not_found",
        source: "persisted database",
        match: "current match identity",
        warning:
          "No record was found at observation time; a commit may still be in flight or uncertain. Never blindly retry shutdown.",
      };
    return {
      status: "ok",
      source: "persisted database lookup",
      match: "current match identity",
      savedResult:
        record.finished === true && Boolean(record.persistenceFingerprint),
      finishedFlag: record.finished,
      cleanupCheckpoint:
        record.cleanupState === MatchCleanupState.COMPLETE
          ? "COMPLETE"
          : record.cleanupState === MatchCleanupState.PENDING
            ? "PENDING"
            : "unrecorded",
      cleanupCompletedAt: record.cleanupCompletedAt?.toISOString() ?? null,
      warning:
        "A saved result and COMPLETE checkpoint are database facts, not proof every Discord role, voice move or message was cleaned. PENDING or mismatched records require operator reconciliation; do not retry shutdown.",
    };
  } catch {
    return {
      status: "unavailable",
      source: "persisted database",
      warning:
        "Database verification failed or timed out; do not retry shutdown until persistence is reconciled.",
    };
  }
}
