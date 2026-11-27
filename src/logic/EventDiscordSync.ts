import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { Client } from "discord.js";
import { ConfigManager } from "../ConfigManager";
import { prismaClient } from "../database/prismaClient";
import { eventService } from "./EventService";

const running = new Set<string>();
const started = new WeakSet<Client>();

// Legacy pending records may have either a missing or explicit-null token.
// Every new request replaces the token, independently of timestamp precision.
function pendingVersion(
  field: "roleSyncToken" | "promotionToken",
  token: string | null,
  updatedAt: Date
): Prisma.EventSignupWhereInput {
  if (token != null) return { [field]: token };
  return {
    updatedAt,
    OR: [{ [field]: null }, { [field]: { isSet: false } }],
  };
}

function discordCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/** Retry Discord side effects independently of the committed application. */
export async function syncEventDiscord(client: Client, guildId?: string) {
  const roleId = ConfigManager.getConfig().roles.eventParticipantRole;
  if (!roleId) return;
  const guildIds = guildId ? [guildId] : [...client.guilds.cache.keys()];
  for (const id of guildIds) {
    if (running.has(id)) continue;
    running.add(id);
    try {
      await eventService.reconcile(id);
      const pending = await prismaClient.eventSignup.findMany({
        where: { event: { guildId: id }, roleSyncPending: true },
        select: { id: true, discordUserId: true, updatedAt: true, roleSyncToken: true },
      });
      const byMember = new Map<string, typeof pending>();
      for (const signup of pending) {
        const rows = byMember.get(signup.discordUserId);
        if (rows) rows.push(signup);
        else byMember.set(signup.discordUserId, [signup]);
      }

      if (byMember.size) {
        const guild = await client.guilds.fetch(id);
        for (const [userId, rows] of byMember) {
          try {
            // Read authority after capturing pending versions, and again for
            // each distinct member. Never use a historical signup's status.
            const state = await prismaClient.eventGuildState.findUnique({
              where: { guildId: id },
              select: { currentEventId: true },
            });
            const confirmed = state?.currentEventId
              ? await prismaClient.eventSignup.findUnique({
                  where: {
                    eventId_discordUserId: {
                      eventId: state.currentEventId,
                      discordUserId: userId,
                    },
                  },
                  select: {
                    status: true,
                    event: { select: { guildId: true, state: true } },
                  },
                })
              : null;
            const desired =
              confirmed?.status === "CONFIRMED" &&
              confirmed.event.guildId === id &&
              confirmed.event.state !== "FINISHED";
            const member = await guild.members
              .fetch({ user: userId, force: true })
              .catch((error: unknown) => {
                if (discordCode(error) === 10007) return null;
                throw error;
              });
            if (member) {
              // Do not infer success from a potentially stale role cache.
              if (desired) await member.roles.add(roleId);
              else await member.roles.remove(roleId);
            }
            // Unknown Member is safe to acknowledge: joining again queues
            // restoration. A concurrent change queues a newer version which
            // must not be cleared, even when another historical row matches.
            await prismaClient.eventSignup.updateMany({
              where: {
                roleSyncPending: true,
                OR: rows.map(({ id, updatedAt, roleSyncToken }) => ({
                  id,
                  ...pendingVersion("roleSyncToken", roleSyncToken, updatedAt),
                })),
              },
              data: { roleSyncPending: false },
            });
          } catch {
            console.warn(
              `[events] Role sync pending guild=${id} member=${userId}`
            );
          }
        }
      }
      const notifications = await prismaClient.eventSignup.findMany({
        where: { event: { guildId: id }, promotionPending: true },
        select: {
          id: true,
          discordUserId: true,
          updatedAt: true,
          promotionToken: true,
        },
      });
      for (const signup of notifications) {
        const version = pendingVersion(
          "promotionToken", signup.promotionToken, signup.updatedAt
        );
        try {
          const user = await client.users.fetch(signup.discordUserId);
          // Fetching the Discord user may take time. Recheck the exact
          // promotion and event before sending, not the original snapshot.
          const current = await prismaClient.eventSignup.findFirst({
            where: {
              id: signup.id,
              promotionPending: true,
              ...version,
              status: "CONFIRMED",
              event: { guildId: id, state: { in: ["OPEN", "CLOSED"] } },
            },
            select: { event: { select: { title: true } } },
          });
          if (current) {
            await user.send({
              content: `You have been promoted from reserve to confirmed for ${current.event.title}. Use /sign view in the event sign-up channel to review your application.`,
              allowedMentions: { parse: [] },
            });
          }
        } catch (error) {
          // Disabled DMs/unknown users are terminal; transient failures
          // retain the pending notification for a later retry.
          if (![50007, 10013].includes(discordCode(error) as number)) {
            console.warn(`[events] Promotion notification pending guild=${id} signup=${signup.id}`);
            continue;
          }
        }
        // A successful DM followed by an ambiguous DB failure may still
        // duplicate delivery; Discord and MongoDB cannot commit atomically.
        await prismaClient.eventSignup.updateMany({
          where: { id: signup.id, promotionPending: true, ...version },
          data: { promotionPending: false, promotionNotifiedAt: new Date() },
        });
      }
    } catch {
      console.warn(`[events] Reconciliation pending guild=${id}`);
    } finally {
      running.delete(id);
    }
  }
}

export async function syncReturningEventMember(
  client: Client,
  guildId: string,
  userId: string
) {
  if (!ConfigManager.getConfig().roles.eventParticipantRole) return;
  await prismaClient.eventSignup.updateMany({
    where: { discordUserId: userId, event: { guildId } },
    data: { roleSyncPending: true, roleSyncToken: randomUUID() },
  });
  await syncEventDiscord(client, guildId);
}

export function startEventDiscordSync(client: Client) {
  if (started.has(client)) return;
  started.add(client);
  // Only the per-guild guard should block overlap. A slow guild must
  // not prevent a later tick from processing other guilds.
  void syncEventDiscord(client);
  const timer = setInterval(() => void syncEventDiscord(client), 60_000);
  timer.unref();
}
