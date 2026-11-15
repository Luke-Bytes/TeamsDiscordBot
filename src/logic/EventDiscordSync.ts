import { Client } from "discord.js";
import { ConfigManager } from "../ConfigManager";
import { prismaClient } from "../database/prismaClient";
import { eventService } from "./EventService";

const running = new Set<string>();

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
      const guild = await client.guilds.fetch(id);
      const state = await prismaClient.eventGuildState.findUnique({
        where: { guildId: id },
      });
      const current = state?.currentEventId
        ? await prismaClient.standaloneEvent.findUnique({
            where: { id: state.currentEventId },
          })
        : null;
      const pending = await prismaClient.eventSignup.findMany({
        where: { event: { guildId: id }, roleSyncPending: true },
      });
      for (const signup of pending) {
        try {
          const confirmed =
            current && current.state !== "FINISHED"
              ? await prismaClient.eventSignup.findUnique({
                  where: {
                    eventId_discordUserId: {
                      eventId: current.id,
                      discordUserId: signup.discordUserId,
                    },
                  },
                })
              : null;
          const member = await guild.members
            .fetch(signup.discordUserId)
            .catch((error: unknown) => {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === 10007
              )
                return null;
              throw error;
            });
          if (member) {
            if (confirmed?.status === "CONFIRMED")
              await member.roles.add(roleId);
            else await member.roles.remove(roleId);
          }
          await eventService.markRoleSynced(signup.id, signup.updatedAt);
        } catch {
          console.warn(
            `[events] Role sync pending guild=${id} signup=${signup.id}`
          );
        }
      }
      const notifications = await prismaClient.eventSignup.findMany({
        where: { event: { guildId: id }, promotionPending: true },
        include: { event: true },
      });
      for (const signup of notifications) {
        if (
          signup.status === "CONFIRMED" &&
          signup.event.state !== "FINISHED"
        ) {
          try {
            const user = await client.users.fetch(signup.discordUserId);
            await user.send({
              content: `You have been promoted from reserve to confirmed for ${signup.event.title}. Use /sign view in the event sign-up channel to review your application.`,
              allowedMentions: { parse: [] },
            });
          } catch {
            // DMs are best effort: disabled DMs must never undo promotion.
          }
        }
        await prismaClient.eventSignup.updateMany({
          where: { id: signup.id, updatedAt: signup.updatedAt },
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

export function startEventDiscordSync(client: Client) {
  void syncEventDiscord(client);
  const timer = setInterval(() => void syncEventDiscord(client), 60_000);
  timer.unref();
}
