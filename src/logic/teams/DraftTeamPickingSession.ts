import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  Message,
} from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { Channels } from "../../Channels";
import { CurrentGameManager } from "../CurrentGameManager";
import { PlayerInstance } from "../../database/PlayerInstance";

export class DraftTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  redCaptain?: PlayerInstance;
  blueCaptain?: PlayerInstance;

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const teamPickingChannel = Channels.teamPicking;

    this.redCaptain =
      CurrentGameManager.getCurrentGame().getCaptainOfTeam("RED");
    this.blueCaptain =
      CurrentGameManager.getCurrentGame().getCaptainOfTeam("BLUE");

    if (!this.redCaptain && !this.blueCaptain) {
      await interaction.reply({
        content:
          "The teams do not have captains. Please use `/captain set` to set the captains of the teams.",
        ephemeral: true,
      });
      this.state = "cancelled";
      return;
    } else if (!this.redCaptain) {
      await interaction.reply({
        content:
          "Red team does not have a captain. Please use `/captain set` to set the captains of Red team.",
        ephemeral: true,
      });
      this.state = "cancelled";
      return;
    } else if (!this.blueCaptain) {
      await interaction.reply({
        content:
          "Blue team does not have a captain. Please use `/captain set` to set the captains of Blue team.",
        ephemeral: true,
      });
      this.state = "cancelled";
      return;
    }

    await interaction.reply({
      content: `Started a draft team picking session in <#${teamPickingChannel.id}>`,
      ephemeral: true,
    });

    if (teamPickingChannel.isSendable()) {
      await teamPickingChannel.send("Team picking");
    } else {
      console.error(
        "Can not send messages in the team picking channel! Maybe messed up permissions."
      );
    }
  }

  public async handleInteraction(interaction: ButtonInteraction) {}

  public async handleMessage(message: Message<boolean>) {
    if (message.channel.id !== Channels.teamPicking.id) return;

    if (!message.channel.isSendable()) {
      console.error(
        "Can not send messages in the team picking channel! Maybe messed up permissions."
      );
      return;
    }
  }
}
