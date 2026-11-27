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
  ProbeStatus,
} from "../api/MinecraftServicesAPI";
import { Command } from "./CommandInterface";

function serviceLine(name: string, probe: ProbeStatus): string {
  const label = `**${name}:**`;
  if (probe === "responding") return `🟢 ${label} Endpoint responding`;
  if (probe === "error") return `🟠 ${label} Endpoint error`;
  return `🟠 ${label} Check unavailable`;
}

export function addMinecraftServices(
  embed: EmbedBuilder,
  status: MinecraftServicesStatus
): EmbedBuilder {
  const lines = [
    serviceLine("Session verification", status.sessionProbe),
    serviceLine("Microsoft sign-in discovery", status.microsoftProbe),
    serviceLine("Minecraft public keys", status.keysProbe),
  ];
  return embed.addFields({
    name: "Minecraft services",
    value: lines.join("\n"),
  }).setFooter({ text: "Public endpoint checks only; actual sign-in and Xbox network health are not tested." });
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
        `🟢 Online · \`${SHOTBOW_ADDRESS}\`\n\n**Players:** ${players}${breakdown}`
      );
  }
  if (status.kind === "reported-online") {
    const warning =
      status.reachability === "offline"
        ? "⚠️ Login address unreachable from the status provider."
        : "⚠️ Login address could not be verified.";
    return embed
      .setColor(0xfaa61a)
      .setDescription(
        `🟢 Online (reported by Shotbow)\n\`${SHOTBOW_ADDRESS}\`\n\n**Players:** ${status.population.total.toLocaleString("en-GB")}${breakdown}\n\n${warning}`
      );
  }
  if (status.kind === "offline") {
    return embed
      .setColor(0xed4245)
      .setDescription(`🔴 Address unreachable from status provider · \`${SHOTBOW_ADDRESS}\``);
  }
  return embed
    .setColor(0xfaa61a)
    .setDescription(
      population
        ? `🟠 Status unavailable · \`${SHOTBOW_ADDRESS}\`\n\n**Reported players:** ${population.total.toLocaleString("en-GB")}${breakdown}`
        : `🟠 Status unavailable · \`${SHOTBOW_ADDRESS}\``
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
    const [shotbowResult, servicesResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.api.getStatus()),
      Promise.resolve().then(() => this.services.getStatus()),
    ]);
    const status: ShotbowStatus = shotbowResult.status === "fulfilled"
      ? shotbowResult.value : { kind: "unavailable" };
    const services: MinecraftServicesStatus = servicesResult.status === "fulfilled"
      ? servicesResult.value : { sessionProbe: "unknown", keysProbe: "unknown", microsoftProbe: "unknown" };
    if (shotbowResult.status === "rejected") console.warn("event=shotbow.check source=shotbow reason=unexpected-failure");
    if (servicesResult.status === "rejected") console.warn("event=shotbow.check source=minecraft-services reason=unexpected-failure");
    await interaction.editReply({
      embeds: [addMinecraftServices(buildShotbowEmbed(status), services)],
      allowedMentions: { parse: [] },
    });
  }
}
