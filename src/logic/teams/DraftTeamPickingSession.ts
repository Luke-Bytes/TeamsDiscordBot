import { ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession.js";
import { Channels } from "../../Channels.js";
import { CurrentGameManager } from "../../logic/CurrentGameManager.js";

export class DraftTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const teamPickingChannel = Channels.teamPicking;

    const redCaptain =
      CurrentGameManager.getCurrentGame().getCaptainOfTeam("RED");
    const blueCaptain =
      CurrentGameManager.getCurrentGame().getCaptainOfTeam("BLUE");

    if (!redCaptain && !blueCaptain) {
      await interaction.reply({
        content:
          "The teams do not have captains. Please use `/captain set` to set the captains of the teams.",
        ephemeral: true,
      });
    } else if (!redCaptain) {
      await interaction.reply({
        content:
          "Red team does not have a captain. Please use `/captain set` to set the captains of Red team.",
        ephemeral: true,
      });
    } else if (!blueCaptain) {
      await interaction.reply({
        content:
          "Blue team does not have a captain. Please use `/captain set` to set the captains of Blue team.",
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: `Started a draft team picking session in <#${teamPickingChannel.id}>`,
      ephemeral: true,
    });
  }

  public async handleInteraction(interaction: ButtonInteraction) {}
}
