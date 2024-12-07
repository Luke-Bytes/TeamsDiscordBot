import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Message,
} from "discord.js";

export type TeamPickingSessionState = "inProgress" | "cancelled" | "finalized";

export abstract class TeamPickingSession {
  public abstract getState(): TeamPickingSessionState;

  public abstract initialize(
    interaction: ChatInputCommandInteraction
  ): Promise<void>;
  public abstract handleInteraction(
    interaction: ButtonInteraction
  ): Promise<void>;
  public abstract handleMessage(message: Message<boolean>): Promise<void>;
}
