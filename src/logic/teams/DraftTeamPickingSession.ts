import { ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";

export class RandomTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {}

  public async handleInteraction(interaction: ButtonInteraction) {}
}
