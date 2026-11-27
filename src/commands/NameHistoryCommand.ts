import {
  AttachmentBuilder, ChatInputCommandInteraction, InteractionContextType,
  MessageFlags, SlashCommandBuilder,
} from "discord.js";
import { MojangAPI } from "../api/MojangAPI";
import { MinecraftNameHistoryAPI } from "../api/MinecraftNameHistoryAPI";
import { Command } from "./CommandInterface";
import { buildNameHistoryPages } from "./NameHistoryPresentation";

export default class NameHistoryCommand implements Command {
  name = "name";
  description = "Look up visible Minecraft username history";
  buttonIds: string[] = [];
  private readonly cooldowns = new Map<string, number>();

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName("history")
      .setDescription("Look up previous names of a Minecraft account")
      .addStringOption((option) => option.setName("username")
        .setDescription("Current Minecraft username").setRequired(true).setMaxLength(16)));

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const privateReply = { flags: MessageFlags.Ephemeral as const, allowedMentions: { parse: [] as never[] } };
    if (!interaction.guildId && !interaction.guild?.id) {
      await interaction.reply({ ...privateReply, content: "Use this command in the server." });
      return;
    }
    if (interaction.options.getSubcommand() !== "history") return;
    const username = interaction.options.getString("username", true).trim();
    if (!MojangAPI.validateUsername(username)) {
      await interaction.reply({ ...privateReply, content: "Enter a valid Minecraft Java username (letters, numbers and underscores, up to 16 characters)." });
      return;
    }
    const now = Date.now();
    for (const [id, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(id);
    if (this.cooldowns.has(interaction.user.id) || this.cooldowns.size >= 1000) {
      await interaction.reply({ ...privateReply, content: "Please wait before requesting another history." });
      return;
    }
    this.cooldowns.set(interaction.user.id, now + 30_000);
    await interaction.deferReply({});
    try {
      const result = await MinecraftNameHistoryAPI.lookup(username, {
        guildId: interaction.guildId ?? interaction.guild?.id,
        includePlayerRecords: false,
      });
      if (result.status !== "found") {
        await interaction.editReply({
          content: result.status === "notFound" ? "No current Minecraft account found for that username." :
            result.status === "invalid" ? "Invalid Minecraft username." : "Minecraft identity could not be verified. Try again later.",
          allowedMentions: { parse: [] },
        });
        return;
      }
      const { pages, overflow } = buildNameHistoryPages(result);
      if (!pages.length) {
        await interaction.editReply({ content: "Minecraft identity could not be verified.", allowedMentions: { parse: [] } });
        return;
      }
      await interaction.editReply({
        embeds: [pages[0]],
        allowedMentions: { parse: [] },
        ...(overflow ? { files: [new AttachmentBuilder(overflow, { name: "name-history.txt" })] } : {}),
      });
      for (const page of pages.slice(1)) {
        await interaction.followUp({ allowedMentions: { parse: [] }, embeds: [page] });
      }
    } catch {
      await interaction.editReply({
        content: "Unable to complete the name history lookup. Historical records may be incomplete.",
        allowedMentions: { parse: [] },
      });
    }
  }
}
