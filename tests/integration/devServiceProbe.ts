/**
 * Explicitly invoked dev-only connectivity probe.
 * Read-only Discord gateway/REST and MongoDB access; no commands, messages,
 * roles, game mutations, maintenance jobs, registrations or event handlers.
 */
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { PrismaClient } from "@prisma/client";
import { ConfigManager } from "../../src/ConfigManager";

function withDeadline<T>(value: Promise<T>, name: string, ms = 12000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    value,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function main() {
  const config = ConfigManager.getConfig();
  if (!config.dev.enabled || !config.dev.guildId) {
    throw new Error("Not explicitly configured for a dev guild; refusing live probe");
  }
  const outcomes: Record<string, string> = {};
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    if (!process.env.BOT_TOKEN) throw new Error("No Discord token available");
    await withDeadline(client.login(process.env.BOT_TOKEN), "Discord gateway login");
    outcomes.discordGateway = "connected";
    const guild = await withDeadline(client.guilds.fetch(config.dev.guildId), "Dev guild fetch");
    outcomes.devGuild = guild ? "accessible" : "unavailable";
    const channel = await withDeadline(client.channels.fetch(config.channels.announcements), "Dev announcement channel fetch");
    outcomes.announcementChannel = channel && "guildId" in channel && channel.guildId === config.dev.guildId
      ? "accessible" : "wrong guild or unavailable";
  } catch (error) {
    outcomes.discordError = error instanceof Error ? error.name + ": " + error.message : "unknown error";
  } finally {
    await withDeadline(Promise.resolve(client.destroy()), "Discord client destroy", 4000).catch(() => {});
  }

  const prisma = new PrismaClient();
  try {
    if (!process.env.DATABASE_URL) throw new Error("No database URL available");
    await withDeadline(prisma.$connect(), "Dev database connection");
    outcomes.database = "connected";
    await withDeadline(prisma.game.findFirst({ select: { id: true } }), "Dev database read");
    outcomes.databaseRead = "successful";
  } catch (error) {
    // Never print a connection string or raw Prisma error (may contain URLs).
    outcomes.databaseError = error instanceof Error ? error.name : "unknown error";
  } finally {
    await withDeadline(prisma.$disconnect(), "Dev database disconnect", 4000).catch(() => {});
  }
  console.log("DEV_SERVICE_PROBE_RESULTS", JSON.stringify(outcomes));
  if (outcomes.discordGateway !== "connected" || outcomes.devGuild !== "accessible" ||
      outcomes.announcementChannel !== "accessible" || outcomes.databaseRead !== "successful") {
    process.exitCode = 1;
  }
}
main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error("DEV_SERVICE_PROBE_FATAL", error instanceof Error ? error.name : "unknown failure");
    process.exit(1);
  }
);
