import { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";

export abstract class TeamPickingSession {
  public abstract initialize(
    interaction: ChatInputCommandInteraction
  ): Promise<void>;
  public abstract handleInteraction(
    interaction: ButtonInteraction
  ): Promise<void>;
}
