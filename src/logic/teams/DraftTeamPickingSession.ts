import { ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { Channels } from "Channels";

export class DraftTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const teamPickingChannel = Channels.teamPicking;

    await interaction.reply({
      content: `Started a draft team picking session in <#${teamPickingChannel.id}>`,
      ephemeral: true,
    });
  }

  public async handleInteraction(interaction: ButtonInteraction) {}
}
