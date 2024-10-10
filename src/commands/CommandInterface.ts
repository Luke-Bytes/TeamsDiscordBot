import {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
  SlashCommandBuilder,
  ApplicationCommandOptionData,
  ContextMenuCommandBuilder,
} from "discord.js";

export interface Command {
  data: SlashCommandBuilder | ContextMenuCommandBuilder;
  name: string;
  description: string;
  options?: ApplicationCommandOptionData[];
  execute(
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction
  ): Promise<void>; // Execute must handle all interaction types
}
