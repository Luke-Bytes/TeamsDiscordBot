import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from "discord.js";
import {
  SHOTBOW_ADDRESS,
  ShotbowStatus,
  ShotbowStatusAPI,
} from "../api/ShotbowStatusAPI";
import {
  MinecraftServicesAPI,
  MinecraftServicesStatus,
  MonitorStatus,
  ProbeStatus,
} from "../api/MinecraftServicesAPI";
import { Command } from "./CommandInterface";

function serviceLine(
  name: string,
  monitor: MonitorStatus,
  probe?: ProbeStatus
): string {
  const label = `**${name}:**`;
  if (monitor === "definite" || monitor === "possible") {
    const indicator = monitor === "definite" ? "🔴" : "🟠";
    const report =
      monitor === "definite" ? "Issues reported" : "Possible issues";
    const direct =
      probe === "responding"
        ? " · endpoint responding"
        : probe === "error"
          ? " · endpoint error"
          : probe === "unknown"
            ? " · direct check unavailable"
            : "";
    return `${indicator} ${label} ${report}${direct}`;
  }
  if (probe === "error") return `🟠 ${label} Endpoint error`;
  if (monitor === "unknown") {
    return `🟠 ${label} ${probe === "responding" ? "Endpoint responding; monitor unavailable" : "Status unavailable"}`;
  }
  if (probe === "unknown") {
    return `🟠 ${label} No reported issues; direct check unavailable`;
  }
  return `🟢 ${label} No reported issues`;
}

export function addMinecraftServices(
  embed: EmbedBuilder,
  status: MinecraftServicesStatus
): EmbedBuilder {
  const lines = [
    serviceLine("Session authentication", status.session, status.sessionProbe),
    serviceLine("Xbox services", status.xbox),
    serviceLine("Minecraft API", status.minecraft, status.keysProbe),
  ];
  return embed
    .addFields({
      name: "Minecraft services",
      value: lines.join("\n"),
    })
    .setFooter({
      text: "MCPing reports and public endpoint checks; actual sign-in is not tested.",
    });
}

export function buildShotbowEmbed(status: ShotbowStatus): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle("Shotbow");
  const population = status.population;
  const breakdown = population?.modes.length
    ? "\n\n" +
      population.modes
        .map(
          ({ name, players }) =>
            `**${name}:** ${players.toLocaleString("en-GB")}`
        )
        .join("\n")
    : "";
  if (status.kind === "online") {
    const total = population?.total ?? status.online;
    const online = total.toLocaleString("en-GB");
    // Some Minecraft proxies advertise a placeholder capacity below the
    // connected player count. Do not display a misleading fraction.
    const players =
      status.max > 0 && status.max >= total
        ? `${online}/${status.max.toLocaleString("en-GB")}`
        : online;
    return embed
      .setColor(0x57f287)
      .setDescription(
        `🟢 Online\n\n**Players:** ${players}${breakdown}\n\n\`${SHOTBOW_ADDRESS}\``
      );
  }
  if (status.kind === "reported-online") {
    const warning =
      status.reachability === "offline"
        ? "⚠️ Login address unreachable in the server ping. There may be a connection or DNS issue."
        : "⚠️ Login address could not be verified. The status check may have failed.";
    return embed
      .setColor(0xfaa61a)
      .setDescription(
        `🟢 Online (reported by Shotbow)\n\n**Players:** ${status.population.total.toLocaleString("en-GB")}${breakdown}\n\n${warning}\n\n\`${SHOTBOW_ADDRESS}\``
      );
  }
  if (status.kind === "offline") {
    return embed
      .setColor(0xed4245)
      .setDescription("🔴 Offline\n\nThe server is currently unreachable.");
  }
  return embed
    .setColor(0xfaa61a)
    .setDescription(
      population
        ? `🟠 Status unavailable\n\n**Reported players:** ${population.total.toLocaleString("en-GB")}${breakdown}\n\nCouldn't verify server reachability.\n\n\`${SHOTBOW_ADDRESS}\``
        : "🟠 Status unavailable\n\nCouldn't check the server right now. Try again shortly."
    );
}

export default class ShotbowCommand implements Command {
  name = "shotbow";
  description = "Check Shotbow's server status and players in each game mode";
  buttonIds: string[] = [];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .setContexts(InteractionContextType.Guild);

  constructor(
    private readonly api = new ShotbowStatusAPI(),
    private readonly services = new MinecraftServicesAPI()
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({});
    const [status, services] = await Promise.all([
      this.api.getStatus(),
      this.services.getStatus(),
    ]);
    await interaction.editReply({
      embeds: [addMinecraftServices(buildShotbowEmbed(status), services)],
      allowedMentions: { parse: [] },
    });
  }
}
