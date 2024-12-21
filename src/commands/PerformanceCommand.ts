import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { prismaClient } from "../database/prismaClient";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

export default class PerformanceCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("performance")
    .setDescription("Displays bot performance statistics.");

  name = "performance";
  description = "Displays bot performance statistics.";
  buttonIds: string[] = [];

  formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const uptimeSeconds = process.uptime();
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const websocketPing =
      interaction.client.ws.ping !== -1
        ? `${interaction.client.ws.ping} ms`
        : "N/A (Not Connected)";

    const dbLatency = await pingDatabase();
    const gitBranch = await getGitBranch();

    const usageStats = `
**Uptime:** ${this.formatUptime(uptimeSeconds)}
**WebSocket Ping:** ${websocketPing}
**Database Latency:** ${dbLatency} ms
**Git Branch:** ${gitBranch}


**Memory Usage:**
- RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB
- Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
- Heap Total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB

**CPU Usage:**
- User: ${(cpuUsage.user / 1e6).toFixed(2)} ms
- System: ${(cpuUsage.system / 1e6).toFixed(2)} ms
`;
    await interaction.reply({ content: usageStats, ephemeral: false });
  }
}

async function pingDatabase() {
  const start = performance.now();
  try {
    await prismaClient.player.findFirst();
    const end = performance.now();
    return (end - start).toFixed(2);
  } catch (error) {
    console.error("Database ping failed:", error);
    return "Failed to connect";
  }
}

async function getGitBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD");
    return stdout.trim();
  } catch (error) {
    console.error("Failed to retrieve Git branch:", error);
    return "Unknown";
  }
}
