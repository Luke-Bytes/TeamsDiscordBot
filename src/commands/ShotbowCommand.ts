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
import { Command } from "./CommandInterface";

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

  constructor(private readonly api = new ShotbowStatusAPI()) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({});
    const status = await this.api.getStatus();
    await interaction.editReply({
      embeds: [buildShotbowEmbed(status)],
      allowedMentions: { parse: [] },
    });
  }
}
