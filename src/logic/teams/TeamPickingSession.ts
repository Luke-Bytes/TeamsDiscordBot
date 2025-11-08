import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Message,
} from "discord.js";
import { PlayerInstance } from "../../database/PlayerInstance";

export type TeamPickingSessionState = "inProgress" | "cancelled" | "finalized";

export abstract class TeamPickingSession {
  public state: TeamPickingSessionState = "inProgress";
  public embedMessage?: Message<boolean>;
  public abstract getState(): TeamPickingSessionState;

  public abstract initialize(
    interaction: ChatInputCommandInteraction
  ): Promise<void>;
  public abstract handleInteraction(
    interaction: ButtonInteraction
  ): Promise<void>;
  public abstract handleMessage(message: Message<boolean>): Promise<void>;

  // Optional: draft sessions may accept late signups before late picking starts
  public registerLateSignup?(player: PlayerInstance): Promise<void> | void;
}
