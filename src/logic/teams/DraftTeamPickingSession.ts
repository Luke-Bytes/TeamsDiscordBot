import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { Channels } from "../../Channels";
import { CurrentGameManager } from "../CurrentGameManager";
import { PlayerInstance } from "../../database/PlayerInstance";
import { Team } from "@prisma/client";
import { ConfigManager } from "../../ConfigManager";

export class DraftTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";

  finishedPicking = false;

  proposedTeams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  redCaptain?: PlayerInstance;
  blueCaptain?: PlayerInstance;

  turn?: Team;

  embedMessage?: Message<boolean>;
  finalizeMessage?: Message<boolean>;

  public getState(): TeamPickingSessionState {
    return this.state;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const teamPickingChannel = Channels.teamPicking;
    const game = CurrentGameManager.getCurrentGame();

    this.proposedTeams.RED = [...game.teams.RED];
    this.proposedTeams.BLUE = [...game.teams.BLUE];
    this.proposedTeams.UNDECIDED = [...game.teams.UNDECIDED];
    this.redCaptain = game.getCaptainOfTeam("RED");
    this.blueCaptain = game.getCaptainOfTeam("BLUE");

    if (!this.redCaptain && !this.blueCaptain) {
      await interaction.editReply({
        content:
          "The teams do not have captains. Please use `/captain set` to set the captains of the teams.",
      });
      this.state = "cancelled";
      return;
    } else if (!this.redCaptain) {
      await interaction.editReply({
        content:
          "Red team does not have a captain. Please use `/captain set` to set the captains of Red team.",
      });
      this.state = "cancelled";
      return;
    } else if (!this.blueCaptain) {
      await interaction.editReply({
        content:
          "Blue team does not have a captain. Please use `/captain set` to set the captains of Blue team.",
      });
      this.state = "cancelled";
      return;
    }

    await interaction.editReply({
      content: `Started a draft team picking session in <#${teamPickingChannel.id}>`,
    });

    if (teamPickingChannel.isSendable()) {
      const embed = this.createDraftEmbed(false);
      this.embedMessage = await teamPickingChannel.send(embed);

      if (Math.random() === 5) {
        this.turn = "RED";
        await teamPickingChannel.send(
          "**Red** team has been randomly picked to select first."
        );
      } else {
        this.turn = "BLUE";
        await teamPickingChannel.send(
          "**Blue** team has been randomly picked to select first."
        );
      }
      await this.sendTurnMessage();
    } else {
      console.error(
        "Can not send messages in the team picking channel! Maybe messed up permissions."
      );
    }
  }

  private createDraftEmbed(finalized: boolean, finalizeFooter = true) {
    const redPlayers = this.proposedTeams.RED;
    const bluePlayers = this.proposedTeams.BLUE;
    const undecidedPlayers = this.proposedTeams.UNDECIDED;

    const getString = (players: PlayerInstance[]) => {
      const captain = players.filter((p) => p.captain)[0];
      const otherThanCaptain = players.filter((p) => !p.captain);
      if (captain) {
        return (
          `**${captain.ignUsed ?? "Unknown Player"}**\n` +
          players
            .filter((p) => !p.captain)
            .map((player) => player.ignUsed ?? "Unknown Player")
            .join("\n")
        );
      } else {
        return otherThanCaptain.length > 0
          ? otherThanCaptain
              .map((player) => player.ignUsed ?? "Unknown Player")
              .join("\n")
          : "No players";
      }
    };

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Randomised Teams")
      .addFields(
        {
          name: "🔵 Blue Team 🔵",
          value: getString(bluePlayers),
          inline: true,
        },
        {
          name: "🔴 Red Team 🔴",
          value: getString(redPlayers),
          inline: true,
        }
      );

    if (!finalized) {
      embed.addFields({
        name: "🟢 Up for Grabs 🟢",
        value: getString(undecidedPlayers),
        inline: true,
      });
    }

    if (finalized && finalizeFooter) {
      embed.setFooter({
        text: "Select an action below.",
      });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("draft-accept")
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("draft-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: finalized ? [row] : [] };
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const organiserRoleId = ConfigManager.getConfig().roles.organiserRole;
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const isOrganiser = member?.roles.cache.has(organiserRoleId);

    await interaction.update({});

    if (
      !isOrganiser ||
      !this.finishedPicking ||
      !interaction.channel?.isSendable()
    ) {
      return;
    }

    switch (interaction.customId) {
      case "draft-accept": {
        const embed = this.createDraftEmbed(true, false);
        await this.finalizeMessage?.edit({
          embeds: embed.embeds,
          components: [],
        });

        await interaction.channel.send("Teams have been finalized.");

        CurrentGameManager.getCurrentGame().teams = { ...this.proposedTeams };

        this.state = "finalized";
        break;
      }
      case "draft-cancel":
        await this.embedMessage?.delete();
        await interaction.channel.send("Draft picking cancelled.");
        this.state = "cancelled";
        break;
    }
  }

  private getTurnCaptain() {
    switch (this.turn) {
      case "RED":
        return this.redCaptain!;
      case "BLUE":
        return this.blueCaptain!;
    }
  }

  private async sendTurnMessage() {
    const teamPickingChannel = Channels.teamPicking;

    if (!teamPickingChannel.isSendable()) {
      console.error(
        "Could not send message in team picking channel. Maybe messed up permissions?"
      );
      return;
    }

    const currentCaptain = this.getTurnCaptain();

    if (!currentCaptain) {
      console.error("no current captain!");
      return;
    }

    await teamPickingChannel.send(
      `<@${currentCaptain.discordSnowflake}> It's your turn to choose! Please type an IGN or ping a player.`
    );
  }

  public async handleMessage(message: Message<boolean>) {
    if (message.channel.id !== Channels.teamPicking.id) return;

    if (!message.channel.isSendable()) {
      console.error(
        "Can not send messages in the team picking channel! Maybe messed up permissions."
      );
      return;
    }

    const user = message.author;

    if (this.getTurnCaptain()?.discordSnowflake !== user.id) return; //todo: maybe delete the message?

    const content = message.content;
    const firstMention = message.mentions.users.values().next().value;

    let player;

    if (firstMention) {
      player = this.proposedTeams.UNDECIDED.filter(
        (p) => p.discordSnowflake === firstMention.id
      )[0];
      if (!player) {
        await message.channel.send(
          "Could not recognize that ping. Maybe the player isn't registered?"
        );
        return;
      }
    } else {
      player = this.proposedTeams.UNDECIDED.filter(
        (p) => p.ignUsed === content
      )[0];
      if (!player) {
        await message.channel.send(
          "Could not recognize that IGN. Please try again."
        );
        return;
      }
    }

    this.proposedTeams[this.turn!].push(player);
    this.proposedTeams.UNDECIDED = this.proposedTeams.UNDECIDED.filter(
      (p) => p !== player
    );
    await message.channel.send(
      `Player ${player.ignUsed} registered for **${this.turn}** team.`
    );

    await this.embedMessage?.edit(this.createDraftEmbed(false));

    this.turn = this.turn === "RED" ? "BLUE" : "RED";

    if (this.proposedTeams.UNDECIDED.length === 0) {
      const embed = this.createDraftEmbed(true);
      this.finalizeMessage = await message.channel.send({
        content: "There are no players to draft. Here is the final draft.",
        ...embed,
      });

      this.finishedPicking = true;
    } else {
      await this.sendTurnMessage();
    }
  }
}
