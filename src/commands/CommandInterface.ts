import {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
  SlashCommandBuilder,
  ApplicationCommandOptionData,
  ContextMenuCommandBuilder,
  ButtonInteraction,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | ContextMenuCommandBuilder;
  name: string;
  description: string;
  buttonIds: string[]; //list of button IDs that the Command wants to listen to for handleButtonPress
  options?: ApplicationCommandOptionData[];
  execute(
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction
  ): Promise<void>; // Execute must handle all interaction types

  handleButtonPress?(interaction: ButtonInteraction): Promise<void>;
}
