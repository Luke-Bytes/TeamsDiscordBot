import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { prismaClient } from "../database/prismaClient";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
const DIAGNOSTIC_TIMEOUT_MS = 5000;

// A deadline bounds the wait, not the underlying Prisma operation. Keep the
// rejection handler attached so a later failure cannot be unhandled.
async function boundedDiagnostic(operation: Promise<string>): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("Timed out"), DIAGNOSTIC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default class PerformanceCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("performance")
    .setDescription("Displays bot performance statistics.");

  name = "performance";
  description = "Displays bot performance statistics.";
  buttonIds: string[] = [];

  formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const dayPrefix = days > 0 ? `${days}d ` : "";

    return `${dayPrefix}${hours}h ${minutes}m ${secs}s`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply(); // Ensure interaction stays active

    const uptimeSeconds = process.uptime();
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const websocketPing =
      interaction.client.ws.ping !== -1
        ? `${interaction.client.ws.ping} ms`
        : "N/A (Not Connected)";

    const [dbLatency, mojangPing, gappleStatus, gitBranch] = await Promise.all([
      boundedDiagnostic(pingDatabase()),
      pingHttp("Mojang", "https://api.mojang.com/users/profiles/minecraft/Notch"),
      pingHttp("Gapple", "https://api.gapple.pw/status/"),
      getGitBranch(),
    ]);

    const usageStats = `
**Uptime:** ${this.formatUptime(uptimeSeconds)}
**WebSocket Ping:** ${websocketPing}
**Database Latency:** ${dbLatency}
**Mojang API Ping:** ${mojangPing}
**Gapple API Status:** ${gappleStatus}

**Git Branch:** ${gitBranch}

**Memory Usage:**
- RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB
- Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
- Heap Total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB

**CPU Usage:**
- User: ${(cpuUsage.user / 1000).toFixed(2)} ms
- System: ${(cpuUsage.system / 1000).toFixed(2)} ms
`;
    await interaction.editReply({ content: usageStats });
  }
}

async function pingDatabase() {
  const start = performance.now();
  try {
    await prismaClient.player.findFirst({ select: { id: true } });
    const end = performance.now();
    return `${(end - start).toFixed(2)} ms`;
  } catch (error) {
    console.error("Database ping failed:", error);
    return "Failed to connect";
  }
}

async function pingHttp(service: string, url: string): Promise<string> {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIAGNOSTIC_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const elapsed = (performance.now() - start).toFixed(2);
    // The check only needs headers. Release the unused response body.
    await response.body?.cancel().catch((error) => {
      console.warn(`Failed to release ${service} API response:`, error);
    });
    if (response.ok) return `${elapsed} ms`;
    console.warn(`${service} API returned status ${response.status}`);
    return `Error: ${response.status}`;
  } catch (error) {
    console.error(`Failed to connect to ${service} API:`, error);
    return "Failed to connect";
  } finally {
    clearTimeout(timeout);
  }
}

async function getGitBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { timeout: DIAGNOSTIC_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    console.error("Failed to retrieve Git branch:", error);
    return "Unknown";
  }
}
