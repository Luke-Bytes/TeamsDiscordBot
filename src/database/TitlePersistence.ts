import { Prisma } from "@prisma/client";
import { prismaClient } from "./prismaClient";

/** Retry only known aborted transactions / competing unique profile creation. */
export async function runTitleTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prismaClient.$transaction(
        (tx) => work(tx as unknown as Prisma.TransactionClient),
        { maxWait: 10_000, timeout: 60_000 }
      );
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (attempt >= 2 || (code !== "P2034" && code !== "P2002")) throw error;
    }
  }
}

/** Read and modify only the unlocked title field inside the transaction. */
export async function changeUnlockedTitles(
  tx: Prisma.TransactionClient,
  playerId: string,
  add: Iterable<string>,
  remove: Iterable<string> = []
): Promise<{ unlocked: string[]; newlyUnlocked: string[] }> {
  const existing = await tx.profile.findUnique({
    where: { playerId },
    select: { unlockedTitles: true },
  });
  const old = existing?.unlockedTitles ?? [];
  const removed = new Set(remove);
  const unlocked = [...new Set([...old, ...add])].filter(
    (id) => !removed.has(id)
  );
  const newlyUnlocked = unlocked.filter((id) => !old.includes(id));
  if (
    !existing ||
    unlocked.length !== old.length ||
    unlocked.some((id, index) => id !== old[index])
  ) {
    await tx.profile.upsert({
      where: { playerId },
      update: { unlockedTitles: unlocked },
      create: { playerId, unlockedTitles: unlocked },
    });
  }
  return { unlocked, newlyUnlocked };
}
