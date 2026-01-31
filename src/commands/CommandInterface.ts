import {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
  SlashCommandBuilder,
  ApplicationCommandOptionData,
  ContextMenuCommandBuilder,
  ButtonInteraction,
  StringSelectMenuInteraction,
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
  selectMenuIds?: string[]; // list of select menu IDs for handleSelectMenu
  options?: ApplicationCommandOptionData[];
  execute(
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction
  ): Promise<void>; // Execute must handle all interaction types

  handleButtonPress?(interaction: ButtonInteraction): Promise<void>;
  handleSelectMenu?(interaction: StringSelectMenuInteraction): Promise<void>;
}
